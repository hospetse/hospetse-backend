// Cadastro do Host (HSP-PBI-008-TSK-05 #325) contra o PostgreSQL real. Exige DATABASE_URL.
// Cria USERs (e-mail it-host-...@exemplo.com) e prestadores de teste, e remove tudo o que criou no after.
// O JWT é assinado por um par de chaves gerado aqui: não depende do Auth.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomInt, randomUUID } from 'node:crypto';
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
const http = axios.create({ baseURL: `http://localhost:${server.address().port}`, validateStatus: () => true });

const userIds = [];

after(async () => {
    server.close();
    const providers = await prisma.provider.findMany({ where: { userId: { in: userIds } }, select: { id: true, addressId: true } });
    // documentos e fotos saem em cascata com o prestador
    await prisma.service.deleteMany({ where: { providerId: { in: providers.map((provider) => provider.id) } } });
    await prisma.provider.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.address.deleteMany({ where: { id: { in: providers.map((provider) => provider.addressId).filter(Boolean) } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

// Documentos aleatórios e válidos: o UNIQUE vale entre todos os prestadores do banco
function randomCpf() {
    const digits = Array.from({ length: 9 }, () => randomInt(10));
    for (const length of [9, 10]) {
        const sum = digits.reduce((total, digit, index) => total + digit * (length + 1 - index), 0);
        digits.push((sum * 10) % 11 % 10);
    }
    return digits.join('');
}

function randomCnpj() {
    const digits = [...Array.from({ length: 8 }, () => randomInt(10)), 0, 0, 0, 1];
    for (const weights of [[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]]) {
        const rest = digits.reduce((total, digit, index) => total + digit * weights[index], 0) % 11;
        digits.push(rest < 2 ? 0 : 11 - rest);
    }
    return digits.join('');
}

async function newUser() {
    const authUserId = randomUUID();
    const user = await prisma.user.create({ data: { authUserId, email: `it-host-${authUserId}@exemplo.com`, name: 'Teste Host' } });
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

const newCity = () => `it-host-${randomUUID()}`;
const address = (city = newCity()) => ({
    zipCode: '01001-000', street: 'Rua Teste', number: '1', neighborhood: 'Centro', city, state: 'sp',
});
const minimal = { providerType: 'hotel', name: 'Hotelzinho' };
const complete = (overrides = {}) => ({
    ...minimal,
    description: 'Casa com quintal',
    cpfCnpj: randomCpf(),
    address: address(),
    capacity: 5,
    acceptedSpecies: ['dog'],
    acceptedSizes: ['small', 'medium'],
    acceptedBreeds: [],
    ...overrides,
});

const put = (body, headers) => http.put('/api/v1/me/host', body, { headers });
const get = (headers) => http.get('/api/v1/me/host', { headers });
const submit = (headers) => http.post('/api/v1/me/host/submit', null, { headers });

// As rotas de arquivo chegam na próxima parte da #325: aqui os anexos vão direto para o banco
async function attachFiles(providerId, types = ['identity', 'proof_of_address']) {
    await prisma.providerDocument.createMany({ data: types.map((type) => ({ providerId, type, storageKey: `documents/${providerId}/${type}` })) });
    await prisma.providerPhoto.create({ data: { providerId, url: 'https://exemplo.com/principal.jpg' } });
}

// Rascunho completo, pronto para enviar
async function readyDraft(overrides) {
    const owner = await newUser();
    const { data } = await put(complete(overrides), owner.headers);
    await attachFiles(data.id);
    return { ...owner, id: data.id };
}

test('sem token: 401 nas três rotas', async () => {
    for (const res of [await put(minimal), await get(), await submit()]) {
        assert.strictEqual(res.status, 401);
    }
});

test('primeiro PUT cria o rascunho do próprio usuário', async () => {
    const { user, headers } = await newUser();
    const res = await put(minimal, headers);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.validationStatus, 'draft');
    assert.strictEqual(res.data.name, 'Hotelzinho');
    const saved = await prisma.provider.findUnique({ where: { userId: user.id } });
    assert.strictEqual(saved.id, res.data.id);
    assert.strictEqual(saved.validationStatus, 'draft');
});

test('PUT seguinte atualiza o mesmo rascunho e mantém o que foi omitido', async () => {
    const { user, headers } = await newUser();
    const first = await put(complete({ description: 'Primeira versão' }), headers);
    const second = await put({ ...minimal, name: 'Novo nome' }, headers);

    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.data.id, first.data.id);
    assert.strictEqual(second.data.name, 'Novo nome');
    assert.strictEqual(second.data.description, 'Primeira versão');
    assert.strictEqual(second.data.address.street, 'Rua Teste');
    assert.strictEqual(await prisma.provider.count({ where: { userId: user.id } }), 1);
});

test('atualizar o endereço não cria outro', async () => {
    const { user, headers } = await newUser();
    await put(complete(), headers);
    const { addressId } = await prisma.provider.findUnique({ where: { userId: user.id } });

    const res = await put({ ...minimal, address: { ...address(), street: 'Rua Nova' } }, headers);

    assert.strictEqual(res.data.address.street, 'Rua Nova');
    const updated = await prisma.provider.findUnique({ where: { userId: user.id } });
    assert.strictEqual(updated.addressId, addressId);
});

test('capacidade: grava na primeira chamada, atualiza e, omitida, não muda', async () => {
    const { user, headers } = await newUser();
    const saved = async () => (await prisma.hotelDetail.findFirst({ where: { provider: { userId: user.id } } })).capacity;

    const created = await put({ ...minimal, capacity: 3 }, headers);
    assert.strictEqual(created.data.capacity, 3);
    assert.strictEqual(await saved(), 3);

    assert.strictEqual((await put({ ...minimal, capacity: 7 }, headers)).data.capacity, 7);
    assert.strictEqual(await saved(), 7);

    assert.strictEqual((await put(minimal, headers)).data.capacity, 7);
});

test('capacidade adicionada depois do primeiro rascunho', async () => {
    const { headers } = await newUser();
    assert.strictEqual((await put(minimal, headers)).data.capacity, null);
    assert.strictEqual((await put({ ...minimal, capacity: 2 }, headers)).data.capacity, 2);
    assert.strictEqual((await get(headers)).data.capacity, 2);
});

test('PUT inválido lista todos os erros e não cria nada', async () => {
    const { user, headers } = await newUser();
    const res = await put({ providerType: 'pet_walker', cpfCnpj: '123', extra: 1 }, headers);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'VALIDATION_ERROR');
    const fields = res.data.details.map((detail) => detail.field);
    for (const field of ['providerType', 'name', 'cpfCnpj', 'extra']) assert.ok(fields.includes(field), field);
    assert.strictEqual(await prisma.provider.count({ where: { userId: user.id } }), 0);
});

test('id de outro usuário no body é recusado', async () => {
    const { headers } = await newUser();
    const other = await newUser();
    const res = await put({ ...minimal, userId: other.user.id }, headers);

    assert.strictEqual(res.status, 400);
    assert.ok(res.data.details.some((detail) => detail.field === 'userId'));
});

test('um usuário não vê nem altera o rascunho de outro', async () => {
    const owner = await newUser();
    const other = await newUser();
    await put({ ...minimal, name: 'Do titular' }, owner.headers);

    assert.strictEqual((await get(other.headers)).status, 404);
    await put({ ...minimal, name: 'Do outro' }, other.headers);
    assert.strictEqual((await get(owner.headers)).data.name, 'Do titular');
});

test('CPF já usado por outro prestador é recusado junto com os outros erros', async () => {
    const cpfCnpj = randomCpf();
    await put(complete({ cpfCnpj }), (await newUser()).headers);
    const { headers } = await newUser();

    const res = await put({ ...complete({ cpfCnpj }), extra: 1 }, headers);

    assert.strictEqual(res.status, 400);
    const fields = res.data.details.map((detail) => detail.field);
    assert.ok(fields.includes('cpfCnpj'));
    assert.ok(fields.includes('extra'));
});

test('o próprio usuário pode repetir o CPF no rascunho', async () => {
    const cpfCnpj = randomCpf();
    const { headers } = await newUser();
    await put(complete({ cpfCnpj }), headers);
    assert.strictEqual((await put(complete({ cpfCnpj, address: address() }), headers)).status, 200);
});

test('GET sem cadastro: 404', async () => {
    const res = await get((await newUser()).headers);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.data.code, 'NOT_FOUND');
});

test('GET retoma o rascunho com CPF mascarado e sem a chave dos documentos', async () => {
    const cpfCnpj = randomCpf();
    const { headers, user } = await newUser();
    await put(complete({ cpfCnpj }), headers);
    const provider = await prisma.provider.findUnique({ where: { userId: user.id } });
    await attachFiles(provider.id);

    const res = await get(headers);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.cpfCnpjMasked, `***${cpfCnpj.slice(-4)}`);
    assert.deepStrictEqual(res.data.documents.map((document) => document.type).sort(), ['identity', 'proof_of_address']);
    assert.deepStrictEqual(res.data.photos.map((photo) => photo.url), ['https://exemplo.com/principal.jpg']);
    const body = JSON.stringify(res.data);
    assert.ok(!body.includes(cpfCnpj));
    assert.ok(!body.includes('documents/'));
    assert.ok(!body.includes('storageKey'));
});

test('enviar sem cadastro: 404', async () => {
    assert.strictEqual((await submit((await newUser()).headers)).status, 404);
});

test('enviar rascunho incompleto lista tudo o que falta e continua rascunho', async () => {
    const { headers, user } = await newUser();
    await put(minimal, headers);

    const res = await submit(headers);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'VALIDATION_ERROR');
    const fields = res.data.details.map((detail) => detail.field);
    for (const field of ['description', 'cpfCnpj', 'address', 'capacity', 'acceptedSpecies', 'acceptedSizes', 'photos', 'documents.identity', 'documents.proof_of_address']) {
        assert.ok(fields.includes(field), field);
    }
    const saved = await prisma.provider.findUnique({ where: { userId: user.id } });
    assert.strictEqual(saved.validationStatus, 'draft');
});

