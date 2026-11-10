// Os três tipos de prestador. Hoje só existe Host (hotel): Pet Sitter e Pet Walker entram com a #342
export const PROVIDER_TYPES = ['hotel', 'pet_sitter', 'pet_walker'];
const MAX_PAGE_SIZE = 50;
const ALLOWED = ['providerType', 'page', 'pageSize'];

// True só quando o campo veio uma única vez na URL (texto).
// Ausente (undefined) ou repetido (lista) dá false: nos dois casos o valor não pode ser usado.
function isSingleValue(query, field) {
    return typeof query[field] === 'string';
}

// Query da fila de validação (GET /api/v1/admin/provider-validations, #398), sem banco.
// Devolve todos os erros de uma vez em details; sem erro, os filtros no formato do service (ausente = undefined, que não filtra).
export function parseValidationQueueQuery(query) {
    const details = [];
    const invalid = (field, message) => details.push({ field, message });

    // Parâmetro repetido (?page=1&page=2) chega como lista: recusado, para não escolher um dos valores em silêncio
    for (const [field, value] of Object.entries(query)) {
        if (!ALLOWED.includes(field)) invalid(field, 'não faz parte do contrato');
        else if (typeof value !== 'string') invalid(field, 'informe uma única vez');
    }
    // Valor repetido já recebeu o erro acima: daqui em diante conta como ausente (isSingleValue dá false)
    const providerType = isSingleValue(query, 'providerType') ? query.providerType : undefined;
    if (providerType !== undefined && !PROVIDER_TYPES.includes(providerType)) {
        invalid('providerType', `um de: ${PROVIDER_TYPES.join(', ')}`);
    }

    const page = isSingleValue(query, 'page') ? Number(query.page) : 1;
    const pageSize = isSingleValue(query, 'pageSize') ? Number(query.pageSize) : 20;
    if (!Number.isInteger(page) || page < 1) invalid('page', 'inteiro a partir de 1');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
        invalid('pageSize', `inteiro de 1 a ${MAX_PAGE_SIZE}`);
    }

    if (details.length) return { details };
    return { details, filters: { providerType, page, pageSize } };
}
