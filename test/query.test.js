// Leitura da query string compartilhada pelas rotas de consulta (src/lib/query.js).
import { test } from 'node:test';
import assert from 'node:assert';
import { checkQueryFields, isSingleValue, parsePagination } from '../src/lib/query.js';

// Junta os erros como as policies fazem, para conferir o details inteiro
function collect(run) {
    const details = [];
    const result = run((field, message) => details.push({ field, message }));
    return { details, result };
}

test('isSingleValue: só texto conta como valor único', () => {
    assert.strictEqual(isSingleValue({ page: '2' }, 'page'), true);
    assert.strictEqual(isSingleValue({ page: ['1', '2'] }, 'page'), false);
    assert.strictEqual(isSingleValue({}, 'page'), false);
});

test('checkQueryFields: campo fora do contrato e repetido, um erro cada', () => {
    const { details } = collect((invalid) => checkQueryFields({ page: ['1', '2'], foo: 'x', pageSize: '10' }, ['page', 'pageSize'], invalid));
    assert.deepStrictEqual(details, [
        { field: 'page', message: 'informe uma única vez' },
        { field: 'foo', message: 'não faz parte do contrato' },
    ]);
});

test('parsePagination: padrões 1 e 20 sem os campos', () => {
    const { details, result } = collect((invalid) => parsePagination({}, invalid));
    assert.deepStrictEqual(details, []);
    assert.deepStrictEqual(result, { page: 1, pageSize: 20 });
});

test('parsePagination: converte texto para número', () => {
    const { details, result } = collect((invalid) => parsePagination({ page: '3', pageSize: '50' }, invalid));
    assert.deepStrictEqual(details, []);
    assert.deepStrictEqual(result, { page: 3, pageSize: 50 });
});

test('parsePagination: fora da faixa ou não inteiro devolve os dois erros juntos', () => {
    for (const [page, pageSize] of [['0', '51'], ['abc', '0'], ['1.5', '2.5']]) {
        const { details } = collect((invalid) => parsePagination({ page, pageSize }, invalid));
        assert.deepStrictEqual(details.map((d) => d.field), ['page', 'pageSize'], `page=${page} pageSize=${pageSize}`);
    }
});

test('parsePagination: repetido conta como ausente (o erro é do checkQueryFields)', () => {
    const { details, result } = collect((invalid) => parsePagination({ page: ['1', '2'] }, invalid));
    assert.deepStrictEqual(details, []);
    assert.strictEqual(result.page, 1);
});
