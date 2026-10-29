// Regras do CPF, sem HTTP nem banco. O banco guarda só os 11 dígitos.

// Aceita o CPF com ou sem pontuação; o que não for "." ou "-" continua lá e reprova na validação.
export function stripCpf(value) {
    return value.replace(/[.-]/g, '');
}

// Dígito verificador: soma ponderada dos primeiros `length` dígitos com pesos decrescentes até 2, depois resto de 11.
function checkDigit(cpf, length) {
    let sum = 0;
    for (let i = 0; i < length; i++) {
        sum += Number(cpf[i]) * (length + 1 - i);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
}

// Recebe só dígitos (já passados pelo stripCpf).
export function isValidCpf(cpf) {
    if (!/^\d{11}$/.test(cpf)) return false;
    // 111.111.111-11 e afins passam na conta, mas não são CPFs reais
    if (/^(\d)\1{10}$/.test(cpf)) return false;
    return checkDigit(cpf, 9) === Number(cpf[9]) && checkDigit(cpf, 10) === Number(cpf[10]);
}
