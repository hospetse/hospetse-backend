import { addressProblems, normalizeAddress } from '../lib/address.js';
import { isValidCnpj } from '../lib/cnpj.js';
import { isValidCpf } from '../lib/cpf.js';
import { PET_SIZES, PET_SPECIES } from '../pets/pet-policy.js';

export const HOST_TYPES = ['hotel'];
export const CARE_TYPES = ['pet_sitter', 'pet_walker'];

// Mesmos valores do CHECK de provider_documents.type (#323)
export const DOCUMENT_TYPES = ['identity', 'proof_of_address', 'cnpj_card'];
export const CARE_DOCUMENT_TYPES = [...DOCUMENT_TYPES, 'qualification'];
export const MAX_DOCUMENTS_PER_TYPE = 5;
export const MAX_PHOTOS = 10;
// [assunção] teto só para barrar valor absurdo; o card não define
export const MAX_CAPACITY = 1000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.trim().length <= max;
const isCnpj = (cpfCnpj) => cpfCnpj?.length === 14;

function listProblem(field, value, allowed, invalid) {
    if (!Array.isArray(value)) return invalid(field, 'deve ser uma lista');
    if (value.some((item) => !allowed(item))) invalid(field, 'tem valor inválido');
}

// Valida o PUT do rascunho e devolve os dados no formato gravado. Campo omitido fica como está; só name e providerType são sempre exigidos.
function parseDraft(body, allowedTypes) {
    const { providerType, name, description, cpfCnpj, address, capacity, personType, administersMedication, experienceRange, kilometerRadius, acceptedSpecies, acceptedSizes, acceptedBreeds, ...extra } = body ?? {};
    const care = allowedTypes === CARE_TYPES;

    const details = [];
    const invalid = (field, message) => details.push({ field, message });

    if (!allowedTypes.includes(providerType)) invalid('providerType', `um de: ${allowedTypes.join(', ')}`);
    if (!isText(name, 255)) invalid('name', 'obrigatório, até 255 caracteres');
    if (description != null && !isText(description, 2000)) invalid('description', 'até 2000 caracteres');

    // Nunca devolve o valor recebido: CPF e CNPJ não voltam na resposta
    const cleanCpfCnpj = typeof cpfCnpj === 'string' ? cpfCnpj.replace(/[./-]/g, '') : cpfCnpj;
    const cpfCnpjIsValid = isValidCpf(cleanCpfCnpj) || isValidCnpj(cleanCpfCnpj);
    if (cleanCpfCnpj != null && !cpfCnpjIsValid) invalid('cpfCnpj', 'CPF ou CNPJ inválido');

    if (address !== undefined) {
        if (isObject(address)) addressProblems(address, invalid);
        else invalid('address', 'deve ter todos os campos do endereço');
    }

    if (!care && capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY)) {
        invalid('capacity', `inteiro de 1 a ${MAX_CAPACITY}`);
    }
    if (care) {
        if (capacity !== undefined) invalid('capacity', 'não faz parte do contrato');
        if (personType !== undefined && !['pf', 'pj'].includes(personType)) invalid('personType', 'um de: pf, pj');
        if (personType && cpfCnpjIsValid && (personType === 'pf') !== (cleanCpfCnpj.length === 11)) invalid('cpfCnpj', 'incompatível com personType');
        if (administersMedication !== undefined && typeof administersMedication !== 'boolean') invalid('administersMedication', 'deve ser booleano');
        if (experienceRange !== undefined && !['lt_1', '1_3', 'gt_3'].includes(experienceRange)) invalid('experienceRange', 'um de: lt_1, 1_3, gt_3');
        if (kilometerRadius !== undefined && (typeof kilometerRadius !== 'number' || !Number.isFinite(kilometerRadius) || kilometerRadius <= 0 || kilometerRadius > 9999.99 || !/^\d+(\.\d{1,2})?$/.test(String(kilometerRadius)))) invalid('kilometerRadius', 'número maior que 0, até 9999,99, com até 2 casas decimais');
    } else {
        for (const field of ['personType', 'administersMedication', 'experienceRange', 'kilometerRadius']) {
            if ({ personType, administersMedication, experienceRange, kilometerRadius }[field] !== undefined) invalid(field, 'não faz parte do contrato');
        }
    }

    if (acceptedSpecies !== undefined) listProblem('acceptedSpecies', acceptedSpecies, (item) => PET_SPECIES.includes(item), invalid);
    if (acceptedSizes !== undefined) listProblem('acceptedSizes', acceptedSizes, (item) => PET_SIZES.includes(item), invalid);
    if (acceptedBreeds !== undefined) listProblem('acceptedBreeds', acceptedBreeds, (item) => isText(item, 100), invalid);

    for (const field of Object.keys(extra)) invalid(field, 'não faz parte do contrato');

    // cpfCnpj sai mesmo com outros erros, para o controller conferir o duplicado e devolver tudo junto
    const validCpfCnpj = cpfCnpjIsValid ? cleanCpfCnpj : undefined;
    if (details.length) return { details, validCpfCnpj };
    return {
        details,
        validCpfCnpj,
        data: {
            providerType,
            name: name.trim(),
            description: description === undefined ? undefined : description?.trim() ?? null,
            cpfCnpj: cleanCpfCnpj,
            capacity,
            personType: care ? personType : undefined,
            administersMedication: care ? administersMedication : undefined,
            experienceRange: care ? experienceRange : undefined,
            kilometerRadius: care ? kilometerRadius : undefined,
            acceptedSpecies,
            acceptedSizes,
            acceptedBreeds: acceptedBreeds?.map((breed) => breed.trim()),
            address: address && normalizeAddress(address),
        },
    };
}

