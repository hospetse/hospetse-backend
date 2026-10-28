// Regras do perfil, sem HTTP. canContract também será usado pela TSK-05, para o /me e o bloqueio não divergirem.

// shortcut: campos do perfil do Tutor; trocar pela regra da PBI-002 quando ela definir o perfil completo.
export function missingFields(user) {
    const tutor = user.tutor;
    return [['cpf', tutor?.cpf], ['birthDate', tutor?.birthDate], ['phone', tutor?.phone]]
        .filter(([, value]) => value == null)
        .map(([field]) => field);
}

// pending não bloqueia: todo USER novo nasce assim, com o e-mail já confirmado pelo Auth.
export function canContract(user) {
    return user.profileStatus === 'complete' && !['blocked', 'suspended'].includes(user.status);
}
