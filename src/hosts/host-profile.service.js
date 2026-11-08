import { AppError } from '../lib/app-error.js';
import { prisma } from '../lib/prisma.js';
import { submissionProblems } from './host-profile-policy.js';

const notFound = () => new AppError('Cadastro de Host não encontrado', 404, 'NOT_FOUND');
const alreadySubmitted = () => new AppError('O cadastro já foi enviado para validação', 409, 'HOST_ALREADY_SUBMITTED');
const cpfCnpjTaken = { field: 'cpfCnpj', message: 'CPF ou CNPJ já cadastrado' };

// storage_key fica de fora: documento só sai por link assinado
const PROFILE_INCLUDE = {
    address: true,
    hotelDetail: { select: { capacity: true } },
    documents: { select: { id: true, type: true }, orderBy: { createdAt: 'asc' } },
    photos: { select: { id: true, url: true }, orderBy: { createdAt: 'asc' } },
};

// Chamado pelo controller na validação, para o duplicado sair junto com os outros erros. O próprio documento do usuário não conta.
export async function isCpfCnpjTaken(cpfCnpj, userId) {
    const owner = await prisma.provider.findUnique({ where: { cpfCnpj }, select: { userId: true } });
    return owner != null && owner.userId !== userId;
}

export async function findHostProfileService(user) {
    const provider = await prisma.provider.findUnique({ where: { userId: user.id }, include: PROFILE_INCLUDE });
    if (!provider) throw notFound();
    return provider;
}

// Rascunho do cadastro: a primeira chamada cria o Provider e as seguintes atualizam. O dono vem só do JWT.
export async function saveHostDraftService(user, { address, capacity, ...data }) {
    try {
        return await prisma.$transaction(async (tx) => {
            // Lido dentro da transação para não decidir com o estado antigo do req.user
            const current = await tx.provider.findUnique({
                where: { userId: user.id },
                select: { id: true, addressId: true, validationStatus: true },
            });
            if (current && current.validationStatus !== 'draft') throw alreadySubmitted();

            let addressId;
            if (address) {
                const saved = current?.addressId
                    ? await tx.address.update({ where: { id: current.addressId }, data: address })
                    : await tx.address.create({ data: address });
                addressId = saved.id;
            }

            // A capacidade fica em hotel_details; omitida, não muda
            if (current) {
                const hotelDetail = capacity === undefined ? undefined : { upsert: { create: { capacity }, update: { capacity } } };
                return tx.provider.update({ where: { id: current.id }, data: { ...data, addressId, hotelDetail }, include: PROFILE_INCLUDE });
            }
            const hotelDetail = capacity === undefined ? undefined : { create: { capacity } };
            return tx.provider.create({
                data: { ...data, addressId, hotelDetail, userId: user.id, validationStatus: 'draft' },
                include: PROFILE_INCLUDE,
            });
        });
    } catch (error) {
        if (error.code !== 'P2002') throw error;
        // O UNIQUE é a garantia final: outro usuário gravou o mesmo documento, ou houve dois primeiros envios ao mesmo tempo
        if (String(error.meta?.target).includes('cpf')) {
            throw new AppError('Payload inválido', 400, 'VALIDATION_ERROR', [cpfCnpjTaken]);
        }
        throw new AppError('O cadastro foi alterado ao mesmo tempo. Tente novamente', 409, 'HOST_DRAFT_CONFLICT');
    }
}

// Envia o rascunho para validação. Devolve todos os erros de uma vez e, se houver algum, nada muda.
export async function submitHostProfileService(user) {
    const provider = await findHostProfileService(user);
    if (provider.validationStatus !== 'draft') throw alreadySubmitted();

    const details = submissionProblems(provider);
    if (details.length) throw new AppError('Cadastro incompleto', 400, 'VALIDATION_ERROR', details);

    // A primeira foto vira a principal, que é a que a busca mostra
    const urlPicture = provider.photos[0].url;
    // Filtrar por draft impede que dois envios simultâneos passem
    const { count } = await prisma.provider.updateMany({
        where: { id: provider.id, validationStatus: 'draft' },
        data: { validationStatus: 'pending', urlPicture },
    });
    if (count === 0) throw alreadySubmitted();

    return { ...provider, validationStatus: 'pending', urlPicture };
}
