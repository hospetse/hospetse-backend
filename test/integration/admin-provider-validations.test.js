// Fila, detalhe (#398), aprovação e reprovação (#404) da validação de prestadores, contra o PostgreSQL real. Exige DATABASE_URL.
// Cria USERs it-admin-validations-* com os cadastros direto no banco e apaga tudo no final. O bucket é o FakeStorage, sem rede.
// A fila é global e os arquivos de teste rodam em paralelo: cada teste procura os próprios cadastros, sem contar com fila vazia.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomInt, randomUUID } from 'node:crypto';
import axios from 'axios';
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
process.env.STORAGE_SIGNED_URL_SECONDS = '120';
useStorage(new FakeStorage());

const { default: app } = await import('../../src/app.js');
const server = app.listen(0);
await once(server, 'listening');
const http = axios.create({ baseURL: `http://localhost:${server.address().port}`, validateStatus: () => true });

const userIds = [];
const addressIds = [];

async function createUser(accountType = 'user') {
    const authUserId = randomUUID();
    const user = await prisma.user.create({
        data: { authUserId, email: `it-admin-validations-${authUserId}@hospetse.dev`, name: 'Teste', accountType },
    });
    userIds.push(user.id);
    return user;
}

const admin = await createUser('admin');
const common = await createUser();

