import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';

// Regra de negócio do provisionamento. Não conhece HTTP: recebe dados já validados e devolve o USER ou lança AppError.
export async function provisionUserService({ authUserId, email, name }) {
    // Idempotência: o authUserId decide se é criação ou repetição
    const existing = await prisma.user.findUnique({ where: { authUserId } });
    if (existing) {
        if (existing.email !== email) {
            throw new AppError('Identidade já vinculada a outro e-mail', 409, 'AUTH_USER_ID_CONFLICT');
        }
        return { user: existing, created: false };
    }

    // Criação: os UNIQUE do banco são a garantia final contra corrida
    try {
        const user = await prisma.user.create({ data: { authUserId, email, name } });
        return { user, created: true };
    } catch (error) {
        if (error.code !== 'P2002') throw error;
        // P2002 = violação de UNIQUE: outra chamada igual venceu a corrida, ou o e-mail é de outro USER
        const winner = await prisma.user.findUnique({ where: { authUserId } });
        if (winner?.email === email) {
            return { user: winner, created: false };
        }
        throw new AppError('E-mail já cadastrado', 409, 'EMAIL_ALREADY_IN_USE');
    }
}
