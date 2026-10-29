// Regras do perfil, sem HTTP. canContract também será usado pela TSK-05, para o /me e o bloqueio não divergirem.

// Campos exigidos para o perfil do Tutor ficar complete (PBI-002). Espera user.tutor.address carregado.
export function missingFields(user) {
    const tutor = user.tutor;
    return [
        ['cpf', tutor?.cpf],
        ['birthDate', tutor?.birthDate],
        ['phone', tutor?.phone],
        ['address', tutor?.address],
        ['emergencyContact', tutor?.emergencyContactName && tutor?.emergencyContactPhone],
    ]
        .filter(([, value]) => !value)
        .map(([field]) => field);
}

// birthDate e today no formato YYYY-MM-DD: comparar as strings já compara as datas.
// shortcut: today padrão em UTC (perto da meia-noite pode adiantar o aniversário em 3h no Brasil), aceitável para a regra dos 18 anos.
export function isAdult(birthDate, today = new Date().toISOString().slice(0, 10)) {
    const [year, month, day] = birthDate.split('-');
    return `${Number(year) + 18}-${month}-${day}` <= today;
}

// pending não bloqueia: todo USER novo nasce assim, com o e-mail já confirmado pelo Auth.
export function canContract(user) {
    return user.profileStatus === 'complete' && !['blocked', 'suspended'].includes(user.status);
}
