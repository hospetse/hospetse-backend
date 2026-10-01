import { test } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import app from "../app.js";
const server = app.listen(0);
const { port } = server.address();

test('Check /health route', async () => {
    const response = await axios.get(`http://localhost:${port}/health`);
    assert.strictEqual(response.status, 200);
    server.close();
});
