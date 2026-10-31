import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';
import { assertPetFree, assertVacancy } from './availability.js';

const DECISION_FIELDS = { id: true, status: true, decidedAt: true, rejectionReason: true };

// Reserva de outro Host responde igual à inexistente, para não revelar que ela existe
async function findOwnReservation(tx, hostId, id) {
    const reservation = await tx.reservation.findFirst({
        where: { id, service: { providerId: hostId } },
        select: { id: true, status: true, petId: true, startDate: true, endDate: true, tutor: { select: { userId: true } } },
    });
    if (!reservation) throw new AppError('Solicitação não encontrada', 404, 'NOT_FOUND');
    return reservation;
}

const alreadyDecided = () => new AppError('A solicitação já foi decidida', 409, 'RESERVATION_ALREADY_DECIDED');

// Muda o status só se ainda estiver pendente: com duas decisões ao mesmo tempo, o banco deixa só uma alterar a linha.
// shortcut: sem prazo de expiração (TBD na HSP-PBI-042); quando existir, entra aqui como mais uma condição do where.
async function decide(tx, id, data) {
    const { count } = await tx.reservation.updateMany({ where: { id, status: 'requested' }, data: { ...data, decidedAt: new Date() } });
    if (!count) throw alreadyDecided();
    return tx.reservation.findUnique({ where: { id }, select: DECISION_FIELDS });
}

// Aceite pelo Host (POST /api/v1/me/host/reservations/:id/accept, #491): vai para aguardando pagamento (HSP-DEC-004)
// se ainda houver vaga no período. Não conhece HTTP; o Host vem do req.user.
export function acceptHostReservationService(host, id) {
    return prisma.$transaction(async (tx) => {
        // Trava o Host: dois aceites dele andam em fila, e o segundo já conta a vaga ocupada pelo primeiro
        await tx.$queryRaw`SELECT id FROM providers WHERE id = ${host.id}::uuid FOR UPDATE`;

        const reservation = await findOwnReservation(tx, host.id, id);
        if (reservation.status !== 'requested') throw alreadyDecided();

        await assertVacancy(tx, host.id, reservation.startDate, reservation.endDate);
        // Trava o pet: dois Hosts aceitando o mesmo pet ao mesmo tempo andam em fila, e o segundo já vê o primeiro.
        // A ordem é sempre Host e depois pet, para não haver deadlock.
        await tx.$queryRaw`SELECT id FROM pets WHERE id = ${reservation.petId}::uuid FOR UPDATE`;
        await assertPetFree(tx, reservation.petId, reservation.startDate, reservation.endDate);

        return decide(tx, id, { status: 'awaiting_payment' });
    });
}

// Recusa pelo Host (POST /api/v1/me/host/reservations/:id/reject, #491): vai para rejected com o motivo e registra o evento
// de notificação ao Tutor na mesma transação. A entrega da notificação é da FT-026.
export function rejectHostReservationService(host, id, reason) {
    return prisma.$transaction(async (tx) => {
        const reservation = await findOwnReservation(tx, host.id, id);
        const decided = await decide(tx, id, { status: 'rejected', rejectionReason: reason });
        await tx.notification.create({
            data: {
                userId: reservation.tutor.userId,
                type: 'reservation_rejected',
                // JSON para a entrega (FT-026) montar o texto e o link da solicitação
                content: JSON.stringify({ reservationId: id, reason }),
            },
        });
        return decided;
    });
}
