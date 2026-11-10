// Papéis do filtro: tutor e provider vêm dos perfis do usuário; admin, do tipo da conta
export const USER_ROLES = ['tutor', 'provider', 'admin'];
// Os valores do CHECK de users.status. A #413 revê os estados da conta
export const USER_STATUSES = ['active', 'blocked', 'suspended', 'pending'];
const MAX_PAGE_SIZE = 50;
const ALLOWED = ['q', 'role', 'status', 'page', 'pageSize'];

// True só quando o campo veio uma única vez na URL (texto).
// Ausente (undefined) ou repetido (lista) dá false: nos dois casos o valor não pode ser usado.
function isSingleValue(query, field) {
    return typeof query[field] === 'string';
}

// Query da consulta de usuários (GET /api/v1/admin/users, #580), sem banco.
// Devolve todos os erros de uma vez em details; sem erro, os filtros no formato do service (ausente = undefined, que não filtra).
export function parseUserListQuery(query) {
    const details = [];
    const invalid = (field, message) => details.push({ field, message });

    // Parâmetro repetido (?role=a&role=b) chega como lista: recusado, para não escolher um dos valores em silêncio
    for (const [field, value] of Object.entries(query)) {
        if (!ALLOWED.includes(field)) invalid(field, 'não faz parte do contrato');
        else if (typeof value !== 'string') invalid(field, 'informe uma única vez');
    }
    // Valor repetido já recebeu o erro acima: daqui em diante conta como ausente (isSingleValue dá false)
    // Mínimo de 2 caracteres: uma letra só casaria com quase todos os usuários
    const q = isSingleValue(query, 'q') ? query.q.trim() : undefined;
    if (q !== undefined && (q.length < 2 || q.length > 100)) invalid('q', 'texto de 2 a 100 caracteres');

    const role = isSingleValue(query, 'role') ? query.role : undefined;
    if (role !== undefined && !USER_ROLES.includes(role)) invalid('role', `um de: ${USER_ROLES.join(', ')}`);

    const status = isSingleValue(query, 'status') ? query.status : undefined;
    if (status !== undefined && !USER_STATUSES.includes(status)) invalid('status', `um de: ${USER_STATUSES.join(', ')}`);

    const page = isSingleValue(query, 'page') ? Number(query.page) : 1;
    const pageSize = isSingleValue(query, 'pageSize') ? Number(query.pageSize) : 20;
    if (!Number.isInteger(page) || page < 1) invalid('page', 'inteiro a partir de 1');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
        invalid('pageSize', `inteiro de 1 a ${MAX_PAGE_SIZE}`);
    }

    if (details.length) return { details };
    return { details, filters: { q, role, status, page, pageSize } };
}

// Papéis de um usuário, na ordem do contrato. Vazio para quem ainda não tem perfil nem papel.
export function userRoles(user) {
    return [user.tutor && 'tutor', user.provider && 'provider', user.accountType === 'admin' && 'admin'].filter(Boolean);
}
