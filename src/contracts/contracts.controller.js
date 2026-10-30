import { AppError } from '../lib/app-error.js';
import { startContractService } from './contracts.service.js';

// Camada HTTP provisória de reservations, service-requests e checkout (TSK-05 #263).
// shortcut: responde 501 depois das guardas; trocar pelo controller real (#494 e tasks de reserva/checkout), mantendo as guardas.
export function startContractController(req, res) {
    try {
        startContractService(req.user);
        return res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'Contratação ainda não disponível' });
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ code: error.code, message: error.message });
        }
        console.log(error.message);
        return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
    }
}
