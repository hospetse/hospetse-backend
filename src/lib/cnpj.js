// Regras do CNPJ, sem HTTP nem banco. Recebe só dígitos.

// Dígito verificador: soma ponderada com pesos que vão até 9 e voltam a 2, depois resto de 11.
function checkDigit(cnpj, length) {
    let sum = 0;
    let weight = length - 7;
    for (let i = 0; i < length; i++) {
        sum += Number(cnpj[i]) * weight;
        weight = weight === 2 ? 9 : weight - 1;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
}

export function isValidCnpj(cnpj) {
    if (!/^\d{14}$/.test(cnpj)) return false;
    if (/^(\d)\1{13}$/.test(cnpj)) return false;
    return checkDigit(cnpj, 12) === Number(cnpj[12]) && checkDigit(cnpj, 13) === Number(cnpj[13]);
}
