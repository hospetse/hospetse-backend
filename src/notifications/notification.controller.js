import { AppError } from '../lib/app-error.js';
import { checkQueryFields, parsePagination } from '../lib/query.js';
import { listMyNotificationsService } from './notification.service.js';

// GET /api/v1/me/notifications?page=1&pageSize=20 (HSP-PBI-064-TSK-02 #555). O usuário vem só do JWT (req.user).
// Ordem no app.js: JWT do usuário → este controller. Vale para qualquer papel: Tutor, prestador e admin recebem notificação.
export async function listMyNotificationsController(req, res) {
    try {
        const details = [];
        const invalid = (field, message) => details.push({ field, message });
        checkQueryFields(req.query, ['page', 'pageSize'], invalid);
        const { page, pageSize } = parsePagination(req.query, invalid);
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Parâmetros inválidos', details });
        }

        return res.status(200).json(await listMyNotificationsService(req.user, { page, pageSize }));
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
        }
        console.log(`notificações: erro ${error.name}`);
        return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
    }
}
