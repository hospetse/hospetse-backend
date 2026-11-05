import { AppError } from '../lib/app-error.js';
import { publicFileUrl } from '../lib/storage.js';
import { parseSearchQuery } from './host-search-policy.js';
import { findTutorPet, searchHostsService } from './host-search.service.js';

// GET /api/v1/hosts/search (HSP-PBI-030-TSK-01 #476): o Tutor encontra ofertas compatíveis com o pet e o período.
// Ordem no app.js: JWT do usuário → este controller, registrado antes de /hosts/:id. Basta estar autenticado (canSearch).
export async function searchHostsController(req, res) {
    try {
        const { details, filters } = parseSearchQuery(req.query);
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Parâmetros inválidos', details });
        }

        // Com pet, a compatibilidade usa os dados dele; quem ainda não é Tutor não tem pet e cai no mesmo 400
        let pet = { species: filters.species, size: filters.size, breed: filters.breed };
        if (filters.petId) {
            const found = await findTutorPet(req.user.tutor?.id, filters.petId);
            if (!found) {
                return res.status(400).json({
                    code: 'VALIDATION_ERROR',
                    message: 'Parâmetros inválidos',
                    details: [{ field: 'petId', message: 'pet não encontrado' }],
                });
            }
            pet = { species: found.petSpecies, size: found.petSize, breed: found.petBreed };
        }

        const result = await searchHostsService(filters, pet);
        return res.status(200).json({ ...result, items: await Promise.all(result.items.map(toResponse)) });
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
        }
        console.log(error.message);
        return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
    }
}

// Mesmos nomes do GET /api/v1/hosts/:id, para a tela de resultado e a de detalhes usarem o mesmo formato
async function toResponse(service) {
    const host = service.provider;
    return {
        hostId: host.id,
        serviceId: service.id,
        name: host.name,
        serviceName: service.name,
        dailyPrice: Number(service.price),
        pictureUrl: await publicFileUrl(host.urlPicture),
        location: { city: host.address?.city ?? null, neighborhood: host.address?.neighborhood ?? null },
        reputation: { rating: host.rating == null ? null : Number(host.rating), reviewCount: host._count.reviews },
    };
}
