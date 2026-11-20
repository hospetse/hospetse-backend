import { AppError } from '../lib/app-error.js';
import { maskDocument } from '../lib/mask.js';
import { publicFileUrl } from '../lib/storage.js';
import { parseCareDraft, parseHostDraft } from './host-profile-policy.js';
import { findCareProfileService, findHostProfileService, isCpfCnpjTaken, saveCareDraftService, saveHostDraftService, submitCareProfileService, submitHostProfileService } from './host-profile.service.js';

function sendError(res, error) {
    if (error instanceof AppError) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
    }
    console.log(error.message); // só a mensagem: o erro do Prisma pode trazer o CPF ou o CNPJ
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
}

// Só o titular vê o próprio endereço. CPF ou CNPJ volta mascarado (LGPD); a chave dos documentos nunca sai.
async function toResponse(provider, care = false) {
    const { address } = provider;
    return {
        id: provider.id,
        validationStatus: provider.validationStatus,
        // Motivo da reprovação do Administrador (#404); null fora de rejected
        rejectionReason: provider.validationStatus === 'rejected' ? provider.rejectionReason : null,
        providerType: provider.providerType,
        name: provider.name,
        description: provider.description,
        cpfCnpjMasked: maskDocument(provider.cpfCnpj),
        address: address && {
            zipCode: address.zipCode,
            street: address.street,
            number: address.number,
            complement: address.complement,
            neighborhood: address.neighborhood,
            city: address.city,
            state: address.state,
        },
        ...(care ? {
            personType: provider.personType,
            administersMedication: provider.administersMedication,
            experienceRange: provider.experienceRange,
            kilometerRadius: Number(provider.petSitterDetail?.kilometerRadius ?? provider.petWalkerDetail?.kilometerRadius) || null,
        } : { capacity: provider.hotelDetail?.capacity ?? null }),
        acceptedSpecies: provider.acceptedSpecies,
        acceptedSizes: provider.acceptedSizes,
        acceptedBreeds: provider.acceptedBreeds,
        documents: provider.documents,
        photos: await Promise.all(provider.photos.map(async (photo) => ({ id: photo.id, url: await publicFileUrl(photo.url) }))),
    };
}

// PUT /api/v1/me/host (HSP-PBI-008-TSK-05 #325): salva o rascunho. O Host vem só do JWT.
async function saveDraftController(req, res, parse, save, care) {
    try {
        const { details, data, validCpfCnpj } = parse(req.body);
        // Só consulta o banco se o documento é válido; o duplicado sai junto com os outros erros
        if (validCpfCnpj && await isCpfCnpjTaken(validCpfCnpj, req.user.id)) {
            details.push({ field: 'cpfCnpj', message: 'CPF ou CNPJ já cadastrado' });
        }
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details });
        }
        return res.status(200).json(await toResponse(await save(req.user, data), care));
    } catch (error) {
        return sendError(res, error);
    }
}
export const saveHostDraftController = (req, res) => saveDraftController(req, res, parseHostDraft, saveHostDraftService, false);
export const saveCareDraftController = (req, res) => saveDraftController(req, res, parseCareDraft, saveCareDraftService, true);

// GET /api/v1/me/host (#325): o app retoma o cadastro de onde parou e vê a situação da validação.
async function getProfileController(req, res, find, care) {
    try {
        return res.status(200).json(await toResponse(await find(req.user), care));
    } catch (error) {
        return sendError(res, error);
    }
}
export const getHostProfileController = (req, res) => getProfileController(req, res, findHostProfileService, false);
export const getCareProfileController = (req, res) => getProfileController(req, res, findCareProfileService, true);

// POST /api/v1/me/host/submit (#325): envia o rascunho para validação, sem body.
async function submitProfileController(req, res, submit, care) {
    try {
        return res.status(200).json(await toResponse(await submit(req.user), care));
    } catch (error) {
        return sendError(res, error);
    }
}
export const submitHostProfileController = (req, res) => submitProfileController(req, res, submitHostProfileService, false);
export const submitCareProfileController = (req, res) => {
    const fields = Object.keys(req.body ?? {});
    if (fields.length) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details: fields.map((field) => ({ field, message: 'não faz parte do contrato' })) });
    return submitProfileController(req, res, submitCareProfileService, true);
};
