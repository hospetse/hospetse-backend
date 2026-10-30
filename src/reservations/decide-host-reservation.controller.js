import { AppError } from '../lib/app-error.js';
import { requireHost } from '../hosts/host-policy.js';
import { acceptHostReservationService, rejectHostReservationService } from './decide-host-reservation.service.js';

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

// POST /api/v1/me/host/reservations/:id/reject (HSP-PBI-042-TSK-01 #491). Ordem no app.js: JWT do usuário → JSON → este controller.
// Body { reason }: o motivo vai para o Tutor no evento de notificação.
export async function rejectHostReservationController(req, res) {
    try {
        const host = requireHost(req.user);
        if (!UUID.test(req.params.id)) throw notFound;

        const { reason, ...extra } = req.body ?? {};
        const details = [];
        if (typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > 500) {
            details.push({ field: 'reason', message: 'obrigatório, até 500 caracteres' });
        }
        for (const field of Object.keys(extra)) details.push({ field, message: 'não faz parte do contrato' });
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details });
        }

        return res.status(200).json(toResponse(await rejectHostReservationService(host, req.params.id, reason.trim())));
    } catch (error) {
        return sendError(res, error);
    }
}
