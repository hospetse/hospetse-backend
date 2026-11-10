import { AppError } from '../lib/app-error.js';
import { maskDocument } from '../lib/mask.js';
import { getStorage, publicFileUrl, signedUrlSeconds } from '../lib/storage.js';
import { parseValidationQueueQuery } from './provider-validations-policy.js';
import { findPendingProviderService, listPendingProvidersService } from './provider-validations.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(res, error) {
    if (error instanceof AppError) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
    }
    console.log(error.message); // só a mensagem: o erro do Prisma pode trazer dado do cadastro
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
}

// GET /api/v1/admin/provider-validations?providerType=&page=1&pageSize=20 (#398).
// Ordem no app.js: JWT do usuário → papel Administrador → este controller.
export async function listProviderValidationsController(req, res) {
    try {
        const { details, filters } = parseValidationQueueQuery(req.query);
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Parâmetros inválidos', details });
        }
        const result = await listPendingProvidersService(filters);
        return res.status(200).json({ ...result, items: result.items.map(toQueueItem) });
    } catch (error) {
        return sendError(res, error);
    }
}

// GET /api/v1/admin/provider-validations/:providerId (#398).
// [assunção] O registro de quem visualizou os documentos fica para depois da #396, que fecha a regra da LGPD.
export async function getProviderValidationController(req, res) {
    try {
        if (!UUID.test(req.params.providerId)) {
            throw new AppError('Parâmetros inválidos', 400, 'VALIDATION_ERROR', [{ field: 'providerId', message: 'UUID obrigatório' }]);
        }
        return res.status(200).json(await toDetail(await findPendingProviderService(req.params.providerId)));
    } catch (error) {
        return sendError(res, error);
    }
}

function toQueueItem(provider) {
    return {
        providerId: provider.id,
        providerType: provider.providerType,
        name: provider.name,
        submittedAt: provider.submittedAt,
        documentCount: provider._count.documents,
        photoCount: provider._count.photos,
    };
}

// Monta campo a campo: a chave dos documentos e o dono do cadastro nunca saem.
async function toDetail(provider) {
    const { address } = provider;
    // O prazo informado é o mesmo usado para assinar. O link é gerado a cada requisição, nunca guardado
    const expiresIn = signedUrlSeconds();
    return {
        providerId: provider.id,
        providerType: provider.providerType,
        name: provider.name,
        submittedAt: provider.submittedAt,
        cpfCnpjMasked: maskDocument(provider.cpfCnpj),
        description: provider.description,
        acceptedSpecies: provider.acceptedSpecies,
        acceptedSizes: provider.acceptedSizes,
        acceptedBreeds: provider.acceptedBreeds,
        capacity: provider.hotelDetail?.capacity ?? null,
        // [assunção] sem rua e sem número (minimização); o endereço completo entra se a #396 pedir para conferir o comprovante
        address: address && { city: address.city, state: address.state, neighborhood: address.neighborhood, zipCode: address.zipCode },
        photos: await Promise.all(provider.photos.map(async (photo) => ({ id: photo.id, url: await publicFileUrl(photo.url) }))),
        documents: await Promise.all(provider.documents.map(async (document) => ({
            id: document.id,
            type: document.type,
            url: await getStorage().signedUrl(document.storageKey, expiresIn),
            expiresIn,
        }))),
    };
}
