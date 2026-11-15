// Regras da conversa da contratação (#548), sem banco.
import { test } from 'node:test';
import assert from 'node:assert';
import { isOpenForSending, participantRole } from '../src/conversations/conversation-policy.js';

const parties = { tutorUserId: 'u-tutor', hostUserId: 'u-host' };

test('participantRole: Tutor, Host ou ninguém', () => {
    assert.strictEqual(participantRole(parties, 'u-tutor'), 'tutor');
    assert.strictEqual(participantRole(parties, 'u-host'), 'host');
    assert.strictEqual(participantRole(parties, 'u-outro'), null);
    assert.strictEqual(participantRole(parties, undefined), null);
});

test('isOpenForSending: fecha só em concluída, recusada ou cancelada', () => {
    for (const status of ['requested', 'awaiting_payment', 'accepted', 'checked_in', 'checked_out']) {
        assert.strictEqual(isOpenForSending(status), true, status);
    }
    for (const status of ['completed', 'rejected', 'cancelled']) {
        assert.strictEqual(isOpenForSending(status), false, status);
    }
});
