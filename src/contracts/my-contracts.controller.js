import { AppError } from '../lib/app-error.js';
import { checkQueryFields, parsePagination } from '../lib/query.js';
import { requireTutor } from '../pets/pet-policy.js';
import { listMyContractsService } from './my-contracts.service.js';

// GET /api/v1/me/contracts?page=1&pageSize=20 (HSP-PBI-046-TSK-01 #533). O Tutor vem só do JWT (req.user).
// Ordem no app.js: JWT do usuário → este controller. Consultar não exige perfil apto, só ser Tutor.
export async function listMyContractsController(req, res) {
    try {
        const tutor = requireTutor(req.user);
        const details = [];
        const invalid = (field, message) => details.push({ field, message });
        checkQueryFields(req.query, ['page', 'pageSize'], invalid);
        const { page, pageSize } = parsePagination(req.query, invalid);
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Parâmetros inválidos', details });
        }

        return res.status(200).json(await listMyContractsService(tutor, { page, pageSize }));
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
        }
        console.log(`minhas contratações: erro ${error.name}`);
        return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
    }
}
