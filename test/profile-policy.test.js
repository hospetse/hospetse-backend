import { test } from 'node:test';
import assert from 'node:assert';
import { assertCanContract, canContract, contractDenial, isAdult, missingFields } from '../src/users/profile-policy.js';

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

test('contratação: perfil incompleto bloqueia com PROFILE_INCOMPLETE', () => {
    const denial = contractDenial({ status: 'pending', profileStatus: 'incomplete' });
    assert.strictEqual(denial.statusCode, 403);
    assert.strictEqual(denial.code, 'PROFILE_INCOMPLETE');
    assert.strictEqual(denial.message, 'Complete seu perfil antes de contratar um serviço.');
});

test('contratação: conta suspensa ou bloqueada vem antes do perfil', () => {
    assert.strictEqual(contractDenial({ status: 'suspended', profileStatus: 'incomplete' }).code, 'ACCOUNT_RESTRICTED');
    assert.strictEqual(contractDenial({ status: 'blocked', profileStatus: 'complete' }).code, 'ACCOUNT_RESTRICTED');
});

test('contratação: perfil completo com conta active ou pending pode contratar', () => {
    assert.strictEqual(contractDenial({ status: 'active', profileStatus: 'complete' }), null);
    assert.strictEqual(canContract({ status: 'pending', profileStatus: 'complete' }), true);
    assert.strictEqual(canContract({ status: 'pending', profileStatus: 'incomplete' }), false);
});

test('contratação: a camada de service lança o mesmo erro da guarda', () => {
    assert.throws(() => assertCanContract({ status: 'blocked', profileStatus: 'complete' }), { statusCode: 403, code: 'ACCOUNT_RESTRICTED' });
    assert.doesNotThrow(() => assertCanContract({ status: 'active', profileStatus: 'complete' }));
});
