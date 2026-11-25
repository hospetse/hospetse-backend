import { AppError } from '../lib/app-error.js';
import { requireTutor } from '../pets/pet-policy.js';
import { getContractTimelineService } from './timeline.service.js';

// GET /api/v1/contracts/:id/timeline (HSP-PBI-052-TSK-01 #542). O Tutor vem só do JWT (req.user).
// Ordem no app.js: JWT do usuário → este controller. Consultar não exige perfil apto, só ser o Tutor da contratação.
export async function getContractTimelineController(req, res) {
    try {
        const tutor = requireTutor(req.user);
        return res.status(200).json(await getContractTimelineService(tutor, req.params.id));
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
        }
        console.log(`acompanhamento: erro ${error.name}`);
        return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
    }
}
