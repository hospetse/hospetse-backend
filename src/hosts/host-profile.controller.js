import { AppError } from '../lib/app-error.js';
import { maskDocument } from '../lib/mask.js';
import { publicFileUrl } from '../lib/storage.js';
import { parseHostDraft } from './host-profile-policy.js';
import { findHostProfileService, isCpfCnpjTaken, saveHostDraftService, submitHostProfileService } from './host-profile.service.js';

function sendError(res, error) {
    if (error instanceof AppError) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
    }
    console.log(error.message); // só a mensagem: o erro do Prisma pode trazer o CPF ou o CNPJ
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
}

// Só o titular vê o próprio endereço. CPF ou CNPJ volta mascarado (LGPD); a chave dos documentos nunca sai.
async function toResponse(provider) {
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
        capacity: provider.hotelDetail?.capacity ?? null,
        acceptedSpecies: provider.acceptedSpecies,
        acceptedSizes: provider.acceptedSizes,
        acceptedBreeds: provider.acceptedBreeds,
        documents: provider.documents,
        photos: await Promise.all(provider.photos.map(async (photo) => ({ id: photo.id, url: await publicFileUrl(photo.url) }))),
    };
}

// PUT /api/v1/me/host (HSP-PBI-008-TSK-05 #325): salva o rascunho. O Host vem só do JWT.
export async function saveHostDraftController(req, res) {
    try {
        const { details, data, validCpfCnpj } = parseHostDraft(req.body);
        // Só consulta o banco se o documento é válido; o duplicado sai junto com os outros erros
        if (validCpfCnpj && await isCpfCnpjTaken(validCpfCnpj, req.user.id)) {
            details.push({ field: 'cpfCnpj', message: 'CPF ou CNPJ já cadastrado' });
        }
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details });
        }
        return res.status(200).json(await toResponse(await saveHostDraftService(req.user, data)));
    } catch (error) {
        return sendError(res, error);
    }
}

// GET /api/v1/me/host (#325): o app retoma o cadastro de onde parou e vê a situação da validação.
export async function getHostProfileController(req, res) {
    try {
        return res.status(200).json(await toResponse(await findHostProfileService(req.user)));
    } catch (error) {
        return sendError(res, error);
    }
}

// POST /api/v1/me/host/submit (#325): envia o rascunho para validação, sem body.
export async function submitHostProfileController(req, res) {
    try {
        return res.status(200).json(await toResponse(await submitHostProfileService(req.user)));
    } catch (error) {
        return sendError(res, error);
    }
}
