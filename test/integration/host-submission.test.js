// Submissão do Host de ponta a ponta (HSP-PBI-008-TSK-07 #327): nada é publicado antes da validação. Exige DATABASE_URL.
// Cobre os critérios do #110 pelas rotas reais, do rascunho até a oferta aparecer. As regras de cada rota estão em host-profile.test.js e host-files.test.js.
// Serviço e aprovação vão direto para o banco, porque essas rotas ainda não existem. O bucket é o FakeStorage, sem rede.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomInt, randomUUID } from 'node:crypto';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { FakeStorage } from '../../src/lib/fake-storage.js';
import { prisma } from '../../src/lib/prisma.js';
import { useStorage } from '../../src/lib/storage.js';

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
useStorage(new FakeStorage());

const { default: app } = await import('../../src/app.js');
const server = app.listen(0);
await once(server, 'listening');
const baseUrl = `http://localhost:${server.address().port}`;

const userIds = [];
const tutorIds = [];

after(async () => {
    server.close();
    const providers = await prisma.provider.findMany({ where: { userId: { in: userIds } }, select: { id: true, addressId: true } });
    const providerIds = providers.map((provider) => provider.id);
    await prisma.reservation.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.pet.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.tutor.deleteMany({ where: { id: { in: tutorIds } } });
    await prisma.service.deleteMany({ where: { providerId: { in: providerIds } } });
    // documentos, fotos e hotel_details saem em cascata com o prestador
    await prisma.provider.deleteMany({ where: { id: { in: providerIds } } });
    await prisma.address.deleteMany({ where: { id: { in: providers.map((provider) => provider.addressId).filter(Boolean) } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

const PDF = Buffer.from('%PDF-1.7 conteúdo');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const day = (offset) => new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function api(method, path, headers, body) {
    const isJson = body && !(body instanceof FormData);
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: isJson ? { ...headers, 'Content-Type': 'application/json' } : headers,
        body: isJson ? JSON.stringify(body) : body,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
}

function form(buffer, fields = {}) {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.append(name, value);
    data.append('file', new Blob([buffer]), 'arquivo');
    return data;
}

function randomCpf() {
    const digits = Array.from({ length: 9 }, () => randomInt(10));
    for (const length of [9, 10]) {
        const sum = digits.reduce((total, digit, index) => total + digit * (length + 1 - index), 0);
        digits.push((sum * 10) % 11 % 10);
    }
    return digits.join('');
}

async function newUser(data = {}) {
    const authUserId = randomUUID();
    const user = await prisma.user.create({ data: { authUserId, email: `it-submissao-${authUserId}@exemplo.com`, name: 'Teste Submissão', ...data } });
    userIds.push(user.id);
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(authUserId)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setExpirationTime('5m')
        .sign(privateKey);
    return { user, headers: { Authorization: `Bearer ${token}` } };
}

// Tutor apto a contratar, com um cachorro pequeno
async function newTutor() {
    const { user, headers } = await newUser({ status: 'active', profileStatus: 'complete' });
    const tutor = await prisma.tutor.create({ data: { userId: user.id, name: user.name } });
    tutorIds.push(tutor.id);
    const pet = await prisma.pet.create({ data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog', petSize: 'small' } });
    return { tutor, pet, headers };
}

const draftBody = (city, overrides = {}) => ({
    providerType: 'hotel',
    name: 'Hotelzinho',
    description: 'Casa com quintal coberto',
    cpfCnpj: randomCpf(),
    address: { zipCode: '01001000', street: 'Rua Teste', number: '1', neighborhood: 'Centro', city, state: 'SP' },
    capacity: 1,
    acceptedSpecies: ['dog'],
    acceptedSizes: ['small'],
    ...overrides,
});

// Rascunho completo pelas rotas, com o serviço que tornaria a oferta visível: só a situação de validação decide
async function newDraft(overrides) {
    const city = `it-submissao-${randomUUID()}`;
    const { headers } = await newUser();
    const { data } = await api('PUT', '/api/v1/me/host', headers, draftBody(city, overrides));
    const send = (path, buffer, fields) => api('POST', path, headers, form(buffer, fields));
    await send('/api/v1/me/host/documents', PDF, { type: 'identity' });
    await send('/api/v1/me/host/documents', JPEG, { type: 'proof_of_address' });
    await send('/api/v1/me/host/photos', JPEG);
    const service = await prisma.service.create({ data: { providerId: data.id, name: 'Diária', price: 100 } });
    return { headers, city, id: data.id, service };
}

const setStatus = (id, validationStatus) => prisma.provider.update({ where: { id }, data: { validationStatus } });
const search = (city, headers) => api('GET', `/api/v1/hosts/search?city=${encodeURIComponent(city)}`, headers);
const details = (id, headers) => api('GET', `/api/v1/hosts/${id}`, headers);
const request = (service, { pet, headers }) => api('POST', '/api/v1/reservations', { ...headers, 'Idempotency-Key': randomUUID() }, {
    serviceId: service.id, petId: pet.id, startDate: day(10), endDate: day(12),
});

async function assertUnavailable({ id, city, service }, tutor) {
    assert.strictEqual((await search(city, tutor.headers)).data.total, 0);
    assert.strictEqual((await details(id, tutor.headers)).status, 404);
    const res = await request(service, tutor);
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data.details.map((detail) => detail.field), ['serviceId']);
    assert.strictEqual(await prisma.reservation.count({ where: { serviceId: service.id } }), 0);
}

test('AC-01: cadastro completo pelas rotas fica pendente, com endereço, capacidade, restrições e anexos gravados', async () => {
    const { headers, id } = await newDraft({ capacity: 4 });

    const res = await api('POST', '/api/v1/me/host/submit', headers);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.validationStatus, 'pending');
    const saved = await prisma.provider.findUnique({ where: { id }, include: { address: true, hotelDetail: true, documents: true, photos: true } });
    assert.strictEqual(saved.validationStatus, 'pending');
    assert.strictEqual(saved.address.street, 'Rua Teste');
    assert.strictEqual(saved.hotelDetail.capacity, 4);
    assert.deepStrictEqual(saved.acceptedSpecies, ['dog']);
    assert.deepStrictEqual(saved.documents.map((document) => document.type).sort(), ['identity', 'proof_of_address']);
    assert.strictEqual(saved.photos.length, 1);
    assert.strictEqual(saved.urlPicture, saved.photos[0].url);
});

test('AC-02: rascunho fica indisponível na busca, nos detalhes e para solicitação', async () => {
    await assertUnavailable(await newDraft(), await newTutor());
});

test('AC-02: pendente fica indisponível na busca, nos detalhes e para solicitação', async () => {
    const host = await newDraft();
    await api('POST', '/api/v1/me/host/submit', host.headers);
    await assertUnavailable(host, await newTutor());
});

test('AC-02: rejeitado fica indisponível na busca, nos detalhes e para solicitação', async () => {
    const host = await newDraft();
    await api('POST', '/api/v1/me/host/submit', host.headers);
    await setStatus(host.id, 'rejected');
    await assertUnavailable(host, await newTutor());
});

test('o mesmo cadastro, depois de aprovado, aparece e recebe solicitação', async () => {
    const host = await newDraft();
    const tutor = await newTutor();
    await api('POST', '/api/v1/me/host/submit', host.headers);
    await setStatus(host.id, 'approved');

    const found = await search(host.city, tutor.headers);
    assert.strictEqual(found.data.total, 1);
    assert.strictEqual(found.data.items[0].hostId, host.id);
    assert.match(found.data.items[0].pictureUrl, /signed=1/);

    const shown = await details(host.id, tutor.headers);
    assert.strictEqual(shown.status, 200);
    assert.match(shown.data.photos[0], /signed=1/);

    assert.strictEqual((await request(host.service, tutor)).status, 201);
});

test('a capacidade informada no cadastro vale na solicitação', async () => {
    const host = await newDraft({ capacity: 1 });
    const first = await newTutor();
    const second = await newTutor();
    await api('POST', '/api/v1/me/host/submit', host.headers);
    await setStatus(host.id, 'approved');
    await prisma.reservation.create({
        data: {
            tutorId: first.tutor.id, petId: first.pet.id, serviceId: host.service.id, status: 'accepted',
            startDate: new Date(day(10)), endDate: new Date(day(12)), dailyPrice: 100, totalValue: 200,
        },
    });

    const full = await request(host.service, second);
    assert.strictEqual(full.status, 409);
    assert.strictEqual(full.data.code, 'NO_CAPACITY');

    await prisma.hotelDetail.update({ where: { providerId: host.id }, data: { capacity: 2 } });
    assert.strictEqual((await request(host.service, second)).status, 201);
});

test('AC-03: envio com campos faltando identifica os erros e nada fica publicável', async () => {
    const city = `it-submissao-${randomUUID()}`;
    const { headers } = await newUser();
    const tutor = await newTutor();
    const { data } = await api('PUT', '/api/v1/me/host', headers, { providerType: 'hotel', name: 'Incompleto', address: draftBody(city).address });
    await prisma.service.create({ data: { providerId: data.id, name: 'Diária', price: 100 } });

    const res = await api('POST', '/api/v1/me/host/submit', headers);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'VALIDATION_ERROR');
    assert.ok(res.data.details.length > 1);
    assert.strictEqual((await prisma.provider.findUnique({ where: { id: data.id } })).validationStatus, 'draft');
    assert.strictEqual((await search(city, tutor.headers)).data.total, 0);
});

test('AC-03: PUT inválido não cria nenhum perfil', async () => {
    const { user, headers } = await newUser();
    const res = await api('PUT', '/api/v1/me/host', headers, draftBody('Cidade', { capacity: 0, cpfCnpj: '123' }));

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data.details.map((detail) => detail.field).sort(), ['capacity', 'cpfCnpj']);
    assert.strictEqual(await prisma.provider.count({ where: { userId: user.id } }), 0);
});

test('documento protegido: nada sai nas consultas públicas, nem de Host aprovado', async () => {
    const host = await newDraft();
    const tutor = await newTutor();
    await api('POST', '/api/v1/me/host/submit', host.headers);
    await setStatus(host.id, 'approved');
    const { storageKey, id: documentId } = await prisma.providerDocument.findFirst({ where: { providerId: host.id } });

    const responses = [await search(host.city, tutor.headers), await details(host.id, tutor.headers)];
    for (const { data } of responses) {
        const body = JSON.stringify(data);
        assert.ok(!body.includes(storageKey));
        assert.ok(!body.includes('documents/'));
        assert.ok(!body.includes(documentId));
    }

    // o Tutor também não abre o documento pela rota do titular
    assert.strictEqual((await api('GET', `/api/v1/me/host/documents/${documentId}`, tutor.headers)).status, 404);
    assert.strictEqual((await api('GET', `/api/v1/me/host/documents/${documentId}`, host.headers)).status, 200);
});

test('titular diferente: outro usuário não envia nem anexa no cadastro de ninguém', async () => {
    const owner = await newDraft();
    const { user, headers } = await newUser();

    assert.strictEqual((await api('POST', '/api/v1/me/host/submit', headers)).status, 404);
    assert.strictEqual((await api('POST', '/api/v1/me/host/photos', headers, form(JPEG))).status, 404);
    const before = await prisma.providerPhoto.count({ where: { providerId: owner.id } });

    // O PUT do outro usuário cria o cadastro dele, sem tocar no do titular
    const own = await api('PUT', '/api/v1/me/host', headers, { providerType: 'hotel', name: 'Do outro usuário' });
    assert.notStrictEqual(own.data.id, owner.id);
    assert.strictEqual((await prisma.provider.findUnique({ where: { userId: user.id } })).id, own.data.id);

    const saved = await prisma.provider.findUnique({ where: { id: owner.id } });
    assert.strictEqual(saved.name, 'Hotelzinho');
    assert.strictEqual(saved.validationStatus, 'draft');
    assert.strictEqual(await prisma.providerPhoto.count({ where: { providerId: owner.id } }), before);
});
