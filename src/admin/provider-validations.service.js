import { AppError } from '../lib/app-error.js';
import { prisma } from '../lib/prisma.js';

// Fila de validação (#398): só cadastros pending, do envio mais antigo para o mais novo. Sem arquivo nenhum, só as contagens.
export async function listPendingProvidersService({ providerType, page, pageSize }) {
    const where = { validationStatus: 'pending', providerType };
    const [items, total] = await prisma.$transaction([
        prisma.provider.findMany({
            where,
            select: {
                id: true,
                providerType: true,
                name: true,
                submittedAt: true,
                _count: { select: { documents: true, photos: true } },
            },
            // Pendente sem data de envio (criado fora da submissão) fica no fim: no Postgres, NULL vem por último no asc
            orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        prisma.provider.count({ where }),
    ]);
    return { items, page, pageSize, total };
}

// Detalhe para a análise (#398). Aprovado, rejeitado e rascunho respondem como inexistente, para não revelar que existem.
export async function findPendingProviderService(id) {
    const provider = await prisma.provider.findFirst({
        where: { id, validationStatus: 'pending' },
        include: {
            documents: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
            photos: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
            hotelDetail: { select: { capacity: true } },
            address: true,
        },
    });
    if (!provider) throw new AppError('Cadastro não encontrado', 404, 'NOT_FOUND');
    return provider;
}

const DECISION_FIELDS = { id: true, validationStatus: true, validationDecidedAt: true, rejectionReason: true };

// Aprovação ou reprovação (#404), uma única vez. O autor vem do req.user (Administrador).
// Decisão, autor, data, motivo e o evento para o prestador (entrega pela HSP-PBI-064) vão na mesma transação.
function decide(admin, id, validationStatus, rejectionReason = null) {
    return prisma.$transaction(async (tx) => {
        // Rascunho não foi enviado: responde como inexistente
        const provider = await tx.provider.findFirst({ where: { id, validationStatus: { not: 'draft' } }, select: { userId: true } });
        if (!provider) throw new AppError('Cadastro não encontrado', 404, 'NOT_FOUND');

        // Filtrar por pending deixa só uma de duas decisões simultâneas alterar a linha
        const { count } = await tx.provider.updateMany({
            where: { id, validationStatus: 'pending' },
            data: { validationStatus, rejectionReason, validationDecidedAt: new Date(), validationDecidedById: admin.id },
        });
        if (!count) throw new AppError('O cadastro já foi decidido', 409, 'PROVIDER_ALREADY_DECIDED');

        await tx.notification.create({
            data: {
                userId: provider.userId,
                type: `provider_validation_${validationStatus}`,
                // JSON para a entrega (HSP-PBI-064) montar o texto
                content: JSON.stringify({ providerId: id, rejectionReason }),
            },
        });
        return tx.provider.findUnique({ where: { id }, select: DECISION_FIELDS });
    });
}

export const approveProviderService = (admin, id) => decide(admin, id, 'approved');
export const rejectProviderService = (admin, id, reason) => decide(admin, id, 'rejected', reason);
