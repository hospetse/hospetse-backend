import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';

const cpfTaken = { field: 'cpf', message: 'CPF já cadastrado' };

// Chamado pelo controller na validação, para o CPF duplicado sair junto com os outros erros. O próprio CPF do usuário não conta.
export async function isCpfTaken(cpf, userId) {
    const owner = await prisma.tutor.findUnique({ where: { cpf }, select: { userId: true } });
    return owner != null && owner.userId !== userId;
}

// Regra de negócio da conclusão do perfil (PUT /api/v1/me/tutor-profile). Não conhece HTTP: recebe dados já validados.
// address chega só com os campos do contrato (o controller filtra).
export async function completeTutorProfileService(user, { cpf, birthDate, phone, address, emergencyContact }) {
    const tutorData = {
        cpf,
        birthDate: new Date(birthDate),
        phone,
        emergencyContactName: emergencyContact.name,
        emergencyContactPhone: emergencyContact.phone,
    };

    try {
        // Tudo ou nada: endereço, Tutor e status do USER
        await prisma.$transaction(async (tx) => {
            // Lido dentro da transação para não decidir com o estado antigo do req.user
            const current = await tx.tutor.findUnique({ where: { userId: user.id }, select: { addressId: true } });
            const saved = current?.addressId
                ? await tx.address.update({ where: { id: current.addressId }, data: address })
                : await tx.address.create({ data: address });

            // Primeira vez cria o Tutor (o name vem do USER); nas seguintes, atualiza
            await tx.tutor.upsert({
                where: { userId: user.id },
                update: { ...tutorData, addressId: saved.id },
                create: { ...tutorData, addressId: saved.id, userId: user.id, name: user.name },
            });

            // profileCompletedAt guarda a primeira conclusão: um novo PUT não mexe
            await tx.user.update({
                where: { id: user.id },
                data: { profileStatus: 'complete', profileCompletedAt: user.profileCompletedAt ?? new Date() },
            });
        });
    } catch (error) {
        // P2002 no cpf = outro usuário gravou o mesmo CPF entre o isCpfTaken e o commit; o UNIQUE é a garantia final
        if (error.code === 'P2002' && String(error.meta?.target).includes('cpf')) {
            throw new AppError('Payload inválido', 400, 'VALIDATION_ERROR', [cpfTaken]);
        }
        throw error;
    }
}
