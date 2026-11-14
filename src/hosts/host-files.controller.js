import { AppError } from '../lib/app-error.js';
import { fileProblem, publicFileUrl } from '../lib/storage.js';
import { DOCUMENT_TYPES } from './host-profile-policy.js';
import { addHostDocumentService, addHostPhotoService, hostDocumentLinkService } from './host-files.service.js';

// O id vai para uma coluna UUID: texto em outro formato faria o Prisma lançar erro (500), então já responde 404
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(res, error) {
    if (error instanceof AppError) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
    }
    console.log(error.message);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
}

function checkFile(kind, file, invalid) {
    if (!file) return invalid('file', 'obrigatório');
    const problem = fileProblem(kind, file.buffer);
    if (problem) invalid('file', problem);
}

// POST /api/v1/me/host/documents (#325): um arquivo por requisição, para o app mostrar progresso e tentar de novo só o que falhou.
export async function addHostDocumentController(req, res) {
    try {
        const details = [];
        const invalid = (field, message) => details.push({ field, message });
        const type = req.body?.type;
        if (!DOCUMENT_TYPES.includes(type)) invalid('type', `um de: ${DOCUMENT_TYPES.join(', ')}`);
        checkFile('document', req.file, invalid);
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details });
        }
        return res.status(201).json(await addHostDocumentService(req.user, type, req.file.buffer));
    } catch (error) {
        return sendError(res, error);
    }
}

// POST /api/v1/me/host/photos (#325)
export async function addHostPhotoController(req, res) {
    try {
        const details = [];
        checkFile('photo', req.file, (field, message) => details.push({ field, message }));
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details });
        }
        const photo = await addHostPhotoService(req.user, req.file.buffer);
        return res.status(201).json({ id: photo.id, url: await publicFileUrl(photo.url) });
    } catch (error) {
        return sendError(res, error);
    }
}

// GET /api/v1/me/host/documents/:id (#325): link temporário do documento, só para o titular.
export async function hostDocumentLinkController(req, res) {
    try {
        if (!UUID.test(req.params.id)) throw new AppError('Documento não encontrado', 404, 'NOT_FOUND');
        return res.status(200).json({ url: await hostDocumentLinkService(req.user, req.params.id) });
    } catch (error) {
        return sendError(res, error);
    }
}
