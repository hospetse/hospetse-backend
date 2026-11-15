// Query da consulta de usuários (#580), sem banco: todos os erros de uma vez e os filtros no formato do service.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseUserListQuery, userRoles } from '../src/admin/users-policy.js';

const fields = (query) => parseUserListQuery(query).details.map((detail) => detail.field);

test('sem parâmetro: página 1 de 20 e nenhum filtro', () => {
    assert.deepStrictEqual(parseUserListQuery({}), {
        details: [],
        filters: { q: undefined, role: undefined, status: undefined, page: 1, pageSize: 20 },
    });
});

test('parâmetros válidos: busca sem espaços nas pontas e página e tamanho como número', () => {
    assert.deepStrictEqual(parseUserListQuery({ q: '  lucas ', role: 'tutor', status: 'active', page: '2', pageSize: '10' }).filters,
        { q: 'lucas', role: 'tutor', status: 'active', page: 2, pageSize: 10 });
});

test('q: de 2 a 100 caracteres, contados sem os espaços das pontas', () => {
    assert.strictEqual(parseUserListQuery({ q: 'ab' }).filters.q, 'ab');
    assert.strictEqual(parseUserListQuery({ q: 'a'.repeat(100) }).filters.q.length, 100);
    for (const q of ['', 'a', ' a ', '   ', 'a'.repeat(101)]) {
        assert.deepStrictEqual(parseUserListQuery({ q }).details, [{ field: 'q', message: 'texto de 2 a 100 caracteres' }], `q="${q}"`);
    }
});

test('role e status: só os valores do contrato', () => {
    for (const role of ['tutor', 'provider', 'admin']) assert.strictEqual(parseUserListQuery({ role }).filters.role, role);
    for (const status of ['active', 'blocked', 'suspended', 'pending']) assert.strictEqual(parseUserListQuery({ status }).filters.status, status);
    assert.deepStrictEqual(parseUserListQuery({ role: 'host', status: 'banned' }).details, [
        { field: 'role', message: 'um de: tutor, provider, admin' },
        { field: 'status', message: 'um de: active, blocked, suspended, pending' },
    ]);
    assert.deepStrictEqual(fields({ role: '', status: '' }), ['role', 'status']);
});

test('page e pageSize: inteiros dentro da faixa', () => {
    assert.strictEqual(parseUserListQuery({ pageSize: '50' }).filters.pageSize, 50);
    for (const value of ['0', '-1', '1.5', 'abc', '']) {
        assert.deepStrictEqual(parseUserListQuery({ page: value }).details, [{ field: 'page', message: 'inteiro a partir de 1' }], `page=${value}`);
    }
    for (const value of ['0', '51', '1.5', 'abc', '']) {
        assert.deepStrictEqual(parseUserListQuery({ pageSize: value }).details, [{ field: 'pageSize', message: 'inteiro de 1 a 50' }], `pageSize=${value}`);
    }
});

test('parâmetro desconhecido ou repetido: erro no campo, sem escolher um dos valores', () => {
    assert.deepStrictEqual(parseUserListQuery({ email: 'a@b.dev', q: ['ab', 'cd'], status: ['active', 'blocked'] }).details, [
        { field: 'email', message: 'não faz parte do contrato' },
        { field: 'q', message: 'informe uma única vez' },
        { field: 'status', message: 'informe uma única vez' },
    ]);
});

test('vários erros saem juntos e nenhum filtro é devolvido', () => {
    const result = parseUserListQuery({ sort: 'name', q: 'a', role: 'host', status: 'banned', page: '0', pageSize: '51' });
    assert.deepStrictEqual(result.details.map((detail) => detail.field), ['sort', 'q', 'role', 'status', 'page', 'pageSize']);
    assert.strictEqual(result.filters, undefined);
});

test('papéis: vêm dos perfis e do tipo da conta, na ordem do contrato', () => {
    assert.deepStrictEqual(userRoles({ tutor: null, provider: null, accountType: 'user' }), []);
    assert.deepStrictEqual(userRoles({ tutor: { id: 't' }, provider: null, accountType: 'user' }), ['tutor']);
    assert.deepStrictEqual(userRoles({ tutor: { id: 't' }, provider: { id: 'p' }, accountType: 'admin' }), ['tutor', 'provider', 'admin']);
});
