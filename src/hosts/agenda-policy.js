import { isRealDate } from '../lib/date.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const QUERY_FIELDS = ['startDate', 'endDate'];

export const addDays = (date, days) => new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS);
const today = () => new Date().toISOString().slice(0, 10);

// Período [startDate, endDate): o último dia não entra, como nas reservas e na busca.
// shortcut: "hoje" pelo dia em UTC, como na solicitação (#494); trocar junto se lá passar para o fuso de São Paulo
function checkPeriod(startDate, endDate, { maxDays, allowPast }, invalid) {
    if (!isRealDate(startDate)) invalid('startDate', 'data no formato YYYY-MM-DD');
    else if (!allowPast && startDate < today()) invalid('startDate', 'não pode ser no passado');
    if (!isRealDate(endDate)) invalid('endDate', 'data no formato YYYY-MM-DD');
    else if (isRealDate(startDate)) {
        if (endDate <= startDate) invalid('endDate', 'deve ser depois de startDate');
        else if (daysBetween(startDate, endDate) > maxDays) invalid('endDate', `até ${maxDays} dias depois de startDate`);
    }
}

// GET /api/v1/me/host/agenda (#482): sem datas, de hoje até 30 dias; até 90 dias por consulta. Passado é permitido (histórico).
export function parseAgendaQuery(query) {
    const details = [];
    const invalid = (field, message) => details.push({ field, message });
    for (const field of Object.keys(query)) {
        if (!QUERY_FIELDS.includes(field)) invalid(field, 'não faz parte do contrato');
    }
    const startDate = query.startDate ?? today();
    const endDate = query.endDate ?? (isRealDate(startDate) ? addDays(startDate, 30) : undefined);
    checkPeriod(startDate, endDate, { maxDays: 90, allowPast: true }, invalid);
    return { details, startDate, endDate };
}

// POST /api/v1/me/host/agenda/blocks (#482): datas obrigatórias, sem passado, até 365 dias (no máximo 365 linhas por pedido).
export function parseBlockBody(body) {
    const details = [];
    const invalid = (field, message) => details.push({ field, message });
    const { startDate, endDate, reason, ...extra } = body ?? {};
    checkPeriod(startDate, endDate, { maxDays: 365, allowPast: false }, invalid);
    const hasReason = reason !== undefined && reason !== null && reason !== '';
    if (hasReason && (typeof reason !== 'string' || reason.trim().length > 500)) invalid('reason', 'até 500 caracteres');
    for (const field of Object.keys(extra)) invalid(field, 'não faz parte do contrato');
    return { details, startDate, endDate, reason: hasReason && typeof reason === 'string' ? reason.trim() : null };
}
