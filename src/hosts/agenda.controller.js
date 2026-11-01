import { AppError } from '../lib/app-error.js';
import { requireHost } from './host-policy.js';
import { parseAgendaQuery, parseBlockBody } from './agenda-policy.js';
import { blockPeriodService, getAgendaService, unblockDayService } from './agenda.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toBlock = (block) => ({ id: block.id, date: block.date.toISOString().slice(0, 10), reason: block.reason });

function sendError(res, error) {
    if (error instanceof AppError) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
    }
    console.log(error.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
}

// GET /api/v1/me/host/agenda?startDate&endDate (HSP-PBI-036-TSK-01 #482). O Host vem só do JWT (req.user), nunca da URL.
export async function getAgendaController(req, res) {
    try {
        const host = requireHost(req.user);
        const { details, startDate, endDate } = parseAgendaQuery(req.query);
        if (details.length) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Parâmetros inválidos', details });
        return res.status(200).json(await getAgendaService(host.id, { startDate, endDate }));
    } catch (error) {
        return sendError(res, error);
    }
}

// POST /api/v1/me/host/agenda/blocks (#482): bloqueia de startDate até o dia antes de endDate
export async function blockPeriodController(req, res) {
    try {
        const host = requireHost(req.user);
        const { details, ...data } = parseBlockBody(req.body);
        if (details.length) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details });
        const blocks = await blockPeriodService(host.id, data);
        return res.status(201).json({ items: blocks.map(toBlock) });
    } catch (error) {
        return sendError(res, error);
    }
}

// DELETE /api/v1/me/host/agenda/blocks/:id (#482): libera um dia
export async function unblockDayController(req, res) {
    try {
        const host = requireHost(req.user);
        // id fora do formato UUID faria o Prisma lançar erro (500): responde o mesmo 404
        if (!UUID.test(req.params.id)) throw new AppError('Bloqueio não encontrado', 404, 'NOT_FOUND');
        await unblockDayService(host.id, req.params.id);
        return res.status(204).end();
    } catch (error) {
        return sendError(res, error);
    }
}
