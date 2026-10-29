import { test } from 'node:test';
import assert from 'node:assert';
import { isValidCpf, stripCpf } from '../src/lib/cpf.js';

test('CPF válido passa', () => {
    assert.strictEqual(isValidCpf('52998224725'), true);
});

test('dígito verificador errado reprova', () => {
    assert.strictEqual(isValidCpf('52998224724'), false); // 2º dígito errado
    assert.strictEqual(isValidCpf('52998224715'), false); // 1º dígito errado
});

test('todos os dígitos iguais reprova', () => {
    assert.strictEqual(isValidCpf('11111111111'), false);
});

test('tamanho errado ou com letra reprova', () => {
    assert.strictEqual(isValidCpf('5299822472'), false);
    assert.strictEqual(isValidCpf('5299822472a'), false);
});

test('stripCpf tira só a pontuação', () => {
    assert.strictEqual(stripCpf('529.982.247-25'), '52998224725');
    assert.strictEqual(isValidCpf(stripCpf('529 982 247 25')), false);
});
