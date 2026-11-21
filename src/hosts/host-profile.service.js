import { AppError } from '../lib/app-error.js';
import { prisma } from '../lib/prisma.js';
import { CARE_TYPES, HOST_TYPES, submissionProblems } from './host-profile-policy.js';

const notFound = () => new AppError('Cadastro de Host não encontrado', 404, 'NOT_FOUND');
const alreadySubmitted = () => new AppError('O cadastro já foi enviado para validação', 409, 'HOST_ALREADY_SUBMITTED');
const careNotFound = () => new AppError('Cadastro de prestador não encontrado', 404, 'NOT_FOUND');
const careAlreadySubmitted = () => new AppError('O cadastro já foi enviado para validação', 409, 'PROVIDER_ALREADY_SUBMITTED');
const cpfCnpjTaken = { field: 'cpfCnpj', message: 'CPF ou CNPJ já cadastrado' };

// storage_key fica de fora: documento só sai por link assinado
const PROFILE_INCLUDE = {
    address: true,
    hotelDetail: { select: { capacity: true } },
    petSitterDetail: { select: { kilometerRadius: true } },
    petWalkerDetail: { select: { kilometerRadius: true } },
    documents: { select: { id: true, type: true }, orderBy: { createdAt: 'asc' } },
    photos: { select: { id: true, url: true }, orderBy: { createdAt: 'asc' } },
};

// Chamado pelo controller na validação, para o duplicado sair junto com os outros erros. O próprio documento do usuário não conta.
export async function isCpfCnpjTaken(cpfCnpj, userId) {
    const owner = await prisma.provider.findUnique({ where: { cpfCnpj }, select: { userId: true } });
    return owner != null && owner.userId !== userId;
}

async function findProfile(user, allowedTypes) {
    const provider = await prisma.provider.findUnique({ where: { userId: user.id }, include: PROFILE_INCLUDE });
    if (!provider || !allowedTypes.includes(provider.providerType)) throw allowedTypes === HOST_TYPES ? notFound() : careNotFound();
    return provider;
}
export const findHostProfileService = (user) => findProfile(user, HOST_TYPES);
export const findCareProfileService = (user) => findProfile(user, CARE_TYPES);

// Rascunho do cadastro: a primeira chamada cria o Provider e as seguintes atualizam. O dono vem só do JWT.
async function saveDraft(user, { address, capacity, kilometerRadius, ...data }, allowedTypes) {
    try {
        return await prisma.$transaction(async (tx) => {
            // Lido dentro da transação para não decidir com o estado antigo do req.user
            const current = await tx.provider.findUnique({
                where: { userId: user.id },
                select: { id: true, addressId: true, validationStatus: true, providerType: true, cpfCnpj: true, personType: true },
            });
            if (current && !allowedTypes.includes(current.providerType)) throw new AppError('Já existe cadastro de outro tipo', 409, 'PROVIDER_TYPE_CONFLICT');
            if (current && current.providerType !== data.providerType) throw new AppError('O tipo do prestador não pode mudar', 409, 'PROVIDER_TYPE_CONFLICT');
            if (current && current.validationStatus !== 'draft') throw allowedTypes === HOST_TYPES ? alreadySubmitted() : careAlreadySubmitted();
            const personType = data.personType ?? current?.personType;
            const cpfCnpj = data.cpfCnpj === undefined ? current?.cpfCnpj : data.cpfCnpj;
            if (allowedTypes === CARE_TYPES && personType && cpfCnpj && (personType === 'pf') !== (cpfCnpj.length === 11)) {
                throw new AppError('Payload inválido', 400, 'VALIDATION_ERROR', [{ field: 'cpfCnpj', message: 'incompatível com personType' }]);
            }

            let addressId;
            if (address) {
                const saved = current?.addressId
                    ? await tx.address.update({ where: { id: current.addressId }, data: address })
                    : await tx.address.create({ data: address });
                addressId = saved.id;
            }

            const detail = kilometerRadius === undefined ? undefined : { upsert: { create: { kilometerRadius }, update: { kilometerRadius } } };
            const careDetail = data.providerType === 'pet_sitter' ? { petSitterDetail: detail } : { petWalkerDetail: detail };
            // Capacidade e raio ficam nos detalhes específicos; campo omitido não muda.
            if (current) {
                const hotelDetail = capacity === undefined ? undefined : { upsert: { create: { capacity }, update: { capacity } } };
                return tx.provider.update({ where: { id: current.id }, data: { ...data, addressId, hotelDetail, ...(allowedTypes === CARE_TYPES ? careDetail : {}) }, include: PROFILE_INCLUDE });
            }
            const hotelDetail = capacity === undefined ? undefined : { create: { capacity } };
            const newCareDetail = kilometerRadius === undefined ? {} : data.providerType === 'pet_sitter'
                ? { petSitterDetail: { create: { kilometerRadius } } }
                : { petWalkerDetail: { create: { kilometerRadius } } };
            return tx.provider.create({
                data: { ...data, addressId, hotelDetail, ...newCareDetail, userId: user.id, validationStatus: 'draft' },
                include: PROFILE_INCLUDE,
            });
        });
    } catch (error) {
        if (error.code !== 'P2002') throw error;
        // O UNIQUE é a garantia final: outro usuário gravou o mesmo documento, ou houve dois primeiros envios ao mesmo tempo
        if (String(error.meta?.target).includes('cpf')) {
            throw new AppError('Payload inválido', 400, 'VALIDATION_ERROR', [cpfCnpjTaken]);
        }
        throw new AppError('O cadastro foi alterado ao mesmo tempo. Tente novamente', 409, allowedTypes === HOST_TYPES ? 'HOST_DRAFT_CONFLICT' : 'PROVIDER_DRAFT_CONFLICT');
    }
}
export const saveHostDraftService = (user, data) => saveDraft(user, data, HOST_TYPES);
export const saveCareDraftService = (user, data) => saveDraft(user, data, CARE_TYPES);

// Envia o rascunho para validação. Devolve todos os erros de uma vez e, se houver algum, nada muda.
async function submitProfile(user, allowedTypes) {
    const provider = await findProfile(user, allowedTypes);
    if (provider.validationStatus !== 'draft') throw allowedTypes === HOST_TYPES ? alreadySubmitted() : careAlreadySubmitted();

    const details = submissionProblems(provider);
    if (details.length) throw new AppError('Cadastro incompleto', 400, 'VALIDATION_ERROR', details);

    // A primeira foto vira a principal, que é a que a busca mostra
    const urlPicture = provider.photos[0].url;
    // Filtrar por draft impede que dois envios simultâneos passem
    const { count } = await prisma.provider.updateMany({
        where: { id: provider.id, validationStatus: 'draft' },
        data: { validationStatus: 'pending', urlPicture, submittedAt: new Date() },
    });
    if (count === 0) throw allowedTypes === HOST_TYPES ? alreadySubmitted() : careAlreadySubmitted();

    return { ...provider, validationStatus: 'pending', urlPicture };
}
export const submitHostProfileService = (user) => submitProfile(user, HOST_TYPES);
export const submitCareProfileService = (user) => submitProfile(user, CARE_TYPES);
