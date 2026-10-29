// JWT válido cujo sub não tem USER (TSK-04 #298), contra o PostgreSQL real. Exige DATABASE_URL. Não grava nada.
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

after(async () => {
    server.close();
    await prisma.$disconnect();
});

test('token válido com sub sem USER: 404 USER_NOT_FOUND', async () => {
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(randomUUID()) // nenhum USER tem esse auth_user_id
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setExpirationTime('5m')
        .sign(privateKey);

    const res = await axios.get(`http://localhost:${server.address().port}/api/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
    });

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.data.code, 'USER_NOT_FOUND');
});
