// Cadastro no back-end (TSK-06 #264): o PUT interno que o Auth chama e o /me em seguida, contra o PostgreSQL real.
// Exige DATABASE_URL. Cria USERs de teste (e-mail it-prov-...@exemplo.com) e remove tudo o que criou no after.
// O token de serviço e o JWT do usuário são gerados aqui: não depende do Auth.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { prisma } from '../../src/lib/prisma.js';

try {
    process.loadEnvFile();
} catch {
    // sem .env: a verificação abaixo falha com mensagem clara
}
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL ausente: configure o .env para rodar os testes de integração');
}

const { publicKey, privateKey } = await generateKeyPair('RS256');
process.env.JWT_PUBLIC_KEY = await exportSPKI(publicKey);
process.env.INTERNAL_SERVICE_TOKEN = 'token-de-servico-de-teste';

const { default: app } = await import('../../src/app.js');
const server = app.listen(0);
await once(server, 'listening');
const http = axios.create({ baseURL: `http://localhost:${server.address().port}`, validateStatus: () => true });

const authUserIds = [];

after(async () => {
    server.close();
    await prisma.user.deleteMany({ where: { authUserId: { in: authUserIds } } });
    await prisma.$disconnect();
});

const service = { headers: { Authorization: 'Bearer token-de-servico-de-teste' } };

// Identidade nova, como o Auth cria depois de validar o PIN
function identity() {
    const authUserId = randomUUID();
    authUserIds.push(authUserId);
    return { authUserId, email: `it-prov-${authUserId}@exemplo.com`, name: 'Cadastro Integração' };
}

const provision = ({ authUserId, email, name }, config = service) =>
    http.put(`/api/v1/internal/users/${authUserId}`, { email, name }, config);

async function userJwt(authUserId) {
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(authUserId)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setExpirationTime('5m')
        .sign(privateKey);
    return { headers: { Authorization: `Bearer ${token}` } };
}

const countUsers = (where) => prisma.user.count({ where });

test('identidade confirmada: 201 e um único USER com perfil incomplete', async () => {
    const id = identity();
    const res = await provision(id);

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.data.authUserId, id.authUserId);

    const user = await prisma.user.findUnique({ where: { authUserId: id.authUserId } });
    assert.strictEqual(user.id, res.data.userId);
    assert.strictEqual(user.email, id.email);
    assert.strictEqual(user.name, id.name);
    assert.strictEqual(user.profileStatus, 'incomplete');
    assert.strictEqual(user.accountType, 'user');
    assert.strictEqual(await countUsers({ authUserId: id.authUserId }), 1);
});

test('repetir o provisionamento: 200 com o mesmo userId e sem duplicar', async () => {
    const id = identity();
    const first = await provision(id);
    const second = await provision(id);

    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.data.userId, first.data.userId);
    assert.strictEqual(await countUsers({ authUserId: id.authUserId }), 1);
});

test('chamadas iguais ao mesmo tempo: uma cria, a outra reaproveita, um só USER', async () => {
    const id = identity();
    const results = await Promise.all([provision(id), provision(id)]);

    assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 201]);
    assert.strictEqual(results[0].data.userId, results[1].data.userId);
    assert.strictEqual(await countUsers({ authUserId: id.authUserId }), 1);
});

test('e-mail de outro USER: 409 EMAIL_ALREADY_IN_USE e nada criado', async () => {
    const owner = identity();
    await provision(owner);

    const other = { ...identity(), email: owner.email };
    const res = await provision(other);

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.data.code, 'EMAIL_ALREADY_IN_USE');
    assert.strictEqual(await countUsers({ authUserId: other.authUserId }), 0);
});

test('authUserId já vinculado a outro e-mail: 409 AUTH_USER_ID_CONFLICT e o USER não muda', async () => {
    const id = identity();
    await provision(id);

    const res = await provision({ ...id, email: `outro-${id.email}` });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.data.code, 'AUTH_USER_ID_CONFLICT');
    const user = await prisma.user.findUnique({ where: { authUserId: id.authUserId } });
    assert.strictEqual(user.email, id.email);
});

test('senha não chega ao banco: password no body é recusado e a tabela users não tem coluna de senha', async () => {
    const id = identity();
    const res = await http.put(`/api/v1/internal/users/${id.authUserId}`, { email: id.email, name: id.name, password: '12345678' }, service);

    assert.strictEqual(res.status, 400);
    assert.ok(res.data.details.some((d) => d.field === 'password'));
    assert.strictEqual(await countUsers({ authUserId: id.authUserId }), 0);

    const columns = await prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`;
    assert.ok(!columns.some((c) => /pass/i.test(c.column_name)), 'users não pode ter coluna de senha');
});

test('payload inválido: 400 com todos os campos e nenhum USER parcial', async () => {
    const id = identity();
    const res = await http.put(`/api/v1/internal/users/${id.authUserId}`, { email: 'nao-e-email' }, service);

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data.details.map((d) => d.field).sort(), ['email', 'name']);
    assert.strictEqual(await countUsers({ authUserId: id.authUserId }), 0);
});

test('comunicação não autenticada: sem token ou com token errado responde 401 e nada é criado', async () => {
    const id = identity();
    const missing = await provision(id, {});
    const wrong = await provision(id, { headers: { Authorization: 'Bearer outro-token' } });
    const userToken = await provision(id, await userJwt(id.authUserId)); // JWT do usuário não serve na rota interna

    for (const res of [missing, wrong, userToken]) {
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.data.code, 'SERVICE_TOKEN_INVALID');
    }
    assert.strictEqual(await countUsers({ authUserId: id.authUserId }), 0);
});

test('fluxo do cadastro: depois do provisionamento o /me mostra o perfil incompleto e bloqueia a contratação', async () => {
    const id = identity();
    await provision(id);
    const auth = await userJwt(id.authUserId);

    const me = await http.get('/api/v1/me', auth);
    assert.strictEqual(me.status, 200);
    assert.deepStrictEqual(me.data.user, { id: me.data.user.id, authUserId: id.authUserId, email: id.email, name: id.name });
    assert.strictEqual(me.data.profile.status, 'incomplete');
    assert.deepStrictEqual(me.data.profile.missingFields, ['cpf', 'birthDate', 'phone', 'address', 'emergencyContact']);
    assert.deepStrictEqual(me.data.permissions, { canSearch: true, canContract: false });
    assert.ok(!JSON.stringify(me.data).toLowerCase().includes('password'));

    const contract = await http.post('/api/v1/reservations', null, auth);
    assert.strictEqual(contract.status, 403);
    assert.strictEqual(contract.data.code, 'PROFILE_INCOMPLETE');
});
