import { AppError } from '../lib/app-error.js';
import { checkQueryFields, parsePagination } from '../lib/query.js';
import { listMessagesService, openConversationService } from './conversation.service.js';

// POST /api/v1/contracts/:id/conversation (HSP-PBI-055-TSK-02 #548), sem body. Tutor ou Host da contratação.
// Ordem no app.js: JWT do usuário → este controller. Abrir conversa não é contratar: fica fora da guarda de contratação.
export async function openConversationController(req, res) {
    try {
        const { conversation, created } = await openConversationService(req.user, req.params.id);
        return res.status(created ? 201 : 200).json(conversation);
    } catch (error) {
        return sendError(res, error);
    }
}

// GET /api/v1/conversations/:id/messages?page=1&pageSize=20 (#548): histórico paginado, só para os participantes.
export async function listMessagesController(req, res) {
    try {
        const details = [];
        const invalid = (field, message) => details.push({ field, message });
        checkQueryFields(req.query, ['page', 'pageSize'], invalid);
        const { page, pageSize } = parsePagination(req.query, invalid);
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Parâmetros inválidos', details });
        }

        const result = await listMessagesService(req.user, req.params.id, { page, pageSize });
        return res.status(200).json(result);
    } catch (error) {
        return sendError(res, error);
    }
}

function sendError(res, error) {
    if (error instanceof AppError) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
    }
    console.log(`conversa: erro ${error.name}`);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
}
