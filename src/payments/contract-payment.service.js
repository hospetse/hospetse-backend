import { AppError } from '../lib/app-error.js';
import { prisma } from '../lib/prisma.js';
import { createPaymentIntentService } from './payment-intent.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSACTION_FIELDS = { id: true, status: true, value: true, failureCode: true, createdDate: true };

// Id inválido, inexistente ou de outro Tutor: a mesma resposta, para não revelar que a contratação existe
async function findOwnReservation(tutor, reservationId) {
    const reservation = UUID.test(reservationId)
        ? await prisma.reservation.findFirst({ where: { id: reservationId, tutorId: tutor.id }, select: { id: true, status: true, totalValue: true } })
        : null;
    if (!reservation) throw new AppError('Contratação não encontrada', 404, 'NOT_FOUND');
    return reservation;
}

// O Tutor paga uma contratação aceita pelo prestador (HSP-PBI-067-TSK-01 #530). A cobrança é da #527; aqui só a regra de acesso.
// A confirmação da contratação chega depois, pelo webhook (#528).
export async function payContractService(tutor, reservationId, { idempotencyKey, paymentMethodToken }) {
    const reservation = await findOwnReservation(tutor, reservationId);

    // O reenvio da mesma tentativa devolve o resultado dela, mesmo que a contratação já tenha sido confirmada.
    // Tentativa nova só em awaiting_payment (RN-01: paga depois do aceite), sem chamar o gateway
    const sameAttempt = await prisma.paymentTransaction.findUnique({
        where: { reservationId_idempotencyKey: { reservationId: reservation.id, idempotencyKey } },
        select: { id: true },
    });
    if (!sameAttempt && reservation.status !== 'awaiting_payment') {
        throw new AppError('Esta contratação não está aguardando pagamento', 409, 'RESERVATION_NOT_PAYABLE');
    }

    // O valor é o snapshot da contratação (totalValue), nunca um valor vindo do App.
    // Mesma chave com outro token: vale a tentativa original, e o token novo é ignorado (a chave identifica a tentativa)
    const transaction = await createPaymentIntentService({ reservation, paymentMethodToken, idempotencyKey });

    // O webhook pode ter confirmado a contratação durante a cobrança: devolve o status atual
    const { status: reservationStatus } = await prisma.reservation.findUnique({ where: { id: reservation.id }, select: { status: true } });
    return { transaction, reservationStatus };
}

// Comprovante do pagamento (#530): a tentativa mais recente da contratação, com o status atual da contratação.
// O App consulta depois do 202 até a tentativa sair de pending e o webhook confirmar a contratação (#531).
// [assunção] O comprovante é a própria tentativa, referenciada pelo transactionId; o extrato do Tutor é o HSP-PBI-070
export async function getContractPaymentService(tutor, reservationId) {
    const reservation = await findOwnReservation(tutor, reservationId);
    const transaction = await prisma.paymentTransaction.findFirst({
        where: { reservationId: reservation.id, type: 'payment' },
        select: TRANSACTION_FIELDS,
        orderBy: [{ createdDate: 'desc' }, { id: 'asc' }],
    });
    if (!transaction) throw new AppError('Nenhum pagamento para esta contratação', 404, 'NOT_FOUND');
    return { transaction, reservationStatus: reservation.status };
}
