// Regra do requireAdmin (HSP-PBI-007-TSK-04 #313), sem HTTP nem banco: req e res falsos.
import { test } from 'node:test';
import assert from 'node:assert';
import { requireAdmin } from '../src/middlewares/admin-only.js';

function run(user) {
    const res = {
        statusCode: undefined,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    let nextCalls = 0;
    requireAdmin({ user }, res, () => { nextCalls += 1; });
    return { res, nextCalls };
}

const denied = { code: 'ADMIN_REQUIRED', message: 'Apenas Administradores acessam esta rota.' };

test('Administrador segue para a rota sem resposta da guarda', () => {
    const { res, nextCalls } = run({ accountType: 'admin' });

    assert.strictEqual(nextCalls, 1);
    assert.strictEqual(res.statusCode, undefined);
    assert.strictEqual(res.body, undefined);
});

test('usuário comum recebe 403 ADMIN_REQUIRED e não segue para a rota', () => {
    const { res, nextCalls } = run({ accountType: 'user' });

    assert.strictEqual(nextCalls, 0);
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, denied);
});

test('USER sem accountType é negado', () => {
    const { res, nextCalls } = run({});

    assert.strictEqual(nextCalls, 0);
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, denied);
});
