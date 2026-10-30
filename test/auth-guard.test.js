// Proteção das rotas (TSK-04 #298), sem banco: todos os casos param no middleware antes de consultar o USER.
// O JWT é assinado por chaves geradas aqui; a JWT_PUBLIC_KEY do processo é trocada pela chave pública delas.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import axios from 'axios';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const other = await generateKeyPair('RS256');
process.env.JWT_PUBLIC_KEY = await exportSPKI(publicKey);
process.env.INTERNAL_SERVICE_TOKEN = 'token-de-servico-de-teste';

const { default: app } = await import('../src/app.js');
const server = app.listen(0);
await once(server, 'listening');
const http = axios.create({ baseURL: `http://localhost:${server.address().port}`, validateStatus: () => true });

after(() => server.close());

// Únicas rotas que respondem sem autenticação. Uma rota pública nova precisa entrar aqui e no OpenAPI.
const PUBLIC_ROUTES = ['GET /health', 'GET /health/ready', 'GET /docs', 'GET /docs/openapi.yaml'];

function token({ iss = 'hospetse-auth-service', aud = 'hospetse-backend', exp = '5m', key = privateKey } = {}) {
    return new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('00000000-0000-0000-0000-000000000000')
        .setIssuer(iss)
        .setAudience(aud)
        .setExpirationTime(exp)
        .sign(key);
}

const bearer = (value) => ({ headers: { Authorization: `Bearer ${value}` } });

test('inventário: toda rota fora da lista de públicas exige autenticação', async () => {
    const routes = app.router.stack
        .filter((layer) => layer.route)
        .flatMap((layer) => Object.keys(layer.route.methods).map((method) => ({ method, path: layer.route.path })));

    for (const { method, path } of routes) {
        if (PUBLIC_ROUTES.includes(`${method.toUpperCase()} ${path}`)) continue;
        const res = await http.request({ method, url: path.replace(/:\w+/g, 'x') });
        assert.strictEqual(res.status, 401, `${method.toUpperCase()} ${path} respondeu ${res.status} sem token`);
    }
});

test('sem token, com token mal formado e com outro esquema: 401 TOKEN_INVALID', async () => {
    for (const config of [{}, bearer('nao-e-jwt'), { headers: { Authorization: 'Basic abc' } }]) {
        const res = await http.get('/api/v1/me', config);
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.data.code, 'TOKEN_INVALID');
    }
});

test('token expirado: 401', async () => {
    const res = await http.get('/api/v1/me', bearer(await token({ exp: '-1m' })));
    assert.strictEqual(res.status, 401);
});

test('token assinado por outra chave: 401', async () => {
    const res = await http.get('/api/v1/me', bearer(await token({ key: other.privateKey })));
    assert.strictEqual(res.status, 401);
});

test('iss ou aud diferentes: 401', async () => {
    const wrongIss = await http.get('/api/v1/me', bearer(await token({ iss: 'outro-emissor' })));
    const wrongAud = await http.get('/api/v1/me', bearer(await token({ aud: 'hospetse-backend-internal' })));
    assert.strictEqual(wrongIss.status, 401);
    assert.strictEqual(wrongAud.status, 401);
});

test('rota inexistente sob /api/v1 sem token: 401, sem revelar que a rota não existe', async () => {
    const res = await http.get('/api/v1/nao-existe');
    assert.strictEqual(res.status, 401);
});

test('rota interna não aceita o JWT do usuário no lugar do token de serviço', async () => {
    const res = await http.put('/api/v1/internal/users/x', {}, bearer(await token()));
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.data.code, 'SERVICE_TOKEN_INVALID');
});

test('rota interna com maiúsculas ou sem / no fim: só o token de serviço é exigido, como em minúsculas', async () => {
    const service = bearer('token-de-servico-de-teste');
    // body vazio para na validação do controller (400), antes de chegar no banco
    const upper = await http.put('/api/v1/INTERNAL/users/x', {}, service);
    assert.strictEqual(upper.status, 400);
    assert.strictEqual(upper.data.code, 'VALIDATION_ERROR');
    const noSlash = await http.get('/api/v1/internal', service);
    assert.strictEqual(noSlash.status, 404);
});

test('JSON malformado: 400 em JSON, não a página HTML do Express', async () => {
    const res = await http.put('/api/v1/internal/users/x', '{"email":', {
        headers: { Authorization: 'Bearer token-de-servico-de-teste', 'Content-Type': 'application/json' },
    });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data, { code: 'VALIDATION_ERROR', message: 'JSON inválido' });
});
