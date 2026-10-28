// /health e /health/ready com o Prisma compartilhado. Exige DATABASE_URL.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import axios from 'axios';
import { prisma } from '../../src/lib/prisma.js';

try {
    process.loadEnvFile();
} catch {
    // sem .env: a verificação abaixo falha com mensagem clara
}
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL ausente: configure o .env para rodar os testes de integração');
}

const { default: app } = await import('../../src/app.js');
// Aquece a conexão antes do teste HTTP para medir a readiness, não o primeiro handshake do Railway.
await prisma.$connect();
const http = axios.create({ validateStatus: () => true });
const servers = [];

const start = async () => {
    const server = app.listen(0);
    servers.push(server);
    await once(server, 'listening');
    return `http://localhost:${server.address().port}`;
};

after(() => {
    servers.forEach((server) => server.close());
});

test('banco real: /health/ready 200', async () => {
    const base = await start();
    const ready = await http.get(`${base}/health/ready`);
    assert.strictEqual(ready.status, 200);
    assert.deepStrictEqual(ready.data, { status: 'ready', database: 'ok' });
});

test('/health 200 com banco real', async () => {
    const base = await start();
    const health = await http.get(`${base}/health`);
    assert.strictEqual(health.status, 200);
});

test('/health/ready 503 quando o banco falha', async () => {
    const originalQueryRaw = prisma.$queryRaw;
    prisma.$queryRaw = () => Promise.reject(new Error('database unavailable'));
    const base = await start();

    try {
        const ready = await http.get(`${base}/health/ready`);
        assert.strictEqual(ready.status, 503);
        assert.deepStrictEqual(ready.data, { status: 'not_ready', database: 'unavailable' });
    } finally {
        prisma.$queryRaw = originalQueryRaw;
    }
});

// Sem injeção ou alteração de .env, a indisponibilidade real é coberta por db.test.js.
