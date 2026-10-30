import { AppError } from '../lib/app-error.js';
import { requireTutor } from '../pets/pet-policy.js';
import { createReservationService } from './create-reservation.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Gerada pelo app a cada intenção de solicitar (um UUID, por exemplo) e repetida nos reenvios
const IDEMPOTENCY_KEY = /^[\w-]{1,100}$/;

const isOptional = (value) => value === undefined || value === null || value === '';
// new Date('2026-02-30') vira 02/03 sem erro: só aceita se a data convertida voltar igual ao texto
const isRealDate = (value) => typeof value === 'string' && DATE.test(value)
    && !isNaN(new Date(value)) && new Date(value).toISOString().slice(0, 10) === value;

// POST /api/v1/reservations (HSP-PBI-039-TSK-01 #494): o Tutor solicita hospedagem de um pet num serviço de um Host.
// Ordem no app.js: JWT do usuário → guarda de contratação (#263) → JSON → este controller.
// O Tutor vem só do JWT (req.user): um tutorId no body é recusado como campo fora do contrato.
export async function createReservationController(req, res) {
    try {
        const tutor = requireTutor(req.user);
        const idempotencyKey = req.get('Idempotency-Key');
        const { serviceId, petId, startDate, endDate, notes, ...extra } = req.body ?? {};

        // Lista todos os campos inválidos de uma vez
        const details = [];
        const invalid = (field, message) => details.push({ field, message });

        if (!IDEMPOTENCY_KEY.test(idempotencyKey ?? '')) {
            invalid('Idempotency-Key', 'header obrigatório: até 100 letras, números, - ou _');
        }
        if (typeof serviceId !== 'string' || !UUID.test(serviceId)) invalid('serviceId', 'UUID obrigatório');
        if (typeof petId !== 'string' || !UUID.test(petId)) invalid('petId', 'UUID obrigatório');

        // shortcut: "hoje" pelo dia em UTC, como nos pets; usar o fuso de São Paulo se o app reclamar perto da meia-noite
        const today = new Date().toISOString().slice(0, 10);
        if (!isRealDate(startDate)) invalid('startDate', 'data no formato YYYY-MM-DD');
        else if (startDate < today) invalid('startDate', 'não pode ser no passado');
        if (!isRealDate(endDate)) invalid('endDate', 'data no formato YYYY-MM-DD');
        else if (isRealDate(startDate) && endDate <= startDate) invalid('endDate', 'deve ser depois de startDate');

        if (!isOptional(notes) && (typeof notes !== 'string' || notes.trim().length > 1000)) invalid('notes', 'até 1000 caracteres');
        for (const field of Object.keys(extra)) invalid(field, 'não faz parte do contrato');

        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details });
        }

        const { reservation, created } = await createReservationService(req.user, tutor, {
            idempotencyKey,
            serviceId,
            petId,
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            notes: isOptional(notes) ? null : notes.trim(),
        });
        // 201 na criação; 200 no reenvio da mesma intenção, com a mesma solicitação
        return res.status(created ? 201 : 200).json(toResponse(reservation));
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
        }
        console.log(error.message);
        return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
    }
}

// Datas só com o dia e Decimal como número; o tutorId não sai, porque a solicitação é sempre do próprio Tutor
function toResponse(reservation) {
    return {
        id: reservation.id,
        status: reservation.status,
        hostId: reservation.service.providerId,
        serviceId: reservation.serviceId,
        petId: reservation.petId,
        startDate: reservation.startDate.toISOString().slice(0, 10),
        endDate: reservation.endDate.toISOString().slice(0, 10),
        dailyPrice: Number(reservation.dailyPrice),
        totalValue: Number(reservation.totalValue),
        notes: reservation.notes,
        createdAt: reservation.createdDate.toISOString(),
    };
}