after(async () => {
    server.close();
    // documentos, fotos e hotel_details saem em cascata com o prestador
    await prisma.provider.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.address.deleteMany({ where: { id: { in: addressIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

async function bearer(user) {
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(user.authUserId)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setExpirationTime('5m')
        .sign(privateKey);
    return { headers: { Authorization: `Bearer ${token}` } };
}

// Datas bem antigas: os cadastros deste arquivo ficam no começo da fila, antes dos pendentes de outros arquivos
const sentAt = (minutes) => new Date(Date.UTC(2001, 0, 1, 0, minutes));

async function createProvider(data = {}) {
    const user = await createUser();
    return prisma.provider.create({
        data: { userId: user.id, providerType: 'hotel', name: 'Hotel it-admin-validations', validationStatus: 'pending', submittedAt: sentAt(0), ...data },
    });
}

const queue = async (query = '') => http.get(`/api/v1/admin/provider-validations${query}`, await bearer(admin));
const detail = async (id, user = admin) => http.get(`/api/v1/admin/provider-validations/${id}`, await bearer(user));
// Todas as páginas, para achar os cadastros do teste mesmo com pendentes de outros arquivos na fila
async function queueIds(query = '') {
    const ids = [];
    for (let page = 1; ; page += 1) {
        const { data } = await queue(`?pageSize=50&page=${page}${query}`);
        ids.push(...data.items.map((item) => item.providerId));
        if (page * 50 >= data.total) return ids;
    }
}

test('fila mostra só cadastros pending', async () => {
    const created = {};
    for (const validationStatus of ['draft', 'pending', 'approved', 'rejected']) {
        created[validationStatus] = await createProvider({ validationStatus });
    }
    await prisma.providerDocument.create({ data: { providerId: created.pending.id, type: 'identity', storageKey: `documents/${randomUUID()}` } });
    await prisma.providerPhoto.createMany({ data: [1, 2].map((n) => ({ providerId: created.pending.id, url: `photos/${randomUUID()}-${n}` })) });

    const res = await queue('?pageSize=50');

    assert.strictEqual(res.status, 200);
    const ids = await queueIds();
    assert.ok(ids.includes(created.pending.id));
    for (const status of ['draft', 'approved', 'rejected']) assert.ok(!ids.includes(created[status].id), status);
    assert.deepStrictEqual(res.data.items.find((item) => item.providerId === created.pending.id), {
        providerId: created.pending.id,
        providerType: 'hotel',
        name: 'Hotel it-admin-validations',
        submittedAt: sentAt(0).toISOString(),
        documentCount: 1,
        photoCount: 2,
    });
    // a fila não leva nenhum link nem chave de arquivo
    assert.ok(!JSON.stringify(res.data).includes('fake-storage.test'));
    assert.ok(!JSON.stringify(res.data).includes('documents/'));
});

test('fila ordena do envio mais antigo para o mais novo', async () => {
    const newest = await createProvider({ submittedAt: sentAt(30) });
    const oldest = await createProvider({ submittedAt: sentAt(10) });
    const middle = await createProvider({ submittedAt: sentAt(20) });
    // mesma data de envio: o desempate é pelo id
    const tied = [await createProvider({ submittedAt: sentAt(40) }), await createProvider({ submittedAt: sentAt(40) })]
        .map((provider) => provider.id).sort();

    const mine = [oldest.id, middle.id, newest.id, ...tied];
    const ids = (await queueIds()).filter((id) => mine.includes(id));

    assert.deepStrictEqual(ids, mine);
});

test('fila filtra por providerType e pagina com total correto', async () => {
    // pet_walker ainda não tem cadastro pelas rotas (#342): o que existir na fila é só deste teste
    const walkers = [];
    for (const minutes of [1, 2, 3]) walkers.push(await createProvider({ providerType: 'pet_walker', submittedAt: sentAt(minutes) }));
    const hotel = await createProvider();

    const first = await queue('?providerType=pet_walker&pageSize=2');
    const second = await queue('?providerType=pet_walker&pageSize=2&page=2');

    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual([first.data.page, first.data.pageSize, first.data.total], [1, 2, 3]);
    assert.deepStrictEqual([second.data.page, second.data.pageSize, second.data.total], [2, 2, 3]);
    assert.deepStrictEqual(first.data.items.map((item) => item.providerId), [walkers[0].id, walkers[1].id]);
    assert.deepStrictEqual(second.data.items.map((item) => item.providerId), [walkers[2].id]);
    assert.ok(first.data.items.every((item) => item.providerType === 'pet_walker'));

    assert.strictEqual((await queue('?providerType=pet_walker&page=3&pageSize=2')).data.items.length, 0);
    assert.ok((await queueIds('&providerType=hotel')).includes(hotel.id));
    assert.ok(!(await queueIds('&providerType=pet_sitter')).includes(hotel.id));
});

test('fila recusa parâmetro inválido com todos os details', async () => {
    const res = await queue('?providerType=clinic&page=0&pageSize=51&sort=name&page=2');

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'VALIDATION_ERROR');
    assert.deepStrictEqual(res.data.details.map((item) => item.field).sort(), ['page', 'pageSize', 'providerType', 'sort']);
    assert.strictEqual(res.data.items, undefined);
});

// Cadastro completo, como sai da submissão do Host
async function createFullProvider(data = {}) {
    const address = await prisma.address.create({
        data: { zipCode: '01234000', street: 'Rua Secreta', number: '987', neighborhood: 'Centro', city: 'São Paulo', state: 'SP' },
    });
    addressIds.push(address.id);
    const provider = await createProvider({
        addressId: address.id,
        cpfCnpj: `${randomInt(1e9, 1e10)}1234`,
        description: 'Casa com quintal',
        acceptedSpecies: ['dog'],
        acceptedSizes: ['small', 'medium'],
        acceptedBreeds: [],
        hotelDetail: { create: { capacity: 3 } },
        ...data,
    });
    const documents = [];
    // createdAt explícito: os documentos saem na ordem de envio, e dois criados no mesmo milissegundo desempatariam pelo id
    for (const [index, type] of ['identity', 'proof_of_address'].entries()) {
        documents.push(await prisma.providerDocument.create({
            data: { providerId: provider.id, type, storageKey: `documents/${provider.id}/${type}-${randomUUID()}`, createdAt: sentAt(index) },
        }));
    }
    const photo = await prisma.providerPhoto.create({ data: { providerId: provider.id, url: `photos/${provider.id}/${randomUUID()}` } });
    return { provider, documents, photo };
}

test('detalhe traz documentos com URL assinada e expiresIn, sem storageKey', async () => {
    const { provider, documents } = await createFullProvider();

    const res = await detail(provider.id);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data.documents, documents.map((document) => ({
        id: document.id,
        type: document.type,
        url: `https://fake-storage.test/${document.storageKey}?signed=1`,
        // o prazo informado vem da configuração (STORAGE_SIGNED_URL_SECONDS, 120 neste arquivo)
        expiresIn: 120,
    })));
    const body = JSON.stringify(res.data);
    assert.ok(!body.includes('storageKey'));
    assert.ok(!body.includes('storage_key'));
    assert.ok(!body.includes('userId'));
    assert.ok(!body.includes(provider.userId));
});

test('detalhe mascara CPF/CNPJ e traz as fotos', async () => {
    const { provider, photo } = await createFullProvider();

    const res = await detail(provider.id);

    assert.strictEqual(res.status, 200);
    const { documents, ...rest } = res.data;
    assert.strictEqual(documents.length, 2);
    assert.deepStrictEqual(rest, {
        providerId: provider.id,
        providerType: 'hotel',
        name: 'Hotel it-admin-validations',
        submittedAt: sentAt(0).toISOString(),
        cpfCnpjMasked: '***1234',
        description: 'Casa com quintal',
        acceptedSpecies: ['dog'],
        acceptedSizes: ['small', 'medium'],
        acceptedBreeds: [],
        capacity: 3,
        // sem rua e sem número
        address: { city: 'São Paulo', state: 'SP', neighborhood: 'Centro', zipCode: '01234000' },
        photos: [{ id: photo.id, url: `https://fake-storage.test/${photo.url}?signed=1` }],
    });
    const body = JSON.stringify(res.data);
    assert.ok(!body.includes(provider.cpfCnpj));
    assert.ok(!body.includes('Rua Secreta'));
});

test('detalhe de cadastro aprovado, rejeitado, rascunho ou inexistente responde 404', async () => {
    const ids = [randomUUID()];
    for (const validationStatus of ['approved', 'rejected', 'draft']) ids.push((await createFullProvider({ validationStatus })).provider.id);

    for (const id of ids) {
        const res = await detail(id);
        assert.strictEqual(res.status, 404);
        assert.deepStrictEqual(res.data, { code: 'NOT_FOUND', message: 'Cadastro não encontrado' });
    }
});

test('detalhe com providerId que não é UUID responde 400', async () => {
    const res = await detail('abc');

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'VALIDATION_ERROR');
    assert.deepStrictEqual(res.data.details, [{ field: 'providerId', message: 'UUID obrigatório' }]);
});

test('usuário comum recebe 403 ADMIN_REQUIRED na fila e no detalhe, sem nenhuma URL no corpo', async () => {
    const { provider } = await createFullProvider();
    const auth = await bearer(common);

    for (const url of ['/api/v1/admin/provider-validations', `/api/v1/admin/provider-validations/${provider.id}`]) {
        const res = await http.get(url, auth);
        assert.strictEqual(res.status, 403, url);
        assert.strictEqual(res.data.code, 'ADMIN_REQUIRED');
        assert.ok(!JSON.stringify(res.data).includes('fake-storage.test'));
    }
    // sem token, nem chega na guarda do papel
    assert.strictEqual((await http.get(`/api/v1/admin/provider-validations/${provider.id}`)).status, 401);
});

// Aprovação e reprovação (#404)
const approve = async (id, user = admin) => http.post(`/api/v1/admin/provider-validations/${id}/approve`, null, await bearer(user));
const reject = async (id, body, user = admin) => http.post(`/api/v1/admin/provider-validations/${id}/reject`, body, await bearer(user));
const ownerOf = (provider) => prisma.user.findUnique({ where: { id: provider.userId } });
const notificationsOf = (provider) => prisma.notification.findMany({ where: { userId: provider.userId } });

test('aprovação muda para approved, grava autor e data, avisa o prestador e publica o Host', async () => {
    const { provider } = await createFullProvider();
    assert.strictEqual((await http.get(`/api/v1/hosts/${provider.id}`, await bearer(common))).status, 404);

    const res = await approve(provider.id);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(res.data).sort(), ['decidedAt', 'providerId', 'rejectionReason', 'validationStatus']);
    assert.strictEqual(res.data.providerId, provider.id);
    assert.strictEqual(res.data.validationStatus, 'approved');
    assert.strictEqual(res.data.rejectionReason, null);
    const saved = await prisma.provider.findUnique({ where: { id: provider.id } });
    assert.strictEqual(saved.validationDecidedById, admin.id);
    assert.strictEqual(saved.validationDecidedAt.toISOString(), res.data.decidedAt);
    const notifications = await notificationsOf(provider);
    assert.deepStrictEqual(notifications.map((item) => item.type), ['provider_validation_approved']);
    assert.deepStrictEqual(JSON.parse(notifications[0].content), { providerId: provider.id, rejectionReason: null });
    // publicável: aparece nos detalhes públicos e sai da fila
    assert.strictEqual((await http.get(`/api/v1/hosts/${provider.id}`, await bearer(common))).status, 200);
    assert.ok(!(await queueIds()).includes(provider.id));
});

test('reprovação com motivo muda para rejected e o prestador vê o motivo', async () => {
    const { provider } = await createFullProvider();

    const res = await reject(provider.id, { reason: '  Comprovante de endereço ilegível  ' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.validationStatus, 'rejected');
    assert.strictEqual(res.data.rejectionReason, 'Comprovante de endereço ilegível');
    const saved = await prisma.provider.findUnique({ where: { id: provider.id } });
    assert.strictEqual(saved.validationDecidedById, admin.id);
    const notifications = await notificationsOf(provider);
    assert.deepStrictEqual(notifications.map((item) => item.type), ['provider_validation_rejected']);
    assert.strictEqual(JSON.parse(notifications[0].content).rejectionReason, 'Comprovante de endereço ilegível');

    const profile = await http.get('/api/v1/me/host', await bearer(await ownerOf(provider)));
    assert.strictEqual(profile.status, 200);
    assert.strictEqual(profile.data.validationStatus, 'rejected');
    assert.strictEqual(profile.data.rejectionReason, 'Comprovante de endereço ilegível');
    // o prestador não vê quem decidiu
    assert.ok(!JSON.stringify(profile.data).includes(admin.id));
    assert.strictEqual((await http.get(`/api/v1/hosts/${provider.id}`, await bearer(common))).status, 404);
});

test('reprovação sem motivo ou com campo fora do contrato responde 400 e nada muda', async () => {
    const { provider } = await createFullProvider();

    for (const body of [{}, { reason: '   ' }, { reason: 'x'.repeat(501) }, { reason: 10 }]) {
        const res = await reject(provider.id, body);
        assert.strictEqual(res.status, 400, JSON.stringify(body));
        assert.deepStrictEqual(res.data.details, [{ field: 'reason', message: 'obrigatório, até 500 caracteres' }]);
    }
    const extra = await reject(provider.id, { reason: 'ok', validationDecidedBy: common.id });
    assert.strictEqual(extra.status, 400);
    assert.deepStrictEqual(extra.data.details, [{ field: 'validationDecidedBy', message: 'não faz parte do contrato' }]);

    const saved = await prisma.provider.findUnique({ where: { id: provider.id } });
    assert.deepStrictEqual([saved.validationStatus, saved.validationDecidedAt, saved.rejectionReason], ['pending', null, null]);
    assert.strictEqual((await notificationsOf(provider)).length, 0);
});

test('cadastro já decidido não recebe segunda decisão', async () => {
    const { provider } = await createFullProvider();
    assert.strictEqual((await approve(provider.id)).status, 200);
    const first = await prisma.provider.findUnique({ where: { id: provider.id } });

    for (const res of [await approve(provider.id), await reject(provider.id, { reason: 'mudei de ideia' })]) {
        assert.strictEqual(res.status, 409);
        assert.deepStrictEqual(res.data, { code: 'PROVIDER_ALREADY_DECIDED', message: 'O cadastro já foi decidido' });
    }
    const saved = await prisma.provider.findUnique({ where: { id: provider.id } });
    assert.deepStrictEqual([saved.validationStatus, saved.validationDecidedAt, saved.rejectionReason], ['approved', first.validationDecidedAt, null]);
    assert.strictEqual((await notificationsOf(provider)).length, 1);
});

test('duas decisões simultâneas: só uma vale', async () => {
    const { provider } = await createFullProvider();

    const results = await Promise.all([approve(provider.id), reject(provider.id, { reason: 'Documento vencido' })]);

    assert.deepStrictEqual(results.map((res) => res.status).sort(), [200, 409]);
    const winner = results.find((res) => res.status === 200).data;
    const saved = await prisma.provider.findUnique({ where: { id: provider.id } });
    assert.strictEqual(saved.validationStatus, winner.validationStatus);
    assert.strictEqual((await notificationsOf(provider)).length, 1);
});

test('decisão sobre rascunho ou inexistente responde 404; providerId fora do formato, 400', async () => {
    const { provider: draft } = await createFullProvider({ validationStatus: 'draft' });

    for (const id of [draft.id, randomUUID()]) {
        assert.deepStrictEqual((await approve(id)).data, { code: 'NOT_FOUND', message: 'Cadastro não encontrado' });
        assert.strictEqual((await reject(id, { reason: 'x' })).status, 404);
    }
    assert.strictEqual((await prisma.provider.findUnique({ where: { id: draft.id } })).validationStatus, 'draft');

    for (const res of [await approve('abc'), await reject('abc', { reason: 'x' })]) {
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.data.details, [{ field: 'providerId', message: 'UUID obrigatório' }]);
    }
});

test('usuário sem o papel Administrador recebe 403 e o cadastro continua pendente', async () => {
    const { provider } = await createFullProvider();

    for (const res of [await approve(provider.id, common), await reject(provider.id, { reason: 'x' }, common)]) {
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.data.code, 'ADMIN_REQUIRED');
    }
    assert.strictEqual((await http.post(`/api/v1/admin/provider-validations/${provider.id}/approve`)).status, 401);
    assert.strictEqual((await prisma.provider.findUnique({ where: { id: provider.id } })).validationStatus, 'pending');
});
