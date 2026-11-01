// Agenda do Host (#482), sem banco: período padrão, limites e todos os erros de uma vez.
import { test } from 'node:test';
import assert from 'node:assert';
import { addDays, parseAgendaQuery, parseBlockBody } from '../src/hosts/agenda-policy.js';
import { occupiedOn } from '../src/reservations/availability.js';

const day = (offset) => new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const fields = (result) => result.details.map((detail) => detail.field);

test('agenda sem datas: de hoje até 30 dias', () => {
    assert.deepStrictEqual(parseAgendaQuery({}), { details: [], startDate: day(0), endDate: addDays(day(0), 30) });
});

test('agenda: aceita passado, recusa mais de 90 dias, fim igual ao início e parâmetro fora do contrato', () => {
    assert.deepStrictEqual(fields(parseAgendaQuery({ startDate: day(-10), endDate: day(-1) })), []);
    assert.deepStrictEqual(fields(parseAgendaQuery({ startDate: day(0), endDate: day(91) })), ['endDate']);
    assert.deepStrictEqual(fields(parseAgendaQuery({ startDate: day(5), endDate: day(5), status: 'x' })), ['status', 'endDate']);
});

test('bloqueio válido: motivo sem espaços nas pontas; sem motivo vira null', () => {
    const { details, reason } = parseBlockBody({ startDate: day(1), endDate: day(3), reason: '  Reforma ' });
    assert.deepStrictEqual(details, []);
    assert.strictEqual(reason, 'Reforma');
    assert.strictEqual(parseBlockBody({ startDate: day(1), endDate: day(3) }).reason, null);
});

test('bloqueio: passado, data inexistente, mais de 365 dias, motivo longo e campo extra saem juntos', () => {
    assert.deepStrictEqual(fields(parseBlockBody({ startDate: day(-1), endDate: '2026-02-30', reason: 'x'.repeat(501), providerId: 'x' })),
        ['startDate', 'endDate', 'reason', 'providerId']);
    assert.deepStrictEqual(fields(parseBlockBody({ startDate: day(1), endDate: day(367) })), ['endDate']);
    assert.deepStrictEqual(fields(parseBlockBody(undefined)), ['startDate', 'endDate']);
});

test('occupiedOn: a entrada conta, a saída não', () => {
    const r = { startDate: new Date('2026-11-10'), endDate: new Date('2026-11-12') };
    assert.strictEqual(occupiedOn([r], Date.parse('2026-11-10')), 1);
    assert.strictEqual(occupiedOn([r], Date.parse('2026-11-11')), 1);
    assert.strictEqual(occupiedOn([r], Date.parse('2026-11-12')), 0);
});
