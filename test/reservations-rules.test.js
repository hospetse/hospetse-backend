// Regras da solicitação de hospedagem (#494), sem banco: aceite do pet pelo Host e reconhecimento da mesma intenção no reenvio.
import { test } from 'node:test';
import assert from 'node:assert';
import { accepts, sameIntent } from '../src/reservations/create-reservation.service.js';

test('accepts: lista vazia aceita tudo, inclusive pet sem porte', () => {
    assert.strictEqual(accepts([], 'dog'), true);
    assert.strictEqual(accepts([], null), true);
});

test('accepts: compara sem diferenciar maiúsculas', () => {
    assert.strictEqual(accepts(['Dog', 'cat'], 'DOG'), true);
    assert.strictEqual(accepts(['dog'], 'cat'), false);
});

test('accepts: com lista preenchida, pet sem o dado é recusado', () => {
    assert.strictEqual(accepts(['small'], null), false);
    assert.strictEqual(accepts(['small'], undefined), false);
});

const saved = {
    serviceId: 's1',
    petId: 'p1',
    startDate: new Date('2026-11-10'),
    endDate: new Date('2026-11-13'),
    notes: null,
};
const sent = { ...saved, startDate: new Date('2026-11-10'), endDate: new Date('2026-11-13'), idempotencyKey: 'k' };

test('sameIntent: mesmos dados, datas em objetos diferentes, é a mesma intenção', () => {
    assert.strictEqual(sameIntent(saved, sent), true);
});

test('sameIntent: notes ausente no salvo e null no envio contam como iguais', () => {
    assert.strictEqual(sameIntent({ ...saved, notes: undefined }, sent), true);
});

test('sameIntent: mudar só um campo vira outra intenção', () => {
    assert.strictEqual(sameIntent(saved, { ...sent, serviceId: 's2' }), false);
    assert.strictEqual(sameIntent(saved, { ...sent, petId: 'p2' }), false);
    assert.strictEqual(sameIntent(saved, { ...sent, startDate: new Date('2026-11-11') }), false);
    assert.strictEqual(sameIntent(saved, { ...sent, endDate: new Date('2026-11-14') }), false);
    assert.strictEqual(sameIntent(saved, { ...sent, notes: 'Toma remédio' }), false);
});
