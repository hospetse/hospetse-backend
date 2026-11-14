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
