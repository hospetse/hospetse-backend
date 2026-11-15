import { isRealDate } from '../lib/date.js';
import { PET_SPECIES, PET_SIZES } from '../pets/pet-policy.js';
import { checkQueryFields, isSingleValue, parsePagination } from '../lib/query.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED = ['city', 'minPrice', 'maxPrice', 'startDate', 'endDate', 'petId', 'species', 'size', 'breed', 'page', 'pageSize'];

const isText = (value, max) => typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= max;
const toPrice = (value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);

// Filtros da busca de Hosts (GET /api/v1/hosts/search, #476), sem banco. Devolve todos os erros de uma vez em details;
// sem erro, os filtros já no formato do service (ausente = undefined, que não filtra).
export function parseSearchQuery(query) {
    const details = [];
    const invalid = (field, message) => details.push({ field, message });

    checkQueryFields(query, ALLOWED, invalid);
    // Valor repetido já recebeu o erro acima: daqui em diante conta como ausente
    const has = (field) => isSingleValue(query, field);
    const value = (field) => (has(field) ? query[field] : undefined);

    const city = value('city');
    if (city !== undefined && !isText(city, 100)) invalid('city', 'texto de 1 a 100 caracteres');

    const minPrice = has('minPrice') ? toPrice(value('minPrice')) : undefined;
    const maxPrice = has('maxPrice') ? toPrice(value('maxPrice')) : undefined;
    const priceOk = (price) => price === undefined || (Number.isFinite(price) && price >= 0);
    if (!priceOk(minPrice)) invalid('minPrice', 'número a partir de 0');
    if (!priceOk(maxPrice)) invalid('maxPrice', 'número a partir de 0');
    else if (maxPrice !== undefined && priceOk(minPrice) && minPrice !== undefined && maxPrice < minPrice) {
        invalid('maxPrice', 'não pode ser menor que minPrice');
    }

    const startDate = value('startDate');
    const endDate = value('endDate');
    if (has('startDate') && !has('endDate')) invalid('endDate', 'obrigatório junto com startDate');
    if (has('endDate') && !has('startDate')) invalid('startDate', 'obrigatório junto com endDate');
    // shortcut: "hoje" pelo dia em UTC, como na solicitação (#494); trocar junto se lá passar para o fuso de São Paulo
    const today = new Date().toISOString().slice(0, 10);
    if (has('startDate')) {
        if (!isRealDate(startDate)) invalid('startDate', 'data no formato YYYY-MM-DD');
        else if (startDate < today) invalid('startDate', 'não pode ser no passado');
    }
    if (has('endDate')) {
        if (!isRealDate(endDate)) invalid('endDate', 'data no formato YYYY-MM-DD');
        else if (isRealDate(startDate) && endDate <= startDate) invalid('endDate', 'deve ser depois de startDate');
    }

    const petId = value('petId');
    if (has('petId') && !UUID.test(petId ?? '')) invalid('petId', 'UUID obrigatório');
    // Com pet, espécie, porte e raça vêm dele: filtro manual junto seria ambíguo
    for (const field of ['species', 'size', 'breed']) {
        if (has('petId') && has(field)) invalid(field, 'não pode vir junto com petId');
    }
    const species = value('species');
    const size = value('size');
    const breed = value('breed');
    if (species !== undefined && !PET_SPECIES.includes(species)) invalid('species', `um de: ${PET_SPECIES.join(', ')}`);
    if (size !== undefined && !PET_SIZES.includes(size)) invalid('size', `um de: ${PET_SIZES.join(', ')}`);
    if (breed !== undefined && !isText(breed, 100)) invalid('breed', 'texto de 1 a 100 caracteres');

    const { page, pageSize } = parsePagination(query, invalid);

    if (details.length) return { details };
    return {
        details,
        filters: {
            city: city?.trim(),
            minPrice,
            maxPrice,
            startDate,
            endDate,
            petId,
            species,
            size,
            breed: breed?.trim(),
            page,
            pageSize,
        },
    };
}
