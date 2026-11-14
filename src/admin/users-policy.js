import { checkQueryFields, isSingleValue, parsePagination } from '../lib/query.js';

// Papéis do filtro: tutor e provider vêm dos perfis do usuário; admin, do tipo da conta
export const USER_ROLES = ['tutor', 'provider', 'admin'];
// Os valores do CHECK de users.status. A #413 revê os estados da conta
export const USER_STATUSES = ['active', 'blocked', 'suspended', 'pending'];
const ALLOWED = ['q', 'role', 'status', 'page', 'pageSize'];

// Query da consulta de usuários (GET /api/v1/admin/users, #580), sem banco.
// Devolve todos os erros de uma vez em details; sem erro, os filtros no formato do service (ausente = undefined, que não filtra).
export function parseUserListQuery(query) {
    const details = [];
    const invalid = (field, message) => details.push({ field, message });

    checkQueryFields(query, ALLOWED, invalid);
    // Valor repetido já recebeu o erro acima: daqui em diante conta como ausente (isSingleValue dá false)
    // Mínimo de 2 caracteres: uma letra só casaria com quase todos os usuários
    const q = isSingleValue(query, 'q') ? query.q.trim() : undefined;
    if (q !== undefined && (q.length < 2 || q.length > 100)) invalid('q', 'texto de 2 a 100 caracteres');

    const role = isSingleValue(query, 'role') ? query.role : undefined;
    if (role !== undefined && !USER_ROLES.includes(role)) invalid('role', `um de: ${USER_ROLES.join(', ')}`);

    const status = isSingleValue(query, 'status') ? query.status : undefined;
    if (status !== undefined && !USER_STATUSES.includes(status)) invalid('status', `um de: ${USER_STATUSES.join(', ')}`);

    const { page, pageSize } = parsePagination(query, invalid);

    if (details.length) return { details };
    return { details, filters: { q, role, status, page, pageSize } };
}

// Papéis de um usuário, na ordem do contrato. Vazio para quem ainda não tem perfil nem papel.
export function userRoles(user) {
    return [user.tutor && 'tutor', user.provider && 'provider', user.accountType === 'admin' && 'admin'].filter(Boolean);
}
