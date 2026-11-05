import { addressProblems, normalizeAddress } from '../lib/address.js';
import { isValidCnpj } from '../lib/cnpj.js';
import { isValidCpf } from '../lib/cpf.js';
import { PET_SIZES, PET_SPECIES } from '../pets/pet-policy.js';

// shortcut: só hospedagem, único tipo que a busca mostra; abrir para pet_sitter e pet_walker quando houver fluxo deles.
export const HOST_TYPES = ['hotel'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.trim().length <= max;
const isCnpj = (cpfCnpj) => cpfCnpj?.length === 14;

function listProblem(field, value, allowed, invalid) {
    if (!Array.isArray(value)) return invalid(field, 'deve ser uma lista');
    if (value.some((item) => !allowed(item))) invalid(field, 'tem valor inválido');
}

// Valida o PUT do rascunho e devolve os dados no formato gravado. Campo omitido fica como está; só name e providerType são sempre exigidos.
export function parseHostDraft(body) {
    const { providerType, name, description, cpfCnpj, address, acceptedSpecies, acceptedSizes, acceptedBreeds, ...extra } = body ?? {};

    const details = [];
    const invalid = (field, message) => details.push({ field, message });

    if (!HOST_TYPES.includes(providerType)) invalid('providerType', `um de: ${HOST_TYPES.join(', ')}`);
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
            acceptedSpecies,
            acceptedSizes,
            acceptedBreeds: acceptedBreeds?.map((breed) => breed.trim()),
            address: address && normalizeAddress(address),
        },
    };
}

// O que falta para o rascunho ir à validação. provider vem com address, documents e photos.
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
    if (!provider.acceptedSpecies.length) invalid('acceptedSpecies', 'escolha ao menos uma espécie');
    if (!provider.acceptedSizes.length) invalid('acceptedSizes', 'escolha ao menos um porte');
    if (!provider.photos.length) invalid('photos', 'envie ao menos uma foto');

    // shortcut: lista provisória, a #321 que a aprovaria foi removida; revisar com a PO.
    requireDocument('identity');
    requireDocument('proof_of_address');
    if (isCnpj(provider.cpfCnpj)) requireDocument('cnpj_card');

    return details;
}
