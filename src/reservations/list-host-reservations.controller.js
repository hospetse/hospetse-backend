import { AppError } from '../lib/app-error.js';
import { requireHost } from '../hosts/host-policy.js';
import { listHostReservationsService } from './list-host-reservations.service.js';
import { checkQueryFields, isSingleValue, parsePagination } from '../lib/query.js';
// shortcut: só as pendentes, que é o que a #485 pede; abrir os outros status quando alguma tela precisar
const STATUSES = ['requested'];

// GET /api/v1/me/host/reservations?status=requested&page=1&pageSize=20 (HSP-PBI-041-TSK-01 #485).
// Ordem no app.js: JWT do usuário → este controller. O Host vem só do JWT (req.user), nunca da URL.
export async function listHostReservationsController(req, res) {
    try {
        const host = requireHost(req.user);

        const details = [];
        const invalid = (field, message) => details.push({ field, message });
        checkQueryFields(req.query, ['status', 'page', 'pageSize'], invalid);
        // Repetido já recebeu o erro acima: conta como ausente, para não receber um segundo erro
        const status = isSingleValue(req.query, 'status') ? req.query.status : 'requested';
        if (!STATUSES.includes(status)) invalid('status', `um de: ${STATUSES.join(', ')}`);
        const { page, pageSize } = parsePagination(req.query, invalid);
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Parâmetros inválidos', details });
        }

        const result = await listHostReservationsService(host.id, { status, page, pageSize });
        return res.status(200).json({ ...result, items: result.items.map(toResponse) });
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
        }
        console.log(error.message);
        return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
    }
}

// Datas só com o dia, Decimal como número e os nomes do contrato da API (sem o prefixo pet)
function toResponse(reservation) {
    return {
        id: reservation.id,
        status: reservation.status,
        serviceId: reservation.serviceId,
        startDate: reservation.startDate.toISOString().slice(0, 10),
        endDate: reservation.endDate?.toISOString().slice(0, 10) ?? null,
        dailyPrice: reservation.dailyPrice === null ? null : Number(reservation.dailyPrice),
        totalValue: Number(reservation.totalValue),
        notes: reservation.notes,
        createdAt: reservation.createdDate.toISOString(),
        tutor: { name: reservation.tutor.name },
        pet: {
            name: reservation.pet.petName,
            species: reservation.pet.petSpecies,
            size: reservation.pet.petSize,
            breed: reservation.pet.petBreed,
            medicalNotes: reservation.pet.medicalNotes,
            behavioralNotes: reservation.pet.behavioralNotes,
        },
    };
}
