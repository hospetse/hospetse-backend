import { prisma } from '../lib/prisma.js';

// Do Tutor só o nome de exibição (LGPD); do pet, o que o Host precisa para decidir e cuidar.
const HOST_RESERVATION_FIELDS = {
    id: true,
    status: true,
    serviceId: true,
    startDate: true,
    endDate: true,
    dailyPrice: true,
    totalValue: true,
    notes: true,
    createdDate: true,
    tutor: { select: { name: true } },
    pet: { select: { petName: true, petSpecies: true, petSize: true, petBreed: true, medicalNotes: true, behavioralNotes: true } },
};

// Solicitações recebidas pelo Host (GET /api/v1/me/host/reservations, #485). Não conhece HTTP; o Host vem do req.user.
// O filtro pelos serviços do próprio Host é o que impede um Host de ver as solicitações de outro.
export async function listHostReservationsService(hostId, { status, page, pageSize }) {
    const where = { status, service: { providerId: hostId } };
    const [items, total] = await prisma.$transaction([
        // A mais antiga primeiro: quem pediu antes é respondido antes
        prisma.reservation.findMany({
            where,
            select: HOST_RESERVATION_FIELDS,
            orderBy: [{ createdDate: 'asc' }, { id: 'asc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        prisma.reservation.count({ where }),
    ]);
    return { items, page, pageSize, total };
}
