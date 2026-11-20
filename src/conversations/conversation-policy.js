// Regras da conversa da contratação (#548), sem banco. Reusadas pelo envio em tempo real (#551).

// Contratação encerrada não recebe mensagem nova. O histórico continua visível em qualquer status
const CLOSED_FOR_SENDING = ['completed', 'rejected', 'cancelled'];
export const isOpenForSending = (reservationStatus) => !CLOSED_FOR_SENDING.includes(reservationStatus);

// Papel do usuário na contratação: o Tutor que solicitou ou o usuário do prestador do serviço. null = não participa.
// shortcut: o prestador é sempre host (sender_type_enum); Pet Sitter e Pet Walker entram com a #342, sem mudar a regra
export function participantRole({ tutorUserId, hostUserId }, userId) {
    if (userId === tutorUserId) return 'tutor';
    if (userId === hostUserId) return 'host';
    return null;
}
