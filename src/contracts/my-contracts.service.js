import { prisma } from '../lib/prisma.js';
import { CONTRACT_STATUS_LABELS, CONTRACT_TYPES } from './contract-status.js';

// Minhas contratações (HSP-PBI-046-TSK-01 #533): todas as do Tutor, de qualquer pet, prestador e status, da mais recente
// para a mais antiga. Pet e prestador vêm no mesmo findMany (select aninhado): o Prisma busca cada relação com um IN só,
// então são as mesmas poucas queries com 1 ou 50 itens na página (sem N+1).
export async function listMyContractsService(tutor, { page, pageSize }) {
    const where = { tutorId: tutor.id };
    const [reservations, total] = await prisma.$transaction([
        prisma.reservation.findMany({
            where,
            select: {
                id: true,
                status: true,
                startDate: true,
                endDate: true,
                totalValue: true,
                pet: { select: { id: true, petName: true } },
                service: { select: { provider: { select: { id: true, name: true, providerType: true } } } },
            },
            orderBy: [{ createdDate: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        prisma.reservation.count({ where }),
    ]);
    return { items: reservations.map(toItem), page, pageSize, total };
}

function toItem(reservation) {
    const { provider } = reservation.service;
    return {
        id: reservation.id,
        type: CONTRACT_TYPES[provider.providerType],
        status: reservation.status,
        statusLabel: CONTRACT_STATUS_LABELS[reservation.status],
        provider: { id: provider.id, name: provider.name },
        pet: { id: reservation.pet.id, name: reservation.pet.petName },
        // Só o dia, como na solicitação (#494)
        startDate: reservation.startDate.toISOString().slice(0, 10),
        endDate: reservation.endDate?.toISOString().slice(0, 10) ?? null,
        totalValue: Number(reservation.totalValue),
    };
}
