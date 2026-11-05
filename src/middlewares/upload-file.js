import multer from 'multer';
import { FILE_RULES, fileTooLargeMessage } from '../lib/storage.js';

// Lê um arquivo por requisição, no campo "file", para req.file. Roda depois do requireUser: sem token, nada é lido.
// Em memória porque o limite é pequeno; o conteúdo só é conferido no controller.
export function uploadFile(kind) {
    const parse = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: FILE_RULES[kind].maxBytes, files: 1, fields: 1 },
    }).single('file');

    return (req, res, next) => parse(req, res, (error) => {
        if (!error) return next();
        const message = error.code === 'LIMIT_FILE_SIZE' ? fileTooLargeMessage(kind) : 'Envie um único arquivo no campo file';
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details: [{ field: 'file', message }] });
    });
}
