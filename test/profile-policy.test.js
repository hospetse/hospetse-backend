import { test } from 'node:test';
import assert from 'node:assert';
import { isAdult, missingFields } from '../src/users/profile-policy.js';

const completeTutor = {
    cpf: '52998224725',
    birthDate: new Date('1990-05-10'),
    phone: '11999999999',
    address: { zipCode: '01001000' },
    emergencyContactName: 'Maria',
    emergencyContactPhone: '11988888888',
};

test('USER sem Tutor: falta tudo', () => {
    assert.deepStrictEqual(missingFields({ tutor: null }), ['cpf', 'birthDate', 'phone', 'address', 'emergencyContact']);
});

test('Tutor completo: não falta nada', () => {
    assert.deepStrictEqual(missingFields({ tutor: completeTutor }), []);
});

test('contato de emergência pela metade conta como faltando', () => {
    const tutor = { ...completeTutor, emergencyContactPhone: null };
    assert.deepStrictEqual(missingFields({ tutor }), ['emergencyContact']);
});

test('isAdult: 18 anos completos só no dia do aniversário', () => {
    assert.strictEqual(isAdult('2008-10-28', '2026-10-27'), false);
    assert.strictEqual(isAdult('2008-10-28', '2026-10-28'), true);
});

test('isAdult: nascido em 29/02 faz 18 em 01/03 quando o ano não é bissexto', () => {
    assert.strictEqual(isAdult('2008-02-29', '2026-02-28'), false);
    assert.strictEqual(isAdult('2008-02-29', '2026-03-01'), true);
});