export const parseHostDraft = (body) => parseDraft(body, HOST_TYPES);
export const parseCareDraft = (body) => parseDraft(body, CARE_TYPES);

// O que falta para o rascunho ir à validação. provider vem com address, hotelDetail, documents e photos.
export function submissionProblems(provider) {
    const details = [];
    const invalid = (field, message) => details.push({ field, message });
    const documentTypes = provider.documents.map((document) => document.type);
    const requireDocument = (type) => {
        if (!documentTypes.includes(type)) invalid(`documents.${type}`, 'obrigatório');
    };

    if (!provider.description) invalid('description', 'obrigatório');
    if (!provider.cpfCnpj) invalid('cpfCnpj', 'obrigatório');
    if (!provider.address) invalid('address', 'obrigatório');
    if (!CARE_TYPES.includes(provider.providerType) && !provider.hotelDetail?.capacity) invalid('capacity', 'obrigatório');
    if (CARE_TYPES.includes(provider.providerType)) {
        if (!provider.personType) invalid('personType', 'obrigatório');
        if (provider.personType && provider.cpfCnpj && (provider.personType === 'pf') !== (provider.cpfCnpj.length === 11)) invalid('cpfCnpj', 'incompatível com personType');
        if (provider.administersMedication === null) invalid('administersMedication', 'obrigatório');
        if (!provider.experienceRange) invalid('experienceRange', 'obrigatório');
        const radius = provider.providerType === 'pet_sitter' ? provider.petSitterDetail?.kilometerRadius : provider.petWalkerDetail?.kilometerRadius;
        if (!radius || Number(radius) <= 0) invalid('kilometerRadius', 'obrigatório');
    }
    if (!provider.acceptedSpecies.length) invalid('acceptedSpecies', 'escolha ao menos uma espécie');
    if (!provider.acceptedSizes.length) invalid('acceptedSizes', 'escolha ao menos um porte');
    if (!provider.photos.length) invalid('photos', 'envie ao menos uma foto');

    // shortcut: lista provisória, a #321 que a aprovaria foi removida; revisar com a PO.
    requireDocument('identity');
    requireDocument('proof_of_address');
    if (isCnpj(provider.cpfCnpj)) requireDocument('cnpj_card');

    return details;
}
