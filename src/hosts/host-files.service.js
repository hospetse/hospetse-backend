import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/app-error.js';
import { prisma } from '../lib/prisma.js';
import { detectFileType, getStorage } from '../lib/storage.js';
import { MAX_DOCUMENTS_PER_TYPE, MAX_PHOTOS } from './host-profile-policy.js';

const limitReached = (message) => new AppError(message, 409, 'FILE_LIMIT_REACHED');

// Arquivo só entra em rascunho do próprio usuário: depois de enviado para validação, o cadastro não muda.
async function findEditableDraft(user) {
    const provider = await prisma.provider.findUnique({ where: { userId: user.id }, select: { id: true, validationStatus: true } });
    if (!provider) throw new AppError('Cadastro de Host não encontrado', 404, 'NOT_FOUND');
    if (provider.validationStatus !== 'draft') throw new AppError('O cadastro já foi enviado para validação', 409, 'HOST_ALREADY_SUBMITTED');
    return provider;
}

// Envia ao bucket e grava no banco. Se o banco falhar, apaga o arquivo para não deixar órfão. O tipo salvo vem do conteúdo, não do cliente.
async function storeFile(key, buffer, createRow) {
    const storage = getStorage();
    await storage.upload(key, buffer, detectFileType(buffer));
    try {
        return await createRow();
    } catch (error) {
        await storage.remove(key).catch(() => {}); // a falha já vai para o log; o erro que importa é o do banco
        throw error;
    }
}

export async function addHostDocumentService(user, type, buffer) {
    const provider = await findEditableDraft(user);
    // shortcut: dois envios simultâneos podem passar do limite por um; aceitável para um cadastro de um usuário só.
    const count = await prisma.providerDocument.count({ where: { providerId: provider.id, type } });
    if (count >= MAX_DOCUMENTS_PER_TYPE) throw limitReached(`Limite de ${MAX_DOCUMENTS_PER_TYPE} arquivos por tipo de documento`);

    const storageKey = `documents/${provider.id}/${randomUUID()}`;
    return storeFile(storageKey, buffer, () => prisma.providerDocument.create({
        data: { providerId: provider.id, type, storageKey },
        select: { id: true, type: true },
    }));
}

export async function addHostPhotoService(user, buffer) {
    const provider = await findEditableDraft(user);
    const count = await prisma.providerPhoto.count({ where: { providerId: provider.id } });
    if (count >= MAX_PHOTOS) throw limitReached(`Limite de ${MAX_PHOTOS} fotos`);

    const url = `photos/${provider.id}/${randomUUID()}`;
    return storeFile(url, buffer, () => prisma.providerPhoto.create({
        data: { providerId: provider.id, url },
        select: { id: true, url: true },
    }));
}

// Só o titular recebe o link. Documento de outro usuário responde igual ao inexistente, para não revelar que existe.
// O acesso do Administrador entra com o fluxo de validação.
export async function hostDocumentLinkService(user, documentId) {
    const document = await prisma.providerDocument.findFirst({
        where: { id: documentId, provider: { userId: user.id } },
        select: { storageKey: true },
    });
    if (!document) throw new AppError('Documento não encontrado', 404, 'NOT_FOUND');
    return getStorage().signedUrl(document.storageKey);
}
