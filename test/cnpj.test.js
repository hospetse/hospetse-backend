import { test } from 'node:test';
import assert from 'node:assert';
import { isValidCnpj } from '../src/lib/cnpj.js';

test('CNPJ válido passa', () => {
    assert.strictEqual(isValidCnpj('11222333000181'), true);
});

test('dígito verificador errado reprova', () => {
    assert.strictEqual(isValidCnpj('11222333000182'), false); // 2º dígito errado
    assert.strictEqual(isValidCnpj('11222333000191'), false); // 1º dígito errado
});

test('todos os dígitos iguais reprova', () => {
    assert.strictEqual(isValidCnpj('11111111111111'), false);
});

test('tamanho errado ou com letra reprova', () => {
    assert.strictEqual(isValidCnpj('1122233300018'), false);
    assert.strictEqual(isValidCnpj('1122233300018a'), false);
});
