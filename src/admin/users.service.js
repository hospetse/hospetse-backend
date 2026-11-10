import { AppError } from '../lib/app-error.js';
import { prisma } from '../lib/prisma.js';

const CONTRACTS_LIMIT = 20;
const ROLE_WHERE = {
    tutor: { tutor: { isNot: null } },
    provider: { provider: { isNot: null } },
    admin: { accountType: 'admin' },
};

// Consulta de usuários para o Administrador (#580): do cadastro mais novo para o mais antigo. Os filtros se somam.
export async function listUsersService({ q, role, status, page, pageSize }) {
    // O contains vira LIKE e não escapa os curingas: sem isso, o "_" de um e-mail casaria com qualquer caractere
    const contains = q?.replace(/[\\%_]/g, '\\$&');
    const where = {
        status,
        ...ROLE_WHERE[role],
        ...(q && { OR: [{ name: { contains, mode: 'insensitive' } }, { email: { contains, mode: 'insensitive' } }] }),
    };
    const [items, total] = await prisma.$transaction([
        prisma.user.findMany({
            where,
            select: {
                id: true,
                name: true,
                email: true,
                accountType: true,
                status: true,
                createdAt: true,
                tutor: { select: { id: true } },
                provider: { select: { id: true } },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        prisma.user.count({ where }),
    ]);
    return { items, page, pageSize, total };
}

// Detalhe de um usuário (#580). Do banco só sai o que a resposta usa: endereço, nascimento e contato de emergência nem são lidos.
export async function findUserService(id) {
    const user = await prisma.user.findUnique({
        where: { id },
        select: {
            id: true,
            name: true,
            email: true,
            accountType: true,
            status: true,
            profileStatus: true,
            createdAt: true,
            tutor: { select: { id: true, cpf: true, phone: true } },
            provider: { select: { id: true, providerType: true, validationStatus: true, cpfCnpj: true } },
            // [assunção] sem paginação no detalhe: as penalidades saem todas
            penalties: {
                select: { id: true, type: true, reason: true, createdAt: true },
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            },
        },
    });
    if (!user) throw new AppError('Usuário não encontrado', 404, 'NOT_FOUND');

    // Contratações dos dois lados: as que o usuário pediu como Tutor e as que recebeu nos serviços dele como prestador
    const sides = [
        user.tutor && { tutorId: user.tutor.id },
        user.provider && { service: { providerId: user.provider.id } },
    ].filter(Boolean);
    // shortcut: contratação é a reserva de hospedagem, o único tipo que existe hoje; incluir os outros quando forem criados
    const contracts = sides.length === 0 ? [] : await prisma.reservation.findMany({
        where: { OR: sides },
        select: { id: true, tutorId: true, status: true, startDate: true, totalValue: true },
        orderBy: [{ createdDate: 'desc' }, { id: 'asc' }],
        take: CONTRACTS_LIMIT,
    });
    return { ...user, contracts };
}
