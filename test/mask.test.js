// Máscaras das respostas (LGPD): o valor completo nunca sai.
import { test } from 'node:test';
import assert from 'node:assert';
import { maskDocument, maskEmail, maskPhone } from '../src/lib/mask.js';

test('CPF, CNPJ e telefone: só os 4 últimos dígitos', () => {
    assert.strictEqual(maskDocument('52998224725'), '***4725');
    assert.strictEqual(maskDocument('11222333000181'), '***0181');
    assert.strictEqual(maskPhone('11900004321'), '***4321');
});

test('e-mail: a primeira letra e o domínio', () => {
    assert.strictEqual(maskEmail('lucas@outlook.com.br'), 'l***@outlook.com.br');
    assert.strictEqual(maskEmail('a@b.dev'), 'a***@b.dev');
});

test('sem valor: null, sem máscara vazia', () => {
    for (const mask of [maskDocument, maskPhone, maskEmail]) {
        assert.strictEqual(mask(null), null);
        assert.strictEqual(mask(undefined), null);
        assert.strictEqual(mask(''), null);
    }
});
