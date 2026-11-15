// Validação do pagamento da contratação (#530), sem banco: header Idempotency-Key e body estrito com só o token do cartão.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseContractPayment } from '../src/payments/contract-payment-policy.js';

const KEY = '4c8e2a9d-1f3b-4e6a-9c0d-7b2a1e5f8d34';
const fields = (result) => result.details.map((d) => d.field);

test('chave e token válidos: devolve os dois, sem erros', () => {
    const result = parseContractPayment({ 'idempotency-key': KEY }, { paymentMethodToken: 'pm_card_visa' });
    assert.deepStrictEqual(result, { details: [], payment: { idempotencyKey: KEY, paymentMethodToken: 'pm_card_visa' } });
});

test('dados do cartão no body: recusados pelo nome, sem o valor na mensagem', () => {
    const result = parseContractPayment({ 'idempotency-key': KEY }, { paymentMethodToken: 'pm_card_visa', cardNumber: '4242424242424242', cvv: '123' });
    assert.deepStrictEqual(fields(result), ['cardNumber', 'cvv']);
    assert.ok(!JSON.stringify(result).includes('4242'));
    assert.strictEqual(result.payment, undefined);
});

test('token fora do formato pm_: número do cartão, vazio, outro tipo ou longo demais', () => {
    for (const token of ['4242424242424242', '', 'pm_', 'pm_com espaço', 123, null, `pm_${'a'.repeat(251)}`]) {
        assert.deepStrictEqual(fields(parseContractPayment({ 'idempotency-key': KEY }, { paymentMethodToken: token })), ['paymentMethodToken'], String(token));
    }
});

test('Idempotency-Key ausente, com caractere inválido ou maior que 100', () => {
    for (const key of [undefined, '', 'chave com espaço', 'x'.repeat(101), ['a', 'b']]) {
        assert.deepStrictEqual(fields(parseContractPayment({ 'idempotency-key': key }, { paymentMethodToken: 'pm_card_visa' })), ['Idempotency-Key'], String(key));
    }
    assert.deepStrictEqual(fields(parseContractPayment({ 'idempotency-key': 'x'.repeat(100) }, { paymentMethodToken: 'pm_card_visa' })), []);
});

test('body que não é objeto: falta o token', () => {
    for (const body of [undefined, null, 'pm_card_visa', ['pm_card_visa']]) {
        assert.deepStrictEqual(fields(parseContractPayment({ 'idempotency-key': KEY }, body)), ['paymentMethodToken'], String(body));
    }
});

test('todos os erros de uma vez', () => {
    const result = parseContractPayment({}, { paymentMethodToken: 'x', amount: 1 });
    assert.deepStrictEqual(fields(result), ['Idempotency-Key', 'paymentMethodToken', 'amount']);
});
