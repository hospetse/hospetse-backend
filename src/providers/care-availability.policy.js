import { isRealDate } from '../lib/date.js';
import { checkQueryFields, isSingleValue, parsePagination } from '../lib/query.js';
import { PET_SIZES, PET_SPECIES } from '../pets/pet-policy.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100;
const price = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 99999999.99 && /^\d+(\.\d{1,2})?$/.test(String(value));

export function parseCareAvailability(body, providerType) {
    const details = [];
    const invalid = (field, message) => details.push({ field, message });
    const { serviceCity, serviceNeighborhoods, workingHours, price: amount, durationWalkMinutes, ...extra } = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (!text(serviceCity)) invalid('serviceCity', 'texto de 1 a 100 caracteres');
    if (!Array.isArray(serviceNeighborhoods)) invalid('serviceNeighborhoods', 'deve ser uma lista');
    else {
        const names = new Set();
        for (const [i, name] of serviceNeighborhoods.entries()) {
            if (!text(name)) invalid(`serviceNeighborhoods.${i}`, 'texto de 1 a 100 caracteres');
            else if (names.has(name.trim().toLowerCase())) invalid(`serviceNeighborhoods.${i}`, 'bairro repetido');
            else names.add(name.trim().toLowerCase());
        }
    }
    if (!Array.isArray(workingHours) || !workingHours.length) invalid('workingHours', 'informe ao menos um horário');
    else {
        for (const [i, hour] of workingHours.entries()) {
            if (!hour || typeof hour !== 'object' || Array.isArray(hour)) { invalid(`workingHours.${i}`, 'horário inválido'); continue; }
            if (!Number.isInteger(hour.dayOfWeek) || hour.dayOfWeek < 0 || hour.dayOfWeek > 6) invalid(`workingHours.${i}.dayOfWeek`, 'inteiro de 0 a 6');
            if (!TIME.test(hour.startTime)) invalid(`workingHours.${i}.startTime`, 'HH:mm obrigatório');
            if (!TIME.test(hour.endTime) || (TIME.test(hour.startTime) && hour.endTime <= hour.startTime)) invalid(`workingHours.${i}.endTime`, 'deve ser depois de startTime');
            for (const field of Object.keys(hour).filter((field) => !['dayOfWeek', 'startTime', 'endTime'].includes(field))) invalid(`workingHours.${i}.${field}`, 'não faz parte do contrato');
        }
        if (!details.some(({ field }) => field.startsWith('workingHours.'))) {
            const sorted = [...workingHours].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
            for (let i = 1; i < sorted.length; i++) {
                if (sorted[i].dayOfWeek === sorted[i - 1].dayOfWeek && sorted[i].startTime < sorted[i - 1].endTime) {
                    invalid('workingHours', 'horários do mesmo dia não podem se sobrepor');
                    break;
                }
            }
        }
    }
    if (!price(amount)) invalid('price', 'valor positivo com até 2 casas decimais');
    if (providerType === 'pet_walker') {
        if (!Number.isInteger(durationWalkMinutes) || durationWalkMinutes < 1 || durationWalkMinutes > 1440) invalid('durationWalkMinutes', 'inteiro de 1 a 1440');
    } else if (durationWalkMinutes !== undefined) invalid('durationWalkMinutes', 'não faz parte do contrato para Pet Sitter');
    for (const field of Object.keys(extra)) invalid(field, 'não faz parte do contrato');
    return { details, data: details.length ? undefined : {
        serviceCity: serviceCity.trim(), serviceNeighborhoods: serviceNeighborhoods.map((name) => name.trim()),
        workingHours, price: amount, durationWalkMinutes,
    } };
}

export function parseCareSearch(query) {
    const details = [];
    const invalid = (field, message) => details.push({ field, message });
    const allowed = ['providerType', 'city', 'neighborhood', 'date', 'startTime', 'endTime', 'minPrice', 'maxPrice', 'petId', 'species', 'size', 'breed', 'page', 'pageSize'];
    checkQueryFields(query, allowed, invalid);
    const value = (field) => isSingleValue(query, field) ? query[field] : undefined;
    const providerType = value('providerType');
    const city = value('city');
    const neighborhood = value('neighborhood');
    if (!['pet_sitter', 'pet_walker'].includes(providerType)) invalid('providerType', 'pet_sitter ou pet_walker');
    if (!text(city)) invalid('city', 'texto de 1 a 100 caracteres');
    if (neighborhood !== undefined && !text(neighborhood)) invalid('neighborhood', 'texto de 1 a 100 caracteres');
    const date = value('date');
    const startTime = value('startTime');
    const endTime = value('endTime');
    if ([date, startTime, endTime].some((item) => item !== undefined)) {
        if (!isRealDate(date) || date < new Date().toISOString().slice(0, 10)) invalid('date', 'data válida a partir de hoje');
        if (!TIME.test(startTime)) invalid('startTime', 'HH:mm obrigatório');
        if (!TIME.test(endTime) || (TIME.test(startTime) && endTime <= startTime)) invalid('endTime', 'deve ser depois de startTime');
    }
    const minPrice = value('minPrice') === undefined ? undefined : Number(value('minPrice'));
    const maxPrice = value('maxPrice') === undefined ? undefined : Number(value('maxPrice'));
    for (const [field, amount] of [['minPrice', minPrice], ['maxPrice', maxPrice]]) {
        if (amount !== undefined && (!Number.isFinite(amount) || amount < 0 || value(field) === '')) invalid(field, 'número a partir de 0');
    }
    if (maxPrice !== undefined && minPrice !== undefined && maxPrice < minPrice) invalid('maxPrice', 'não pode ser menor que minPrice');
    const petId = value('petId');
    if (petId !== undefined && !UUID.test(petId)) invalid('petId', 'UUID obrigatório');
    const species = value('species');
    const size = value('size');
    const breed = value('breed');
    for (const field of ['species', 'size', 'breed']) if (petId !== undefined && value(field) !== undefined) invalid(field, 'não pode vir junto com petId');
    if (species !== undefined && !PET_SPECIES.includes(species)) invalid('species', `um de: ${PET_SPECIES.join(', ')}`);
    if (size !== undefined && !PET_SIZES.includes(size)) invalid('size', `um de: ${PET_SIZES.join(', ')}`);
    if (breed !== undefined && !text(breed)) invalid('breed', 'texto de 1 a 100 caracteres');
    const { page, pageSize } = parsePagination(query, invalid);
    return { details, filters: details.length ? undefined : {
        providerType, city: city.trim(), neighborhood: neighborhood?.trim(), date, startTime, endTime, minPrice, maxPrice,
        petId, species, size, breed: breed?.trim(), page, pageSize,
    } };
}

export function parseCareAvailabilityQuery(query) {
    const details = [];
    for (const field of Object.keys(query).filter((field) => field !== 'date')) details.push({ field, message: 'não faz parte do contrato' });
    const date = isSingleValue(query, 'date') ? query.date : undefined;
    if (query.date !== undefined && (!isRealDate(date))) details.push({ field: 'date', message: 'data no formato YYYY-MM-DD' });
    return { details, date };
}
