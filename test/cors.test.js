import { test, after } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';

// o app lê o CORS_ORIGINS ao ser importado, então o env vem antes do import
process.env.CORS_ORIGINS = 'http://localhost:8081';
const { default: app } = await import('../src/app.js');

const server = app.listen(0);
const { port } = server.address();
// rota protegida: o preflight precisa passar sem token
const url = `http://localhost:${port}/api/v1/me`;

after(() => server.close());

test('preflight de origem liberada recebe o header do CORS sem token', async () => {
    const response = await axios.options(url, {
        headers: { Origin: 'http://localhost:8081', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });
    assert.strictEqual(response.status, 204);
    assert.strictEqual(response.headers['access-control-allow-origin'], 'http://localhost:8081');
});

test('origem fora da lista não recebe o header do CORS', async () => {
    const response = await axios.options(url, {
        headers: { Origin: 'http://outra-origem.example', 'Access-Control-Request-Method': 'GET' },
    });
    assert.strictEqual(response.status, 204);
    assert.strictEqual(response.headers['access-control-allow-origin'], undefined);
});
