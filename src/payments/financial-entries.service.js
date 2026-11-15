import { AppError } from '../lib/app-error.js';
import { prisma } from '../lib/prisma.js';

// Lançamentos financeiros (tabela financial_entries): o livro-razão (ledger) do Hospetse. Só inserção, garantida por trigger no banco.
const REASON_MAX = 500;

// Lançamento do pagamento decidido (#528), dentro da transação do webhook. Um único por transação: se já existe
// (webhook repetido), o índice parcial financial_entries_payment_once_idx descarta o segundo sem erro
export function recordPaymentEntry(tx, transaction) {
    return tx.financialEntry.createMany({
        data: {
            transactionId: transaction.id,
            reservationId: transaction.reservationId,
            tutorId: transaction.reservation.tutorId,
            providerId: transaction.reservation.service.providerId,
            type: 'payment',
            amount: transaction.value,
            status: transaction.status,
        },
        skipDuplicates: true,
    });
}

// Correção (RF-PAG-09): novo lançamento ligado ao original, que nunca é alterado. Sem rota HTTP na Sprint 8.
// amount é a diferença em reais (negativa para reduzir), com até 2 casas
export async function recordCorrectionService(originalEntryId, { amount, reason }) {
    const details = [];
    // Até 2 casas: em centavos, o valor é inteiro (a folga cobre o erro de ponto flutuante, como 0.1 * 100)
    const hasTwoDecimals = Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0 || !hasTwoDecimals) {
        details.push({ field: 'amount', message: 'número diferente de zero, com até 2 casas decimais' });
    }
    if (typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > REASON_MAX) {
        details.push({ field: 'reason', message: `texto de 1 a ${REASON_MAX} caracteres` });
    }
    if (details.length) throw new AppError('Parâmetros inválidos', 400, 'VALIDATION_ERROR', details);

    const original = await prisma.financialEntry.findUnique({ where: { id: originalEntryId } });
    if (!original) throw new AppError('Lançamento não encontrado', 404, 'NOT_FOUND');

    return prisma.financialEntry.create({
        data: {
            transactionId: original.transactionId,
            reservationId: original.reservationId,
            tutorId: original.tutorId,
            providerId: original.providerId,
            type: 'correction',
            amount,
            status: 'approved',
            originalEntryId: original.id,
            reason: reason.trim(),
        },
    });
}
