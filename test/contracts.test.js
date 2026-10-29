// Guarda da contratação (TSK-05 #263), sem banco: o findUnique do Prisma devolve USERs montados aqui,
// então o pedido passa pelo caminho real (JWT → requireUser → requireCanContract → controller) sem consultar o banco.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import axios from 'axios';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { startContractController } from '../src/contracts/contracts.controller.js';

const { publicKey, privateKey } = await generateKeyPair('RS256');
process.env.JWT_PUBLIC_KEY = await exportSPKI(publicKey);

// sub do JWT → USER que o requireUser "encontra"
const USERS = {
    incompleto: { status: 'pending', profileStatus: 'incomplete', tutor: null },
    suspenso: { status: 'suspended', profileStatus: 'complete', tutor: null },
    bloqueado: { status: 'blocked', profileStatus: 'incomplete', tutor: null },
    completo: { status: 'active', profileStatus: 'complete', tutor: null },
};
const { prisma } = await import('../src/lib/prisma.js');
prisma.user.findUnique = async ({ where }) => USERS[where.authUserId] ?? null;

const { default: app } = await import('../src/app.js');
const server = app.listen(0);
await once(server, 'listening');
const http = axios.create({ baseURL: `http://localhost:${server.address().port}`, validateStatus: () => true });

after(() => server.close());

const ROUTES = ['/api/v1/reservations', '/api/v1/service-requests', '/api/v1/checkout'];

async function as(sub) {
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(sub)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setExpirationTime('5m')
        .sign(privateKey);
    return { headers: { Authorization: `Bearer ${token}` } };
}

test('perfil incompleto não contrata: 403 PROFILE_INCOMPLETE nas três rotas', async () => {
    for (const route of ROUTES) {
        const res = await http.post(route, null, await as('incompleto'));
        assert.strictEqual(res.status, 403, route);
        assert.deepStrictEqual(res.data, { code: 'PROFILE_INCOMPLETE', message: 'Complete seu perfil antes de contratar um serviço.' });
    }
});

test('conta suspensa ou bloqueada: 403 ACCOUNT_RESTRICTED, diferente do perfil incompleto', async () => {
    for (const route of ROUTES) {
        for (const sub of ['suspenso', 'bloqueado']) {
            const res = await http.post(route, null, await as(sub));
            assert.strictEqual(res.status, 403, `${route} ${sub}`);
            assert.strictEqual(res.data.code, 'ACCOUNT_RESTRICTED');
        }
    }
});

test('perfil completo passa pela guarda e chega ao controller provisório: 501', async () => {
    for (const route of ROUTES) {
        const res = await http.post(route, null, await as('completo'));
        assert.strictEqual(res.status, 501, route);
        assert.strictEqual(res.data.code, 'NOT_IMPLEMENTED');
    }
});

test('perfil incompleto continua navegando: /me responde 200 com canContract false', async () => {
    const res = await http.get('/api/v1/me', await as('incompleto'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.permissions.canSearch, true);
    assert.strictEqual(res.data.permissions.canContract, false);
});

test('a guarda vale só para o POST: GET no mesmo caminho não recebe 403', async () => {
    const res = await http.get('/api/v1/reservations', await as('suspenso'));
    assert.notStrictEqual(res.status, 403);
});

test('a camada de service confere a regra mesmo se a guarda da rota faltar', () => {
    const res = {
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    startContractController({ user: USERS.incompleto }, res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'PROFILE_INCOMPLETE');
});
