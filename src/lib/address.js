const ZIP_CODE = /^\d{5}-?\d{3}$/;
const STATE = /^[A-Za-z]{2}$/;
const ADDRESS_FIELDS = ['zipCode', 'street', 'number', 'complement', 'neighborhood', 'city', 'state'];

const isText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.trim().length <= max;

// Regras do endereço estruturado, usadas pelo Tutor e pelo Host. invalid(field, message) acumula os erros de quem chama.
export function addressProblems(address, invalid) {
    if (typeof address.zipCode !== 'string' || !ZIP_CODE.test(address.zipCode)) invalid('address.zipCode', 'deve ter 8 dígitos');
    if (!isText(address.street, 255)) invalid('address.street', 'obrigatório, até 255 caracteres');
    if (!isText(address.number, 20)) invalid('address.number', 'obrigatório, até 20 caracteres');
    if (address.complement != null && address.complement !== '' && !isText(address.complement, 100)) {
        invalid('address.complement', 'até 100 caracteres');
    }
    if (!isText(address.neighborhood, 100)) invalid('address.neighborhood', 'obrigatório, até 100 caracteres');
    if (!isText(address.city, 100)) invalid('address.city', 'obrigatório, até 100 caracteres');
    if (typeof address.state !== 'string' || !STATE.test(address.state)) invalid('address.state', 'sigla com 2 letras');
    for (const field of Object.keys(address)) {
        if (!ADDRESS_FIELDS.includes(field)) invalid(`address.${field}`, 'não faz parte do contrato');
    }
}

// Recebe um endereço já validado e devolve só os campos do contrato, no formato gravado.
export function normalizeAddress(address) {
    return {
        zipCode: address.zipCode.replace('-', ''),
        street: address.street.trim(),
        number: address.number.trim(),
        complement: address.complement?.trim() || null,
        neighborhood: address.neighborhood.trim(),
        city: address.city.trim(),
        state: address.state.toUpperCase(),
    };
}
