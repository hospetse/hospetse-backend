import { AppError } from '../lib/app-error.js';
import { PET_SIZES, PET_SPECIES, requireTutor } from './pet-policy.js';
import { createPetService, deletePetService, listPetsService, updatePetService } from './pet.service.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 50;

const isText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.trim().length <= max;
const isOptional = (value) => value === undefined || value === null || value === '';
// new Date('2020-02-30') vira 01/03 sem erro: só aceita se a data convertida voltar igual ao texto
const isRealDate = (value) => typeof value === 'string' && DATE.test(value)
    && !isNaN(new Date(value)) && new Date(value).toISOString().slice(0, 10) === value;

function sendError(res, error) {
    if (error instanceof AppError) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
    }
    console.log(error.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
}

function parsePetBody(body) {
    const { name, species, breed, size, birthDate, medicalNotes, behavioralNotes, ...extra } = body ?? {};
    const details = [];
    const invalid = (field, message) => details.push({ field, message });

    if (!isText(name, 255)) invalid('name', 'obrigatório, até 255 caracteres');
    if (!PET_SPECIES.includes(species)) invalid('species', `um de: ${PET_SPECIES.join(', ')}`);
    if (!isOptional(breed) && !isText(breed, 100)) invalid('breed', 'até 100 caracteres');
    if (!isOptional(size) && !PET_SIZES.includes(size)) invalid('size', `um de: ${PET_SIZES.join(', ')}`);
    if (!isOptional(birthDate)) {
        if (!isRealDate(birthDate)) invalid('birthDate', 'data no formato YYYY-MM-DD');
        else if (birthDate > new Date().toISOString().slice(0, 10)) invalid('birthDate', 'não pode ser no futuro');
    }
    if (!isOptional(medicalNotes) && !isText(medicalNotes, 2000)) invalid('medicalNotes', 'até 2000 caracteres');
    if (!isOptional(behavioralNotes) && !isText(behavioralNotes, 2000)) invalid('behavioralNotes', 'até 2000 caracteres');
    for (const field of Object.keys(extra)) invalid(field, 'não faz parte do contrato');

    if (details.length) return { details };
    return {
        details,
        data: {
            petName: name.trim(),
            petSpecies: species,
            petBreed: isOptional(breed) ? null : breed.trim(),
            petSize: isOptional(size) ? null : size,
            petBirthDate: isOptional(birthDate) ? null : new Date(birthDate),
            medicalNotes: isOptional(medicalNotes) ? null : medicalNotes.trim(),
            behavioralNotes: isOptional(behavioralNotes) ? null : behavioralNotes.trim(),
        },
    };
}

function toResponse(pet) {
    return {
        id: pet.id,
        name: pet.petName,
        species: pet.petSpecies,
        breed: pet.petBreed,
        size: pet.petSize,
        birthDate: pet.petBirthDate?.toISOString().slice(0, 10) ?? null,
        medicalNotes: pet.medicalNotes,
        behavioralNotes: pet.behavioralNotes,
    };
}

export async function createPetController(req, res) {
    try {
        const tutor = requireTutor(req.user);
        const { details, data } = parsePetBody(req.body);
        if (details.length) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details });
        return res.status(201).json(toResponse(await createPetService(tutor.id, data)));
    } catch (error) {
        return sendError(res, error);
    }
}

export async function listPetsController(req, res) {
    try {
        const tutor = requireTutor(req.user);
        const details = [];
        const page = req.query.page === undefined ? 1 : Number(req.query.page);
        const pageSize = req.query.pageSize === undefined ? 20 : Number(req.query.pageSize);
        if (!Number.isInteger(page) || page < 1) details.push({ field: 'page', message: 'inteiro a partir de 1' });
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
            details.push({ field: 'pageSize', message: `inteiro de 1 a ${MAX_PAGE_SIZE}` });
        }
        if (details.length) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Parâmetros inválidos', details });
        const result = await listPetsService(tutor.id, { page, pageSize });
        return res.status(200).json({ ...result, items: result.items.map(toResponse) });
    } catch (error) {
        return sendError(res, error);
    }
}

export async function updatePetController(req, res) {
    try {
        const tutor = requireTutor(req.user);
        if (!UUID.test(req.params.id)) throw new AppError('Pet não encontrado', 404, 'NOT_FOUND');
        const { details, data } = parsePetBody(req.body);
        if (details.length) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details });
        const pet = await updatePetService(tutor.id, req.params.id, data);
        if (!pet) throw new AppError('Pet não encontrado', 404, 'NOT_FOUND');
        return res.status(200).json(toResponse(pet));
    } catch (error) {
        return sendError(res, error);
    }
}

export async function deletePetController(req, res) {
    try {
        const tutor = requireTutor(req.user);
        if (!UUID.test(req.params.id)) throw new AppError('Pet não encontrado', 404, 'NOT_FOUND');
        const deleted = await deletePetService(tutor.id, req.params.id);
        if (!deleted) throw new AppError('Pet não encontrado', 404, 'NOT_FOUND');
        return res.status(204).send();
    } catch (error) {
        return sendError(res, error);
    }
}
