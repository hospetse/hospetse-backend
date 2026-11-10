// Query da fila de validação de prestadores (#398), sem banco: todos os erros de uma vez e os filtros no formato do service.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseValidationQueueQuery } from '../src/admin/provider-validations-policy.js';

const fields = (query) => parseValidationQueueQuery(query).details.map((detail) => detail.field);

test('sem parâmetro: página 1 de 20 e todos os tipos', () => {
    assert.deepStrictEqual(parseValidationQueueQuery({}), {
        details: [],
        filters: { providerType: undefined, page: 1, pageSize: 20 },
    });
});

test('parâmetros válidos: tipo como veio e página e tamanho como número', () => {
    for (const providerType of ['hotel', 'pet_sitter', 'pet_walker']) {
        assert.deepStrictEqual(parseValidationQueueQuery({ providerType, page: '2', pageSize: '10' }).filters,
            { providerType, page: 2, pageSize: 10 });
    }
});

test('pageSize: aceita de 1 a 50 e recusa fora da faixa', () => {
    assert.strictEqual(parseValidationQueueQuery({ pageSize: '1' }).filters.pageSize, 1);
    assert.strictEqual(parseValidationQueueQuery({ pageSize: '50' }).filters.pageSize, 50);
    for (const pageSize of ['0', '51', '-1', '1.5', 'abc', '']) {
        assert.deepStrictEqual(parseValidationQueueQuery({ pageSize }).details,
            [{ field: 'pageSize', message: 'inteiro de 1 a 50' }], `pageSize=${pageSize}`);
    }
});

test('page: inteiro a partir de 1', () => {
    for (const page of ['0', '-1', '1.5', 'abc', '']) {
        assert.deepStrictEqual(parseValidationQueueQuery({ page }).details,
            [{ field: 'page', message: 'inteiro a partir de 1' }], `page=${page}`);
    }
});

test('tipo inválido: erro com os valores aceitos', () => {
    assert.deepStrictEqual(parseValidationQueueQuery({ providerType: 'clinic' }).details,
        [{ field: 'providerType', message: 'um de: hotel, pet_sitter, pet_walker' }]);
    assert.deepStrictEqual(fields({ providerType: '' }), ['providerType']);
});

test('parâmetro desconhecido: fora do contrato', () => {
    assert.deepStrictEqual(parseValidationQueueQuery({ status: 'approved' }).details,
        [{ field: 'status', message: 'não faz parte do contrato' }]);
});

test('parâmetro repetido: um único erro no campo, sem escolher um dos valores', () => {
    assert.deepStrictEqual(parseValidationQueueQuery({ providerType: ['hotel', 'pet_sitter'], page: ['1', '2'] }).details, [
        { field: 'providerType', message: 'informe uma única vez' },
        { field: 'page', message: 'informe uma única vez' },
    ]);
});

test('vários erros saem juntos e nenhum filtro é devolvido', () => {
    const result = parseValidationQueueQuery({ sort: 'name', providerType: 'clinic', page: '0', pageSize: '51' });
    assert.deepStrictEqual(result.details.map((detail) => detail.field), ['sort', 'providerType', 'page', 'pageSize']);
    assert.strictEqual(result.filters, undefined);
});
