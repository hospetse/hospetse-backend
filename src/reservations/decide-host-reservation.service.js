import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';
import { assertNotBlocked, assertPetFree, assertVacancy } from './availability.js';

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

export function checkOutHostReservationService(host, id) {
    return prisma.$transaction(async (tx) => {
        const reservation = await tx.reservation.findFirst({
            where: { id, service: { providerId: host.id } },
            select: { status: true, tutorId: true, totalValue: true, platformFeeAmount: true, tutor: { select: { userId: true } } },
        });
        if (!reservation) throw new AppError('Solicitação não encontrada', 404, 'NOT_FOUND');
        const notInProgress = new AppError('Apenas hospedagens em andamento podem receber check-out', 409, 'RESERVATION_NOT_IN_PROGRESS');
        if (reservation.status !== 'checked_in') throw notInProgress;
        if (reservation.platformFeeAmount === null) {
            throw new AppError('A taxa da plataforma não foi registrada na solicitação', 409, 'PLATFORM_FEE_UNAVAILABLE');
        }

        const payment = await tx.paymentTransaction.findFirst({
            where: { reservationId: id, type: 'payment', status: 'approved', value: reservation.totalValue },
            select: { id: true },
        });
        if (!payment) throw new AppError('A hospedagem precisa de um pagamento aprovado pelo valor da contratação', 409, 'APPROVED_PAYMENT_REQUIRED');

        const checkedOutAt = new Date();
        const status = 'completed';
        const { count } = await tx.reservation.updateMany({
            where: { id, status: 'checked_in', service: { providerId: host.id } },
            data: { status, checkedOutAt },
        });
        if (!count) throw notInProgress;

        await tx.financialEntry.create({ data: {
            transactionId: payment.id, reservationId: id, tutorId: reservation.tutorId, providerId: host.id,
            type: 'host_net', amount: reservation.totalValue.minus(reservation.platformFeeAmount), status: 'approved',
        } });
        await tx.notification.create({ data: {
            userId: reservation.tutor.userId, type: 'reservation_checked_out', content: JSON.stringify({ reservationId: id }),
        } });
        return { id, status, checkedOutAt };
    });
}

const alreadyDecided = () => new AppError('A solicitação já foi decidida', 409, 'RESERVATION_ALREADY_DECIDED');

export function checkInHostReservationService(host, id) {
    return prisma.$transaction(async (tx) => {
        const reservation = await findOwnReservation(tx, host.id, id);
        const notConfirmed = new AppError('Apenas reservas confirmadas podem receber check-in', 409, 'RESERVATION_NOT_CONFIRMED');
        if (reservation.status !== 'accepted') throw notConfirmed;

        const checkedInAt = new Date();
        const today = new Date(checkedInAt.toISOString().slice(0, 10));
        if (reservation.startDate > today) {
            throw new AppError('O check-in só pode ser registrado a partir da data de início', 409, 'CHECK_IN_TOO_EARLY');
        }

        const status = 'checked_in';
        const { count } = await tx.reservation.updateMany({
            where: { id, status: 'accepted', service: { providerId: host.id }, startDate: { lte: today } },
            data: { status, checkedInAt },
        });
        if (!count) throw notConfirmed;

        await tx.notification.create({
            data: {
                userId: reservation.tutor.userId,
                type: 'reservation_checked_in',
                content: JSON.stringify({ reservationId: id }),
            },
        });
        return { id, status, checkedInAt };
    });
}

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

        // Bloqueio feito depois da solicitação também impede o aceite (#482). A trava do Host acima põe aceite e bloqueio em fila
        await assertNotBlocked(tx, host.id, reservation.startDate, reservation.endDate);
        await assertVacancy(tx, host.id, reservation.startDate, reservation.endDate);
        // Trava o pet: dois Hosts aceitando o mesmo pet ao mesmo tempo andam em fila, e o segundo já vê o primeiro.
        // A ordem é sempre Host e depois pet, para não haver deadlock.
        await tx.$queryRaw`SELECT id FROM pets WHERE id = ${reservation.petId}::uuid FOR UPDATE`;
        await assertPetFree(tx, reservation.petId, reservation.startDate, reservation.endDate);

        return decide(tx, id, { status: 'awaiting_payment' });
    // Quem espera a trava do Host conta esse tempo no timeout; os 5 s padrão não cobrem dois aceites seguidos com a latência do Railway
    }, { timeout: 15000 });
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
