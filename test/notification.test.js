// notify (src/notifications/notification.service.js, #554 e testes da #557) com uma transação falsa: sem banco.
import { test } from 'node:test';
import assert from 'node:assert';
import { notify, NOTIFICATION_TYPES, REFERENCE_TYPES } from '../src/notifications/notification.service.js';

// Guarda o que o notify mandaria ao banco
function fakeTx() {
    const calls = [];
    return { calls, notification: { createMany: async (args) => { calls.push(args); return { count: args.data.length }; } } };
}

const event = (overrides = {}) => ({
    type: 'payment_approved',
    recipients: ['user-host', 'user-tutor'],
    eventKey: 'payment_approved:tx-1',
    reference: { type: 'contract', id: 'reservation-1' },
    data: { reservationId: 'reservation-1', transactionId: 'tx-1' },
    ...overrides,
});

test('uma linha por destinatário, com a mesma chave do evento e skipDuplicates', async () => {
    const tx = fakeTx();
    await notify(tx, event());

    assert.strictEqual(tx.calls.length, 1);
    const [{ data, skipDuplicates }] = tx.calls;
    assert.strictEqual(skipDuplicates, true);
    assert.deepStrictEqual(data.map((row) => row.userId), ['user-host', 'user-tutor']);
    for (const row of data) {
        assert.deepStrictEqual(row, {
            userId: row.userId,
            type: 'payment_approved',
            eventKey: 'payment_approved:tx-1',
            referenceType: 'contract',
            referenceId: 'reservation-1',
            content: '{"reservationId":"reservation-1","transactionId":"tx-1"}',
        });
    }
});

test('tipo ou referência desconhecidos lançam erro antes de gravar', () => {
    for (const overrides of [{ type: 'reservation_paid' }, { type: '' }, { reference: { type: 'pet', id: 'p-1' } }]) {
        const tx = fakeTx();
        assert.throws(() => notify(tx, event(overrides)), /desconhecid/, JSON.stringify(overrides));
        assert.strictEqual(tx.calls.length, 0);
    }
});

test('todos os tipos e referências da lista são aceitos', async () => {
    for (const type of NOTIFICATION_TYPES) {
        for (const referenceType of REFERENCE_TYPES) {
            await notify(fakeTx(), event({ type, reference: { type: referenceType, id: 'x' } }));
        }
    }
});

test('o content leva só o data do evento', async () => {
    const tx = fakeTx();
    await notify(tx, event({ recipients: ['u-1'], data: { conversationId: 'c-1', messageId: 'm-1' } }));
    assert.deepStrictEqual(JSON.parse(tx.calls[0].data[0].content), { conversationId: 'c-1', messageId: 'm-1' });
});
