import { prisma } from '../lib/prisma.js';
import { recordPaymentEntry } from './financial-entries.service.js';
import { notify } from '../notifications/notification.service.js';

// Eventos do Stripe tratados na Sprint 8 e o status que levam à transação. Os outros são registrados e ignorados
const HANDLED = { 'payment_intent.succeeded': 'approved', 'payment_intent.payment_failed': 'rejected' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Retorno do gateway (HSP-PBI-073-TSK-02 #528). O evento já chega com a assinatura conferida. Tudo numa transação de banco.
// Cada efeito é idempotente por conta própria, porque a resposta do Stripe à #527 pode ter decidido a transação antes do webhook:
// mesmo assim o lançamento é gravado e a contratação confirmada aqui, uma única vez. Devolve o que aconteceu, para log e testes.
export function handlePaymentEventService(event) {
    return prisma.$transaction(async (tx) => {
        // 1. Aviso repetido: o Stripe reenvia o mesmo evt_. A PK descarta sem erro, e nada mais acontece
        const { count: isNew } = await tx.paymentEvent.createMany({ data: { id: event.id, type: event.type }, skipDuplicates: true });
        if (!isNew) return 'duplicate';

        const status = HANDLED[event.type];
        if (!status) return 'ignored';

        // 2. A transação, pelo id do PaymentIntent ou pelo transactionId que a #527 mandou no metadata
        const intent = event.data.object;
        const transactionId = UUID.test(intent.metadata?.transactionId ?? '') ? intent.metadata.transactionId : undefined;
        const found = await tx.paymentTransaction.findFirst({
            where: { OR: [{ gatewayPaymentId: intent.id }, ...(transactionId ? [{ id: transactionId }] : [])] },
            select: { id: true },
        });
        // Pagamento que não é nosso (ex.: stripe trigger no terminal): fica só o registro do evento
        if (!found) return 'unknown';

        // 3. Decide só se ainda estiver pendente. Se a resposta da #527 já decidiu, vale o que está gravado
        await tx.paymentTransaction.updateMany({
            where: { id: found.id, status: 'pending' },
            data: { status, gatewayPaymentId: intent.id, failureCode: status === 'rejected' ? intent.last_payment_error?.code ?? null : null },
        });
        const transaction = await tx.paymentTransaction.findUnique({
            where: { id: found.id },
            include: { reservation: { select: { tutorId: true, tutor: { select: { userId: true } }, service: { select: { providerId: true, provider: { select: { userId: true } } } } } } },
        });
        if (transaction.status === 'pending') return 'pending';

        // 4. Lançamento imutável, um por transação
        await recordPaymentEntry(tx, transaction);
        if (transaction.status !== 'approved') return 'rejected';

        // 5. Confirma a contratação e avisa o prestador e o Tutor uma única vez: só quem tira a contratação de awaiting_payment notifica.
        // Contratação que já saiu de awaiting_payment (cancelada, por exemplo) fica como está, com o pagamento registrado
        // shortcut: pagamento aprovado de contratação que não aguarda mais pagamento não gera estorno; tratar com o estorno (HPET28)
        const { count: confirmed } = await tx.reservation.updateMany({
            where: { id: transaction.reservationId, status: 'awaiting_payment' },
            data: { status: 'accepted' },
        });
        if (confirmed) {
            await notify(tx, {
                type: 'payment_approved',
                // A mesma chave para os dois: o UNIQUE é por destinatário
                recipients: [transaction.reservation.service.provider.userId, transaction.reservation.tutor.userId],
                eventKey: `payment_approved:${transaction.id}`,
                reference: { type: 'contract', id: transaction.reservationId },
                // JSON para a entrega (FT-026) montar o texto e o link, no mesmo padrão de reservation_rejected
                data: { reservationId: transaction.reservationId, transactionId: transaction.id },
            });
        }
        return 'approved';
    });
}
