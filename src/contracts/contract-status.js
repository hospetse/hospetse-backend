// Nomes oficiais dos estados da contratação (Glossário V2 da Wiki, "Estados da contratação"), por status do banco (#533).
// "Solicitada" e "Finalizada" são sinônimos não oficiais no Glossário: não usar. Um status novo no CHECK precisa entrar aqui
// (test/contract-status.test.js confere).
export const CONTRACT_STATUS_LABELS = {
    requested: 'Aguardando aceite',
    awaiting_payment: 'Aguardando pagamento',
    accepted: 'Confirmada',
    checked_in: 'Em andamento',
    // O check-out conclui a contratação (Glossário, "Check-out")
    checked_out: 'Concluída',
    completed: 'Concluída',
    rejected: 'Recusada',
    cancelled: 'Cancelada',
};

// Tipo da contratação pelo tipo do prestador: visita e passeio entram sem mudar o contrato quando a #564 criar os registros
export const CONTRACT_TYPES = { hotel: 'hospedagem', pet_sitter: 'visita', pet_walker: 'passeio' };
