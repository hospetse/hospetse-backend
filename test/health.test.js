// Testes de liveness sem banco.
import { test } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import axios from 'axios';
import app from '../src/app.js';

async function listen() {
    const server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address();
    return { server, base: `http://localhost:${port}` };
}

test('/health 200 sem consultar o banco', async () => {
    const { server, base } = await listen();
    try {
        const res = await axios.get(`${base}/health`);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.data, { status: 'Server is running' });
    } finally {
        server.close();
    }
});
