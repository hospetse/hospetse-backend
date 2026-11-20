import { AppError } from '../lib/app-error.js';
import { prisma } from '../lib/prisma.js';
import { isOpenForSending, participantRole } from './conversation-policy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Os dois lados da contratação: o Tutor (que solicitou) e o prestador do serviço
const PARTIES = {
    id: true,
    status: true,
    tutor: { select: { id: true, userId: true, name: true } },
    service: { select: { provider: { select: { id: true, userId: true, name: true } } } },
};

// Inexistente, id inválido ou de quem não participa: a mesma resposta, para não revelar que existe (decisão do Lucas, 15/11/2026)
const notFound = (what) => new AppError(`${what} não encontrada`, 404, 'NOT_FOUND');

function parties(reservation) {
    return { tutorUserId: reservation.tutor.userId, hostUserId: reservation.service.provider.userId };
}

function toConversation(conversation, reservation) {
    return {
        id: conversation.id,
        contractId: reservation.id,
        participants: { tutor: { name: reservation.tutor.name }, host: { name: reservation.service.provider.name } },
        open: isOpenForSending(reservation.status),
        createdAt: conversation.createdAt,
    };
}

// Abre ou reabre a conversa da contratação (HSP-PBI-055-TSK-02 #548). Uma por contratação, desde a solicitação, em qualquer status.
// created diz se foi a primeira abertura (201) ou uma reabertura (200).
export async function openConversationService(user, reservationId) {
    const reservation = UUID.test(reservationId)
        ? await prisma.reservation.findUnique({ where: { id: reservationId }, select: PARTIES })
        : null;
    if (!reservation || !participantRole(parties(reservation), user.id)) throw notFound('Contratação');

    const existing = await prisma.conversation.findUnique({ where: { reservationId: reservation.id } });
    if (existing) return { conversation: toConversation(existing, reservation), created: false };

    try {
        const conversation = await prisma.conversation.create({
            data: {
                reservationId: reservation.id,
                tutorId: reservation.tutor.id,
                providerId: reservation.service.provider.id,
                // Conversa entre pessoas: o assistente de IA está fora da Sprint 8
                status: 'human_handling',
            },
        });
        return { conversation: toConversation(conversation, reservation), created: true };
    } catch (error) {
        if (error.code !== 'P2002') throw error;
        // Tutor e Host abriram ao mesmo tempo: o UNIQUE de reservation_id deixa uma só, e as duas aberturas recebem a mesma
        const conversation = await prisma.conversation.findUnique({ where: { reservationId: reservation.id } });
        return { conversation: toConversation(conversation, reservation), created: false };
    }
}

// Histórico (#548). A página 1 traz as mensagens mais recentes, como num app de chat; dentro da página, da mais antiga para a mais nova.
export async function listMessagesService(user, conversationId, { page, pageSize }) {
    const { conversation } = await findOwnConversation(user, conversationId);

    const where = { conversationId: conversation.id };
    const [newestFirst, total] = await prisma.$transaction([
        prisma.message.findMany({
            where,
            select: { id: true, senderType: true, content: true, sentAt: true, sender: { select: { name: true } } },
            orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        prisma.message.count({ where }),
    ]);
    const names = { tutor: conversation.reservation.tutor.name, host: conversation.reservation.service.provider.name };
    const items = newestFirst.reverse().map((message) => ({
        id: message.id,
        // O nome vem de quem enviou; mensagem antiga, sem sender_user_id, usa o nome da parte daquele papel
        author: { role: message.senderType, name: message.sender?.name ?? names[message.senderType] },
        text: message.content,
        sentAt: message.sentAt,
    }));
    return { items, page, pageSize, total, open: isOpenForSending(conversation.reservation.status) };
}

const TEXT_MAX = 2000;

// Conversa com os dois lados e o papel do usuário (histórico e canal em tempo real). Quem não participa, inexistente
// ou conversa sem contratação (legado, sem participantes por esta regra): o mesmo 404
async function findOwnConversation(user, conversationId) {
    const conversation = UUID.test(conversationId ?? '')
        ? await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, reservation: { select: PARTIES } } })
        : null;
    const role = conversation?.reservation ? participantRole(parties(conversation.reservation), user.id) : null;
    if (!role) throw notFound('Conversa');
    return { conversation, role };
}

// Entrar na sala da conversa (#551): só os participantes. Devolve se a conversa aceita mensagem nova.
export async function joinConversationService(user, conversationId) {
    const { conversation } = await findOwnConversation(user, conversationId);
    return { conversationId: conversation.id, open: isOpenForSending(conversation.reservation.status) };
}

// Envio de mensagem (HSP-PBI-056-TSK-01 #551): só texto, só participante, só com a contratação aberta.
// A mensagem é gravada antes de ser entregue: o que aparece em tempo real sempre existe no histórico.
// O autor vem do túnel autenticado (user), nunca do conteúdo da mensagem.
export async function sendMessageService(user, conversationId, text) {
    if (typeof text !== 'string' || text.trim() === '' || text.trim().length > TEXT_MAX) {
        throw new AppError('Parâmetros inválidos', 400, 'VALIDATION_ERROR', [{ field: 'text', message: `texto de 1 a ${TEXT_MAX} caracteres` }]);
    }
    const { conversation, role } = await findOwnConversation(user, conversationId);
    // Conferido a cada envio: a contratação pode ter sido concluída ou cancelada depois de a pessoa entrar na sala
    if (!isOpenForSending(conversation.reservation.status)) {
        throw new AppError('A conversa desta contratação está encerrada', 409, 'CONVERSATION_CLOSED');
    }

    // Mensagem e evento de nova mensagem para o outro participante (HSP-PBI-064) na mesma transação: os dois existem ou nenhum
    const { tutorUserId, hostUserId } = parties(conversation.reservation);
    const message = await prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
            data: { conversationId: conversation.id, senderType: role, senderUserId: user.id, content: text.trim() },
            select: { id: true, sentAt: true, content: true },
        });
        await tx.notification.create({
            data: {
                userId: role === 'tutor' ? hostUserId : tutorUserId,
                type: 'new_message',
                // Só as referências (LGPD): o texto da mensagem fica na conversa, não na notificação
                content: JSON.stringify({ conversationId: conversation.id, reservationId: conversation.reservation.id, messageId: created.id }),
            },
        });
        return created;
    });
    return { id: message.id, author: { role, name: user.name }, text: message.content, sentAt: message.sentAt };
}