test('CNPJ sem o cartão CNPJ não é enviado', async () => {
    const { headers } = await readyDraft({ cpfCnpj: randomCnpj() });
    const res = await submit(headers);
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data.details.map((detail) => detail.field), ['documents.cnpj_card']);
});

test('envio válido deixa o perfil pendente, com a primeira foto como principal', async () => {
    const { headers, id } = await readyDraft();

    const res = await submit(headers);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.validationStatus, 'pending');
    const saved = await prisma.provider.findUnique({ where: { id } });
    assert.strictEqual(saved.validationStatus, 'pending');
    assert.strictEqual(saved.urlPicture, 'https://exemplo.com/principal.jpg');
    assert.strictEqual((await get(headers)).data.validationStatus, 'pending');
});

test('depois de enviado não edita nem envia de novo: 409', async () => {
    const { headers } = await readyDraft();
    await submit(headers);

    for (const res of [await put(minimal, headers), await submit(headers)]) {
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.data.code, 'HOST_ALREADY_SUBMITTED');
    }
});

test('dois envios ao mesmo tempo: só um passa', async () => {
    const { headers } = await readyDraft();
    const statuses = (await Promise.all([submit(headers), submit(headers)])).map((res) => res.status).sort();
    assert.deepStrictEqual(statuses, [200, 409]);
});

test('rascunho e pendente não aparecem na busca nem nos detalhes', async () => {
    const viewer = await newUser();
    const city = newCity();
    const draft = await readyDraft({ address: address(city) });
    const pending = await readyDraft({ address: address(city) });
    await submit(pending.headers);
    for (const { id } of [draft, pending]) {
        await prisma.service.create({ data: { providerId: id, name: 'Diária', price: 100 } });
    }

    const search = await http.get('/api/v1/hosts/search', { params: { city }, headers: viewer.headers });
    assert.strictEqual(search.status, 200);
    assert.strictEqual(search.data.total, 0);

    for (const { id } of [draft, pending]) {
        assert.strictEqual((await http.get(`/api/v1/hosts/${id}`, { headers: viewer.headers })).status, 404);
    }
});

test('quem só tem rascunho ainda não acessa as rotas de Host; depois de enviar, acessa', async () => {
    const { headers } = await readyDraft();
    const agenda = () => http.get('/api/v1/me/host/agenda', { headers });

    const before = await agenda();
    assert.strictEqual(before.status, 403);
    assert.strictEqual(before.data.code, 'HOST_REQUIRED');

    await submit(headers);
    assert.strictEqual((await agenda()).status, 200);
});
