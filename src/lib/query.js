// Leitura da query string (req.query) nas rotas de consulta. O Express 5 entrega texto quando o campo vem uma vez,
// lista quando vem repetido (?page=1&page=2) e undefined quando não vem.
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

// True só quando o campo veio uma única vez na URL (texto).
// Ausente (undefined) ou repetido (lista) dá false: nos dois casos o valor não pode ser usado.
export const isSingleValue = (query, field) => typeof query[field] === 'string';

// Campo fora do contrato ou repetido vira erro em details. Repetido é recusado para não escolher um dos valores em silêncio;
// depois disso ele conta como ausente (isSingleValue dá false), para não receber um segundo erro.
export function checkQueryFields(query, allowed, invalid) {
    for (const [field, value] of Object.entries(query)) {
        if (!allowed.includes(field)) invalid(field, 'não faz parte do contrato');
        else if (typeof value !== 'string') invalid(field, 'informe uma única vez');
    }
}

// page (padrão 1) e pageSize (padrão 20, máximo 50) já como números. Os erros vão para o mesmo details dos outros campos.
export function parsePagination(query, invalid) {
    const page = isSingleValue(query, 'page') ? Number(query.page) : 1;
    const pageSize = isSingleValue(query, 'pageSize') ? Number(query.pageSize) : DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(page) || page < 1) invalid('page', 'inteiro a partir de 1');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
        invalid('pageSize', `inteiro de 1 a ${MAX_PAGE_SIZE}`);
    }
    return { page, pageSize };
}
