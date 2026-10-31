// Ocupação por dia (#488), sem banco: reservas em dias diferentes do período não disputam a mesma vaga.
import { test } from 'node:test';
import assert from 'node:assert';
import { peakOccupancy } from '../src/reservations/availability.js';

const d = (day) => new Date(`2026-11-${String(day).padStart(2, '0')}`);
const r = (start, end) => ({ startDate: d(start), endDate: d(end) });

test('peakOccupancy: sem reservas, zero', () => {
    assert.strictEqual(peakOccupancy([], d(10), d(15)), 0);
});

test('peakOccupancy: reservas em dias diferentes contam uma por vez', () => {
    assert.strictEqual(peakOccupancy([r(10, 11), r(13, 14)], d(10), d(15)), 1);
});

test('peakOccupancy: reservas no mesmo dia somam', () => {
    assert.strictEqual(peakOccupancy([r(9, 12), r(11, 13)], d(10), d(15)), 2);
});

test('peakOccupancy: o dia da saída não conta', () => {
    assert.strictEqual(peakOccupancy([r(8, 10)], d(10), d(12)), 0);
});
