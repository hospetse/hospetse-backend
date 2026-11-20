// Nomes oficiais dos estados da contratação (#533), conferidos contra o CHECK de reservations.status nas migrations.
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { CONTRACT_STATUS_LABELS, CONTRACT_TYPES } from '../src/contracts/contract-status.js';

// O CHECK mais recente de reservations.status, lido das migrations em ordem
function statusesInDatabase() {
    const dir = new URL('../prisma/migrations/', import.meta.url);
    let statuses;
    for (const migration of readdirSync(dir).filter((name) => /^\d/.test(name)).sort()) {
        const sql = readFileSync(new URL(`${migration}/migration.sql`, dir), 'utf8');
        const match = sql.match(/"reservations_status_check" CHECK \("status" IN \(([^)]*)\)\)/);
        if (match) statuses = match[1].split(',').map((value) => value.trim().replace(/'/g, ''));
    }
    return statuses;
}

test('todo status do banco tem um nome oficial, e nenhum nome sobra', () => {
    assert.deepStrictEqual(Object.keys(CONTRACT_STATUS_LABELS).sort(), statusesInDatabase().sort());
});

test('nomes do Glossário: nenhum sinônimo não oficial', () => {
    const labels = Object.values(CONTRACT_STATUS_LABELS);
    for (const unofficial of ['Solicitada', 'Finalizada', 'Pendente', 'Aceita', 'Rejeitada']) {
        assert.ok(!labels.includes(unofficial), unofficial);
    }
    assert.strictEqual(CONTRACT_STATUS_LABELS.requested, 'Aguardando aceite');
    assert.strictEqual(CONTRACT_STATUS_LABELS.accepted, 'Confirmada');
});

test('os três tipos de prestador viram hospedagem, visita e passeio', () => {
    assert.deepStrictEqual(CONTRACT_TYPES, { hotel: 'hospedagem', pet_sitter: 'visita', pet_walker: 'passeio' });
});
