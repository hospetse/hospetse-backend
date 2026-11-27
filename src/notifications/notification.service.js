// Notificações dos eventos da jornada (HSP-PBI-064-TSK-01 #554). O produtor chama o notify dentro da transação do próprio
// evento: o evento e a notificação existem juntos ou nenhum. Quem lê é a lista do usuário (#555); push fica fora da Sprint 8.

// Tipos gravados em notifications.type. Os sem produtor ainda esperam a task dele: reservation_checked_out (#545),
// service_started e service_finished (visita e passeio, #570). Visita e passeio solicitados ou decididos (#564, #567)
// reusam reservation_requested, reservation_accepted e reservation_rejected.
export const NOTIFICATION_TYPES = [
    'reservation_requested',
    'reservation_accepted',
    'reservation_rejected',
    'payment_approved',
    'reservation_checked_in',
    'reservation_checked_out',
    'service_started',
    'service_finished',
    'provider_validation_approved',
    'provider_validation_rejected',
    'new_message',
];

// A tela que a notificação abre no App (#555)
export const REFERENCE_TYPES = ['contract', 'conversation', 'provider_validation'];

// Uma notificação por destinatário. eventKey identifica o evento (ex.: reservation_rejected:<reservationId>): reprocessar
// o mesmo evento bate no UNIQUE (user_id, event_key) e o skipDuplicates (ON CONFLICT DO NOTHING) ignora sem abortar a transação.
// data vai para o content: só ids e o mínimo para a tela (LGPD), nunca nome, e-mail, CPF ou texto de mensagem.
export function notify(tx, { type, recipients, eventKey, reference, data }) {
    if (!NOTIFICATION_TYPES.includes(type)) throw new Error(`tipo de notificação desconhecido: ${type}`);
    if (!REFERENCE_TYPES.includes(reference.type)) throw new Error(`tipo de referência desconhecido: ${reference.type}`);
    const content = JSON.stringify(data);
    return tx.notification.createMany({
        data: recipients.map((userId) => ({
            userId, type, eventKey, referenceType: reference.type, referenceId: reference.id, content,
        })),
        skipDuplicates: true,
    });
}
