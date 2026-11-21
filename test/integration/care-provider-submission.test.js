// #342: cadastro real de Sitter/Walker pelo JWT, com armazenamento local falso.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomInt, randomUUID } from 'node:crypto';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { FakeStorage } from '../../src/lib/fake-storage.js';
import { prisma } from '../../src/lib/prisma.js';
import { useStorage } from '../../src/lib/storage.js';

try { process.loadEnvFile(); } catch { /* DATABASE_URL pode vir do ambiente */ }
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente: configure um banco local de teste');

const { publicKey, privateKey } = await generateKeyPair('RS256');
process.env.JWT_PUBLIC_KEY = await exportSPKI(publicKey);
const storage = new FakeStorage();
useStorage(storage);
const { default: app } = await import('../../src/app.js');
const server = app.listen(0);
await once(server, 'listening');
const url = `http://localhost:${server.address().port}`;
const userIds = [];

after(async () => {
    server.close();
    const providers = await prisma.provider.findMany({ where: { userId: { in: userIds } }, select: { addressId: true } });
    await prisma.provider.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.tutor.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.address.deleteMany({ where: { id: { in: providers.map((provider) => provider.addressId).filter(Boolean) } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

const PDF = Buffer.from('%PDF-1.7 teste');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const fields = (res) => res.data.details.map((item) => item.field);

function cpf() {
    const digits = Array.from({ length: 9 }, () => randomInt(10));
    for (const length of [9, 10]) {
        const sum = digits.reduce((total, digit, index) => total + digit * (length + 1 - index), 0);
        digits.push((sum * 10) % 11 % 10);
    }
    return digits.join('');
}

async function user() {
    const authUserId = randomUUID();
    const saved = await prisma.user.create({ data: { authUserId, email: `it-care-${authUserId}@hospetse.test`, name: 'Teste' } });
    userIds.push(saved.id);
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject(authUserId)
        .setIssuer('hospetse-auth-service').setAudience('hospetse-backend').setExpirationTime('5m').sign(privateKey);
    return { saved, headers: { Authorization: `Bearer ${token}` } };
}

async function api(method, path, headers, body) {
    const json = body && !(body instanceof FormData);
    const res = await fetch(url + path, { method, headers: json ? { ...headers, 'Content-Type': 'application/json' } : headers, body: json ? JSON.stringify(body) : body });
    return { status: res.status, data: await res.json().catch(() => null) };
}

function form(buffer, values = {}) {
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) data.append(key, value);
    data.append('file', new Blob([buffer]), 'arquivo');
    return data;
}

function draft(providerType) {
    return {
        providerType, name: 'Cuidados de teste', personType: 'pf', cpfCnpj: cpf(),
        description: 'Cuidados em domicílio', administersMedication: false, experienceRange: '1_3', kilometerRadius: 5,
        address: { zipCode: '01001000', street: 'Rua Teste', number: '1', neighborhood: 'Centro', city: 'São Paulo', state: 'SP' },
        acceptedSpecies: ['dog'], acceptedSizes: ['small'],
    };
}

for (const providerType of ['pet_sitter', 'pet_walker']) {
    test(`${providerType}: Tutor mantém o papel e envia cadastro pendente com arquivos`, async () => {
        const { saved, headers } = await user();
        const tutor = await prisma.tutor.create({ data: { userId: saved.id, name: saved.name } });
        const body = draft(providerType);
        const created = await api('PUT', '/api/v1/me/provider', headers, body);
        assert.equal(created.status, 200);
        assert.equal(created.data.validationStatus, 'draft');
        assert.equal(created.data.cpfCnpjMasked, `***${body.cpfCnpj.slice(-4)}`);
        assert.ok(!JSON.stringify(created.data).includes(body.cpfCnpj));
        const document = await api('POST', '/api/v1/me/provider/documents', headers, form(PDF, { type: 'identity' }));
        assert.equal(document.status, 201);
        assert.equal((await api('POST', '/api/v1/me/provider/documents', headers, form(PDF, { type: 'proof_of_address' }))).status, 201);
        assert.equal((await api('POST', '/api/v1/me/provider/documents', headers, form(PDF, { type: 'qualification' }))).status, 201);
        assert.equal((await api('POST', '/api/v1/me/provider/photos', headers, form(JPEG))).status, 201);
        const link = await api('GET', `/api/v1/me/provider/documents/${document.data.id}`, headers);
        assert.equal(link.status, 200);
        assert.ok(link.data.url);
        assert.equal((await api('GET', `/api/v1/me/host/documents/${document.data.id}`, headers)).status, 404);
        const outsider = await user();
        assert.equal((await api('GET', `/api/v1/me/provider/documents/${document.data.id}`, outsider.headers)).status, 404);
        const before = Date.now();
        const sent = await api('POST', '/api/v1/me/provider/submit', headers);
        assert.equal(sent.status, 200);
        assert.equal(sent.data.validationStatus, 'pending');
        const provider = await prisma.provider.findUnique({ where: { userId: saved.id }, include: { petSitterDetail: true, petWalkerDetail: true, documents: true, photos: true } });
        assert.equal(provider.validationStatus, 'pending');
        assert.equal(provider.userId, tutor.userId);
        assert.ok(provider.submittedAt.getTime() >= before);
        assert.equal(Number(provider[providerType === 'pet_sitter' ? 'petSitterDetail' : 'petWalkerDetail'].kilometerRadius), 5);
        assert.equal(provider.urlPicture, provider.photos[0].url);
        assert.deepEqual(provider.documents.map((item) => item.type).sort(), ['identity', 'proof_of_address', 'qualification']);
        assert.equal((await api('GET', '/api/v1/me/host', headers)).status, 404);
        assert.equal((await api('GET', '/api/v1/me/host/reservations', headers)).status, 403);
        assert.equal((await api('PUT', '/api/v1/me/provider', headers, body)).status, 409);
        assert.equal((await api('POST', '/api/v1/me/provider/submit', headers)).status, 409);
    });
}

test('campos inválidos saem juntos e não criam perfil; incompleto continua rascunho', async () => {
    const { saved, headers } = await user();
    const invalid = await api('PUT', '/api/v1/me/provider', headers, {
        providerType: 'pet_walker', name: '', personType: 'xx', cpfCnpj: '123', kilometerRadius: -1, userId: randomUUID(),
    });
    assert.equal(invalid.status, 400);
    for (const field of ['name', 'personType', 'cpfCnpj', 'kilometerRadius', 'userId']) assert.ok(fields(invalid).includes(field), field);
    assert.equal(await prisma.provider.count({ where: { userId: saved.id } }), 0);
    const created = await api('PUT', '/api/v1/me/provider', headers, { providerType: 'pet_walker', name: 'Rascunho' });
    assert.equal(created.status, 200);
    const sent = await api('POST', '/api/v1/me/provider/submit', headers);
    assert.equal(sent.status, 400);
    for (const field of ['personType', 'description', 'cpfCnpj', 'address', 'kilometerRadius', 'administersMedication', 'experienceRange', 'photos', 'documents.identity', 'documents.proof_of_address']) assert.ok(fields(sent).includes(field), field);
    assert.equal((await prisma.provider.findUnique({ where: { userId: saved.id } })).validationStatus, 'draft');
    assert.equal((await api('PUT', '/api/v1/me/provider', headers, { providerType: 'pet_sitter', name: 'Mudança' })).status, 409);
});

test('PJ precisa do cartão CNPJ; corpo na submissão não altera o rascunho', async () => {
    const { saved, headers } = await user();
    const body = { ...draft('pet_sitter'), personType: 'pj', cpfCnpj: '11222333000181' };
    assert.equal((await api('PUT', '/api/v1/me/provider', headers, body)).status, 200);
    for (const type of ['identity', 'proof_of_address']) {
        assert.equal((await api('POST', '/api/v1/me/provider/documents', headers, form(PDF, { type }))).status, 201);
    }
    assert.equal((await api('POST', '/api/v1/me/provider/photos', headers, form(JPEG))).status, 201);
    const extra = await api('POST', '/api/v1/me/provider/submit', headers, { userId: randomUUID() });
    assert.equal(extra.status, 400);
    assert.deepEqual(fields(extra), ['userId']);
    const missing = await api('POST', '/api/v1/me/provider/submit', headers);
    assert.equal(missing.status, 400);
    assert.deepEqual(fields(missing), ['documents.cnpj_card']);
    assert.equal((await prisma.provider.findUnique({ where: { userId: saved.id } })).validationStatus, 'draft');
    assert.equal((await api('POST', '/api/v1/me/provider/documents', headers, form(PDF, { type: 'cnpj_card' }))).status, 201);
    assert.equal((await api('POST', '/api/v1/me/provider/submit', headers)).status, 200);
});
