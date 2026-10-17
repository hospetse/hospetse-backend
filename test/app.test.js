import { test, after } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import app from "../app.js";
const server = app.listen(0);
const { port } = server.address();

after(() => server.close());

test('Check /health route', async () => {
    const response = await axios.get(`http://localhost:${port}/health`);
    assert.strictEqual(response.status, 200);
});

test('Check / route', async () => {
    const response = await axios.get(`http://localhost:${port}/`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.data, 'Hello World');
});
