import { AppError } from '../lib/app-error.js';
import { requireHost } from '../hosts/host-policy.js';
import { acceptHostReservationService } from './decide-host-reservation.service.js';

// O id vai para uma coluna UUID: texto em outro formato faria o Prisma lançar erro (500), então já responde 404
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = new AppError('Solicitação não encontrada', 404, 'NOT_FOUND');

function sendError(res, error) {
    if (error instanceof AppError) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
    }
    console.log(error.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
}

const toResponse = (reservation) => ({
    id: reservation.id,
    status: reservation.status,
    decidedAt: reservation.decidedAt.toISOString(),
    rejectionReason: reservation.rejectionReason,
});

// POST /api/v1/me/host/reservations/:id/accept (HSP-PBI-042-TSK-01 #491). Ordem no app.js: JWT do usuário → este controller.
// O Host vem só do JWT (req.user); a reserva precisa ser de um serviço dele.
export async function acceptHostReservationController(req, res) {
    try {
        const host = requireHost(req.user);
        if (!UUID.test(req.params.id)) throw notFound;
        return res.status(200).json(toResponse(await acceptHostReservationService(host, req.params.id)));
    } catch (error) {
        return sendError(res, error);
    }
}
