import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCareAvailability, parseCareSearch } from '../src/providers/care-availability.policy.js';

const valid = () => ({ serviceCity: 'São Paulo', serviceNeighborhoods: ['Centro'], workingHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }], price: 50 });
const fields = (result) => result.details.map((item) => item.field);

test('Sitter configura cidade, bairros, horários e preço; Walker também informa duração', () => {
    assert.deepEqual(parseCareAvailability(valid(), 'pet_sitter').details, []);
    assert.deepEqual(parseCareAvailability({ ...valid(), price: 0.29 }, 'pet_sitter').details, []);
    assert.deepEqual(fields(parseCareAvailability({ ...valid(), price: 0.001 }, 'pet_sitter')), ['price']);
    assert.deepEqual(fields(parseCareAvailability(valid(), 'pet_walker')), ['durationWalkMinutes']);
    assert.deepEqual(parseCareAvailability({ ...valid(), durationWalkMinutes: 60 }, 'pet_walker').details, []);
});

test('campos inválidos saem juntos, incluindo horário sobreposto e identidade do cliente', () => {
    const result = parseCareAvailability({ ...valid(), serviceCity: '', serviceNeighborhoods: ['Centro', 'centro'],
        workingHours: [{ dayOfWeek: 1, startTime: '10:00', endTime: '09:00' }], price: -1, userId: 'outro', durationWalkMinutes: 0,
    }, 'pet_walker');
    assert.deepEqual(fields(result), ['serviceCity', 'serviceNeighborhoods.1', 'workingHours.0.endTime', 'price', 'durationWalkMinutes', 'userId']);
    assert.deepEqual(fields(parseCareAvailability({ ...valid(), workingHours: [
        { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }, { dayOfWeek: 1, startTime: '11:00', endTime: '13:00' },
    ] }, 'pet_sitter')), ['workingHours']);
});

test('busca exige tipo, cidade e intervalo completo quando a data é informada', () => {
    assert.deepEqual(fields(parseCareSearch({ providerType: 'hotel', city: '', date: '2030-01-07', startTime: '10:00', maxPrice: '-1', userId: 'outro' })),
        ['userId', 'providerType', 'city', 'endTime', 'maxPrice']);
    assert.deepEqual(parseCareSearch({ providerType: 'pet_sitter', city: 'São Paulo' }).details, []);
});
