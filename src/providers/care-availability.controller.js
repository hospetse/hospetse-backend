import { AppError } from '../lib/app-error.js';
import { findTutorPet } from '../hosts/host-search.service.js';
import { parseCareAvailability, parseCareAvailabilityQuery, parseCareSearch } from './care-availability.policy.js';
import { findApprovedCare, getCareAvailability, saveCareAvailability, searchCareProviders } from './care-availability.service.js';

function sendError(res, error) {
    if (error instanceof AppError) return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
    console.log(error.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
}

const invalid = (res, details, message = 'Payload inválido') => res.status(400).json({ code: 'VALIDATION_ERROR', message, details });

export async function getCareAvailabilityController(req, res) {
    try {
        const { details, date } = parseCareAvailabilityQuery(req.query);
        if (details.length) return invalid(res, details, 'Parâmetros inválidos');
        return res.status(200).json(await getCareAvailability(req.user, date));
    } catch (error) { return sendError(res, error); }
}

export async function saveCareAvailabilityController(req, res) {
    try {
        const provider = await findApprovedCare(req.user);
        const { details, data } = parseCareAvailability(req.body, provider.providerType);
        if (details.length) return invalid(res, details);
        return res.status(200).json(await saveCareAvailability(req.user, data));
    } catch (error) { return sendError(res, error); }
}

export async function searchCareProvidersController(req, res) {
    try {
        const { details, filters } = parseCareSearch(req.query);
        if (details.length) return invalid(res, details, 'Parâmetros inválidos');
        let pet = { species: filters.species, size: filters.size, breed: filters.breed };
        if (filters.petId) {
            const found = await findTutorPet(req.user.tutor?.id, filters.petId);
            if (!found) return invalid(res, [{ field: 'petId', message: 'pet não encontrado' }], 'Parâmetros inválidos');
            pet = { species: found.petSpecies, size: found.petSize, breed: found.petBreed };
        }
        return res.status(200).json(await searchCareProviders(filters, pet));
    } catch (error) { return sendError(res, error); }
}
