// Contrato #497/#314: UUIDs e e-mails do seed iguais aos do Auth, quando o outro repo está ao lado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { accounts as backendAccounts } from '../prisma/seed-accounts.js';

const authSeedPath = path.resolve(import.meta.dirname, '../../hospetse-auth-service/prisma/seed-accounts.js');

test('seed #314: ids e e-mails iguais aos do Auth quando o repositório vizinho existe', async (t) => {
    try {
        await access(authSeedPath);
    } catch {
        t.skip('hospetse-auth-service não está em ../hospetse-auth-service');
        return;
    }

    const { accounts: authAccounts } = await import(pathToFileURL(authSeedPath).href);
    assert.deepEqual(
        backendAccounts.map(({ id, email }) => ({ id, email })),
        authAccounts.map(({ id, email }) => ({ id, email })),
    );
    assert.equal(backendAccounts.filter((a) => a.accountType === 'admin').length, 1);
});
