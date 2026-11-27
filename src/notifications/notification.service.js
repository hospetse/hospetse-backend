import { prisma } from '../lib/prisma.js';

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

// Lista do usuário autenticado (HSP-PBI-064-TSK-02 #555): só as dele, da mais recente para a mais antiga.
// Sai só o tipo e a referência para o App abrir a tela; o content fica no banco (LGPD) e a tela relacionada mostra o resto.
export async function listMyNotificationsService(user, { page, pageSize }) {
    const where = { userId: user.id };
    const [notifications, total] = await prisma.$transaction([
        prisma.notification.findMany({
            where,
            select: { id: true, type: true, referenceType: true, referenceId: true, read: true, createdAt: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        prisma.notification.count({ where }),
    ]);
    return { items: notifications.map(toItem), page, pageSize, total };
}

function toItem({ id, type, referenceType, referenceId, read, createdAt }) {
    // Linha antiga sem referência (tipo que o backfill da #554 não conhecia): o App mostra sem link
    const reference = referenceType && referenceId ? { type: referenceType, id: referenceId } : null;
    return { id, type, reference, read, createdAt: createdAt.toISOString() };
}
