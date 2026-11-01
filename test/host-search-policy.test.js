// Filtros da busca de Hosts (#476), sem banco: todos os erros de uma vez e os filtros no formato do service.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseSearchQuery } from '../src/hosts/host-search-policy.js';

const day = (offset) => new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const fields = (query) => parseSearchQuery(query).details.map((detail) => detail.field);

test('sem filtro: página 1 de 20 e nenhum filtro aplicado', () => {
    const { details, filters } = parseSearchQuery({});
    assert.deepStrictEqual(details, []);
    assert.strictEqual(filters.page, 1);
    assert.strictEqual(filters.pageSize, 20);
    assert.strictEqual(filters.city, undefined);
    assert.strictEqual(filters.species, undefined);
});

test('filtros válidos: preços como número e cidade e raça sem espaços nas pontas', () => {
    const { filters } = parseSearchQuery({
        city: ' São Paulo ', minPrice: '50', maxPrice: '120.5', startDate: day(1), endDate: day(3),
        species: 'dog', size: 'medium', breed: ' Vira-lata ', page: '2', pageSize: '10',
    });
    assert.deepStrictEqual(filters, {
        city: 'São Paulo', minPrice: 50, maxPrice: 120.5, startDate: day(1), endDate: day(3), petId: undefined,
        species: 'dog', size: 'medium', breed: 'Vira-lata', page: 2, pageSize: 10,
    });
});

test('vários erros saem juntos, na ordem dos campos', () => {
    assert.deepStrictEqual(fields({
        sort: 'price', city: '', minPrice: '-1', maxPrice: 'abc', startDate: '2026-02-30', endDate: day(1),
        species: 'bird', size: 'giant', page: '0', pageSize: '51',
    }), ['sort', 'city', 'minPrice', 'maxPrice', 'startDate', 'species', 'size', 'page', 'pageSize']);
});

test('faixa de preço invertida: erro em maxPrice', () => {
    assert.deepStrictEqual(parseSearchQuery({ minPrice: '100', maxPrice: '50' }).details,
        [{ field: 'maxPrice', message: 'não pode ser menor que minPrice' }]);
});

test('período: as duas datas juntas, sem passado e fim depois do início', () => {
    assert.deepStrictEqual(fields({ startDate: day(1) }), ['endDate']);
    assert.deepStrictEqual(fields({ endDate: day(1) }), ['startDate']);
    assert.deepStrictEqual(fields({ startDate: day(-1), endDate: day(1) }), ['startDate']);
    assert.deepStrictEqual(fields({ startDate: day(3), endDate: day(3) }), ['endDate']);
});

test('petId: UUID, e sem espécie, porte ou raça manuais junto', () => {
    assert.deepStrictEqual(fields({ petId: 'abc' }), ['petId']);
    assert.deepStrictEqual(fields({ petId: '6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f', species: 'dog', size: 'small', breed: 'x' }),
        ['species', 'size', 'breed']);
});

test('parâmetro repetido: um único erro no campo, sem escolher um dos valores', () => {
    assert.deepStrictEqual(parseSearchQuery({ city: ['A', 'B'], minPrice: ['1', '2'] }).details, [
        { field: 'city', message: 'informe uma única vez' },
        { field: 'minPrice', message: 'informe uma única vez' },
    ]);
});
