// Papel de Host (#485), sem banco: o requireUser carrega o provider no req.user e o requireHost decide.
import { test } from 'node:test';
import assert from 'node:assert';
import { requireHost } from '../src/hosts/host-policy.js';

test('requireHost: USER sem provider recebe 403 HOST_REQUIRED', () => {
    assert.throws(() => requireHost({ provider: null }), { statusCode: 403, code: 'HOST_REQUIRED' });
});

test('requireHost: USER com provider recebe o Host de volta, mesmo sendo também Tutor', () => {
    const provider = { id: 'p1' };
    assert.strictEqual(requireHost({ provider, tutor: { id: 't1' } }), provider);
});
