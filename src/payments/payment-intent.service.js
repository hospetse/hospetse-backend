import { AppError } from '../lib/app-error.js';
import { prisma } from '../lib/prisma.js';
import { getPaymentGateway } from './payment-gateway.js';

const FIELDS = { id: true, reservationId: true, status: true, value: true, failureCode: true, gatewayPaymentId: true, createdDate: true };
// Tamanho da coluna idempotency_key. Exportado para a validação da rota de pagar (#530) usar o mesmo limite
export const IDEMPOTENCY_KEY_MAX = 100;

// Intenção de pagamento idempotente (HSP-PBI-073-TSK-01 #527, ADR-016). Quem chama (#530) já conferiu o Tutor e o status da contratação.
// Mesma contratação e mesma chave = mesma tentativa: o resultado é reaproveitado e o gateway não cobra de novo.
export async function createPaymentIntentService({ reservation, paymentMethodToken, idempotencyKey }) {
    // A chave vem do cliente: vazia ou maior que a coluna viraria erro 500 no Prisma
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '' || idempotencyKey.length > IDEMPOTENCY_KEY_MAX) {
        throw new AppError('Parâmetros inválidos', 400, 'VALIDATION_ERROR', [
            { field: 'idempotencyKey', message: `texto de 1 a ${IDEMPOTENCY_KEY_MAX} caracteres` },
        ]);
    }
    let transaction = await findAttempt(reservation.id, idempotencyKey) ?? await createAttempt(reservation, idempotencyKey);

    // Tentativa já decidida (aprovada ou recusada): devolve sem chamar o gateway
    if (transaction.status !== 'pending') return transaction;

    // Nova ou pendente (timeout anterior): chama o gateway. A chave enviada ao Stripe é o id da transação:
    // é a mesma em todo reenvio e única na conta do Stripe, mesmo que duas contratações usem a mesma chave do App
    const result = await getPaymentGateway().createPayment({
        amountCents: transaction.value.mul(100).toNumber(),
        currency: 'brl',
        paymentMethodToken,
        idempotencyKey: transaction.id,
        metadata: { reservationId: reservation.id, transactionId: transaction.id },
    });

    // Só sai de pending: se o webhook (#528) já decidiu, o count é 0 e o resultado dele vale
    await prisma.paymentTransaction.updateMany({
        where: { id: transaction.id, status: 'pending' },
        data: { status: result.status, gatewayPaymentId: result.gatewayId, failureCode: result.failureCode },
    });
    transaction = await prisma.paymentTransaction.findUnique({ where: { id: transaction.id }, select: FIELDS });
    return transaction;
}

function findAttempt(reservationId, idempotencyKey) {
    return prisma.paymentTransaction.findUnique({
        where: { reservationId_idempotencyKey: { reservationId, idempotencyKey } },
        select: FIELDS,
    });
}

// O valor é o snapshot da contratação (totalValue), nunca um valor vindo do App
async function createAttempt(reservation, idempotencyKey) {
    try {
        return await prisma.paymentTransaction.create({
            data: { reservationId: reservation.id, type: 'payment', status: 'pending', value: reservation.totalValue, idempotencyKey },
            select: FIELDS,
        });
    } catch (error) {
        if (error.code !== 'P2002') throw error;
        // Corrida com a mesma chave: a outra requisição criou primeiro, e a tentativa dela vale para as duas
        const attempt = await findAttempt(reservation.id, idempotencyKey);
        if (attempt) return attempt;
        // Chave diferente, mas já existe pagamento pendente ou aprovado (índice parcial da migration #527).
        // Aprovado: a contratação já está paga. Pendente: o App espera o resultado da tentativa em andamento
        const active = await prisma.paymentTransaction.findFirst({
            where: { reservationId: reservation.id, type: 'payment', status: { in: ['pending', 'approved'] } },
            select: { status: true },
        });
        if (active?.status === 'approved') throw new AppError('Esta contratação já foi paga', 409, 'RESERVATION_NOT_PAYABLE');
        throw new AppError('Já existe um pagamento em andamento para esta contratação', 409, 'PAYMENT_IN_PROGRESS');
    }
}
