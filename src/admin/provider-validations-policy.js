import { checkQueryFields, isSingleValue, parsePagination } from '../lib/query.js';

// Os três tipos de prestador. Hoje só existe Host (hotel): Pet Sitter e Pet Walker entram com a #342
export const PROVIDER_TYPES = ['hotel', 'pet_sitter', 'pet_walker'];
const ALLOWED = ['providerType', 'page', 'pageSize'];

// Query da fila de validação (GET /api/v1/admin/provider-validations, #398), sem banco.
// Devolve todos os erros de uma vez em details; sem erro, os filtros no formato do service (ausente = undefined, que não filtra).
export function parseValidationQueueQuery(query) {
    const details = [];
    const invalid = (field, message) => details.push({ field, message });

    checkQueryFields(query, ALLOWED, invalid);
    // Valor repetido já recebeu o erro acima: daqui em diante conta como ausente (isSingleValue dá false)
    const providerType = isSingleValue(query, 'providerType') ? query.providerType : undefined;
    if (providerType !== undefined && !PROVIDER_TYPES.includes(providerType)) {
        invalid('providerType', `um de: ${PROVIDER_TYPES.join(', ')}`);
    }

    const { page, pageSize } = parsePagination(query, invalid);

    if (details.length) return { details };
    return { details, filters: { providerType, page, pageSize } };
}
