import { test, after } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import app from "../src/app.js";
const server = app.listen(0);
const { port } = server.address();

after(() => server.close());

test('Check /health route', async () => {
    const response = await axios.get(`http://localhost:${port}/health`);
    assert.strictEqual(response.status, 200);
});

test('/docs serve a página do Swagger UI e o contrato que ela lê', async () => {
    const page = await axios.get(`http://localhost:${port}/docs`);
    assert.strictEqual(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.data, /\/docs\/openapi\.yaml/);

    const contract = await axios.get(`http://localhost:${port}/docs/openapi.yaml`);
    assert.strictEqual(contract.status, 200);
    assert.match(contract.headers['content-type'], /text\/yaml/);
    assert.match(contract.data, /^openapi: 3\.1\.0/);
});

test('rota inexistente fora do /api/v1 responde 404 em JSON', async () => {
    const response = await axios.get(`http://localhost:${port}/`, { validateStatus: () => true });
    assert.strictEqual(response.status, 404);
    assert.deepStrictEqual(response.data, { code: 'NOT_FOUND', message: 'Rota não encontrada' });
});
