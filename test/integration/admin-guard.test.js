// Guarda das rotas administrativas (HSP-PBI-007-TSK-04 #313), contra o PostgreSQL real. Exige DATABASE_URL.
// Cria dois USERs it-admin-guard-* e apaga no final.
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

const { default: app } = await import('../../src/app.js');
const server = app.listen(0);
await once(server, 'listening');
const http = axios.create({ baseURL: `http://localhost:${server.address().port}`, validateStatus: () => true });

function createUser(accountType) {
    const authUserId = randomUUID();
    return prisma.user.create({
        data: { authUserId, email: `it-admin-guard-${authUserId}@hospetse.dev`, name: 'Teste', accountType },
    });
}

const admin = await createUser('admin');
const common = await createUser('user');

after(async () => {
    server.close();
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, common.id] } } });
    await prisma.$disconnect();
});

async function bearer(user) {
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(user.authUserId)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setExpirationTime('5m')
        .sign(privateKey);
    return { headers: { Authorization: `Bearer ${token}` } };
}

test('Administrador acessa a rota administrativa e só recebe id e papel', async () => {
    const res = await http.get('/api/v1/admin/me', await bearer(admin));

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, { id: admin.id, accountType: 'admin' });
});

test('usuário sem o papel recebe 403 ADMIN_REQUIRED', async () => {
    const res = await http.get('/api/v1/admin/me', await bearer(common));

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.data.code, 'ADMIN_REQUIRED');
});

test('usuário sem o papel recebe 403 também em caminho e método sem rota, com qualquer grafia', async () => {
    const auth = await bearer(common);

    for (const [method, url] of [['get', '/api/v1/admin/nao-existe'], ['post', '/api/v1/admin/me'], ['get', '/api/v1/ADMIN/me/']]) {
        const res = await http.request({ method, url, ...auth });
        assert.strictEqual(res.status, 403, `${method.toUpperCase()} ${url} respondeu ${res.status}`);
        assert.strictEqual(res.data.code, 'ADMIN_REQUIRED');
    }
});
