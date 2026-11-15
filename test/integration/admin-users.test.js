// Consulta de usuários do Administrador (#580), contra o PostgreSQL real. Exige DATABASE_URL.
// Cria USERs it-admin-users-* direto no banco e apaga tudo no final.
// A lista é global e os arquivos de teste rodam em paralelo: cada teste busca por uma marca própria no nome, sem contar com banco vazio.
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
// Marca única por teste, sem hífen: vai no nome dos usuários e na busca
const mark = () => `marca${randomUUID().replaceAll('-', '').slice(0, 12)}`;
// Datas bem antigas: a ordem entre os usuários do teste não depende do relógio
const createdAt = (minutes) => new Date(Date.UTC(2001, 0, 1, 0, minutes));
const digits = (length) => Array.from({ length }, () => randomInt(10)).join('');

async function createUser(data = {}) {
    const authUserId = randomUUID();
    const user = await prisma.user.create({
        data: { authUserId, email: `it-admin-users-${authUserId}@hospetse.dev`, name: 'Teste', ...data },
    });
    userIds.push(user.id);
    return user;
}
const createTutor = (user, data = {}) => prisma.tutor.create({ data: { userId: user.id, name: user.name, ...data } });
const createProvider = (user, data = {}) => prisma.provider.create({
    data: { userId: user.id, providerType: 'hotel', name: 'Hotel it-admin-users', validationStatus: 'approved', ...data },
});

const admin = await createUser({ accountType: 'admin' });
const common = await createUser();

after(async () => {
    server.close();
    const users = { in: userIds };
    await prisma.reservation.deleteMany({ where: { OR: [{ tutor: { userId: users } }, { service: { provider: { userId: users } } }] } });
    await prisma.pet.deleteMany({ where: { tutor: { userId: users } } });
    await prisma.service.deleteMany({ where: { provider: { userId: users } } });
    await prisma.provider.deleteMany({ where: { userId: users } });
    await prisma.tutor.deleteMany({ where: { userId: users } });
    await prisma.penalty.deleteMany({ where: { userId: users } });
    await prisma.user.deleteMany({ where: { id: users } });
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

const list = async (params, user = admin) => http.get('/api/v1/admin/users', { params, ...(await bearer(user)) });
const detail = async (id, user = admin) => http.get(`/api/v1/admin/users/${id}`, await bearer(user));
const ids = (res) => res.data.items.map((item) => item.id);

test('admin lista usuários paginados', async () => {
    const q = mark();
    const oldest = await createUser({ name: `Antigo ${q}`, createdAt: createdAt(1) });
    const middle = await createUser({ name: `Meio ${q}`, createdAt: createdAt(2), status: 'active' });
    await createTutor(middle);
    const newest = await createUser({ name: `Novo ${q}`, createdAt: createdAt(3) });

    const first = await list({ q, pageSize: 2 });
    const second = await list({ q, pageSize: 2, page: 2 });

    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual([first.data.page, first.data.pageSize, first.data.total], [1, 2, 3]);
    assert.deepStrictEqual([second.data.page, second.data.pageSize, second.data.total], [2, 2, 3]);
    // do cadastro mais novo para o mais antigo
    assert.deepStrictEqual(ids(first), [newest.id, middle.id]);
    assert.deepStrictEqual(ids(second), [oldest.id]);
    assert.deepStrictEqual(first.data.items[1], {
        id: middle.id,
        name: `Meio ${q}`,
        emailMasked: 'i***@hospetse.dev',
        accountType: 'user',
        roles: ['tutor'],
        status: 'active',
        createdAt: createdAt(2).toISOString(),
    });

    // sem filtro, a lista traz todos: pelo menos os criados por este arquivo
    const all = await list();
    assert.strictEqual(all.status, 200);
    assert.strictEqual(all.data.pageSize, 20);
    assert.ok(all.data.total >= userIds.length);
});

test('mesma data de cadastro: o desempate é pelo id', async () => {
    const q = mark();
    const users = [];
    for (let i = 0; i < 3; i += 1) users.push(await createUser({ name: `Empate ${q}`, createdAt: createdAt(5) }));

    assert.deepStrictEqual(ids(await list({ q })), users.map((user) => user.id).sort());
});

test('busca por parte do nome e por parte do e-mail', async () => {
    const q = mark();
    const emailPart = mark();
    const byName = await createUser({ name: `Fulana ${q} da Silva` });
    const byEmail = await createUser({ email: `it-admin-users-${emailPart}@hospetse.dev` });

    // sem diferenciar maiúsculas de minúsculas, e com espaços nas pontas
    assert.deepStrictEqual(ids(await list({ q: ` ${q.toUpperCase()} ` })), [byName.id]);
    const found = await list({ q: emailPart.toUpperCase() });
    assert.deepStrictEqual(ids(found), [byEmail.id]);
    // achar pelo e-mail não devolve o e-mail
    assert.strictEqual(found.data.items[0].emailMasked, 'i***@hospetse.dev');
    assert.deepStrictEqual((await list({ q: mark() })).data, { items: [], page: 1, pageSize: 20, total: 0 });
});

test('busca trata % e _ como texto, não como curinga', async () => {
    const q = mark();
    const literal = await createUser({ name: `Nome ${q}_a%b` });
    await createUser({ name: `Nome ${q}xaxxb` });

    assert.deepStrictEqual(ids(await list({ q: `${q}_a%b` })), [literal.id]);
    assert.deepStrictEqual(ids(await list({ q: `${q}%` })), []);
});

test('filtra por papel tutor, provider e admin', async () => {
    const q = mark();
    const name = `Papel ${q}`;
    const none = await createUser({ name });
    const tutor = await createUser({ name });
    await createTutor(tutor);
    const provider = await createUser({ name });
    await createProvider(provider);
    const both = await createUser({ name });
    await createTutor(both);
    await createProvider(both);
    const adminUser = await createUser({ name, accountType: 'admin' });

    const byRole = async (role) => ids(await list({ q, role })).sort();
    assert.deepStrictEqual(await byRole('tutor'), [tutor.id, both.id].sort());
    assert.deepStrictEqual(await byRole('provider'), [provider.id, both.id].sort());
    assert.deepStrictEqual(await byRole('admin'), [adminUser.id]);

    const roles = Object.fromEntries((await list({ q })).data.items.map((item) => [item.id, item.roles]));
    assert.deepStrictEqual(roles, {
        [none.id]: [], [tutor.id]: ['tutor'], [provider.id]: ['provider'], [both.id]: ['tutor', 'provider'], [adminUser.id]: ['admin'],
    });
});

test('filtra por estado da conta', async () => {
    const q = mark();
    const byStatus = {};
    for (const status of ['active', 'blocked', 'suspended', 'pending']) byStatus[status] = await createUser({ name: `Estado ${q}`, status });

    for (const [status, user] of Object.entries(byStatus)) {
        const res = await list({ q, status });
        assert.deepStrictEqual(ids(res), [user.id], status);
        assert.strictEqual(res.data.items[0].status, status);
    }
    // os filtros se somam
    await createTutor(byStatus.blocked);
    assert.deepStrictEqual(ids(await list({ q, status: 'blocked', role: 'tutor' })), [byStatus.blocked.id]);
    assert.deepStrictEqual(ids(await list({ q, status: 'active', role: 'tutor' })), []);
});

test('lista recusa parâmetro inválido com todos os details', async () => {
    const res = await http.get('/api/v1/admin/users?q=a&role=host&status=banned&page=0&pageSize=51&sort=name&role=tutor', await bearer(admin));

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'VALIDATION_ERROR');
    assert.deepStrictEqual(res.data.details.map((item) => item.field).sort(), ['page', 'pageSize', 'q', 'role', 'sort', 'status']);
    assert.strictEqual(res.data.items, undefined);
});

// Usuário que é Tutor e prestador, com uma contratação de cada lado e uma penalidade
async function createFullUser() {
    const user = await createUser({ name: 'Completo', status: 'suspended', profileStatus: 'complete', createdAt: createdAt(9) });
    const tutor = await createTutor(user, { cpf: digits(11), phone: `119${digits(8)}`, emergencyContactName: 'Contato Secreto', emergencyContactPhone: '11911112222' });
    const provider = await createProvider(user, { cpfCnpj: digits(14) });
    const pet = await prisma.pet.create({ data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog', petSize: 'small' } });
    const ownService = await prisma.service.create({ data: { providerId: provider.id, name: 'Diária', price: 120 } });

    // o outro lado das contratações
    const other = await createUser({ name: 'Outro' });
    const otherTutor = await createTutor(other);
    const otherProvider = await createProvider(other);
    const otherPet = await prisma.pet.create({ data: { tutorId: otherTutor.id, petName: 'Mia', petSpecies: 'cat', petSize: 'small' } });
    const otherService = await prisma.service.create({ data: { providerId: otherProvider.id, name: 'Diária', price: 80 } });

    const asTutor = await prisma.reservation.create({
        data: {
            tutorId: tutor.id, petId: pet.id, serviceId: otherService.id, status: 'awaiting_payment', totalValue: 240,
            startDate: new Date('2026-11-20'), endDate: new Date('2026-11-23'), createdDate: createdAt(20),
        },
    });
    const asProvider = await prisma.reservation.create({
        data: {
            tutorId: otherTutor.id, petId: otherPet.id, serviceId: ownService.id, status: 'requested', totalValue: 120.5,
            startDate: new Date('2026-12-01'), endDate: new Date('2026-12-02'), createdDate: createdAt(10),
        },
    });
    const penalty = await prisma.penalty.create({ data: { userId: user.id, appliedById: admin.id, type: 'warning', reason: 'Cancelou em cima da hora', createdAt: createdAt(30) } });
    return { user, tutor, provider, asTutor, asProvider, penalty };
}

test('detalhe traz papéis, contratações e penalidades com dados mascarados', async () => {
    const { user, tutor, provider, asTutor, asProvider, penalty } = await createFullUser();

    const res = await detail(user.id);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, {
        id: user.id,
        name: 'Completo',
        emailMasked: 'i***@hospetse.dev',
        accountType: 'user',
        status: 'suspended',
        profileStatus: 'complete',
        roles: ['tutor', 'provider'],
        createdAt: createdAt(9).toISOString(),
        tutor: { cpfMasked: `***${tutor.cpf.slice(-4)}`, phoneMasked: `***${tutor.phone.slice(-4)}` },
        provider: { id: provider.id, providerType: 'hotel', validationStatus: 'approved', cpfCnpjMasked: `***${provider.cpfCnpj.slice(-4)}` },
        // da mais nova para a mais antiga, dos dois lados
        contracts: [
            { id: asTutor.id, as: 'tutor', status: 'awaiting_payment', startDate: '2026-11-20', totalValue: 240 },
            { id: asProvider.id, as: 'provider', status: 'requested', startDate: '2026-12-01', totalValue: 120.5 },
        ],
        penalties: [{ id: penalty.id, type: 'warning', reason: 'Cancelou em cima da hora', createdAt: createdAt(30).toISOString() }],
    });
});

test('detalhe de usuário sem perfil: sem papéis, contratações nem penalidades', async () => {
    const user = await createUser({ name: 'Sem perfil' });

    const res = await detail(user.id);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
        [res.data.roles, res.data.tutor, res.data.provider, res.data.contracts, res.data.penalties],
        [[], null, null, [], []],
    );
});

test('detalhe traz só as 20 contratações mais recentes', async () => {
    const user = await createUser({ name: 'Muitas' });
    const tutor = await createTutor(user);
    const pet = await prisma.pet.create({ data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog', petSize: 'small' } });
    const host = await createUser({ name: 'Host' });
    const service = await prisma.service.create({ data: { providerId: (await createProvider(host)).id, name: 'Diária', price: 10 } });
    await prisma.reservation.createMany({
        data: Array.from({ length: 21 }, (_, i) => ({
            tutorId: tutor.id, petId: pet.id, serviceId: service.id, totalValue: i, startDate: new Date('2026-12-01'), createdDate: createdAt(i),
        })),
    });

    const { data } = await detail(user.id);

    assert.strictEqual(data.contracts.length, 20);
    // a mais antiga (totalValue 0) é a que fica de fora
    assert.deepStrictEqual([data.contracts[0].totalValue, data.contracts[19].totalValue], [20, 1]);
});

test('usuário inexistente responde 404 com mensagem padronizada', async () => {
    const res = await detail(randomUUID());

    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(res.data, { code: 'NOT_FOUND', message: 'Usuário não encontrado' });
});

test('detalhe com id que não é UUID responde 400', async () => {
    const res = await detail('abc');

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'VALIDATION_ERROR');
    assert.deepStrictEqual(res.data.details, [{ field: 'id', message: 'UUID obrigatório' }]);
});

test('não admin recebe 403 na lista e no detalhe', async () => {
    const { user } = await createFullUser();

    for (const res of [await list({}, common), await detail(user.id, common)]) {
        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(Object.keys(res.data).sort(), ['code', 'message']);
        assert.strictEqual(res.data.code, 'ADMIN_REQUIRED');
    }
    // sem token, nem chega na guarda do papel
    assert.strictEqual((await http.get('/api/v1/admin/users')).status, 401);
    assert.strictEqual((await http.get(`/api/v1/admin/users/${user.id}`)).status, 401);
});

test('resposta não traz CPF, telefone ou e-mail completos', async () => {
    const q = mark();
    const { user, tutor, provider } = await createFullUser();
    await prisma.user.update({ where: { id: user.id }, data: { name: `Completo ${q}` } });

    const listed = await list({ q });
    const shown = await detail(user.id);

    assert.deepStrictEqual(ids(listed), [user.id]);
    for (const body of [JSON.stringify(listed.data), JSON.stringify(shown.data)]) {
        for (const secret of [user.email, tutor.cpf, tutor.phone, provider.cpfCnpj, user.authUserId, 'Contato Secreto', '11911112222']) {
            assert.ok(!body.includes(secret), `vazou: ${secret}`);
        }
        for (const field of ['"email"', '"cpf"', '"phone"', '"cpfCnpj"', 'authUserId', 'emergencyContact']) {
            assert.ok(!body.includes(field), `campo fora do contrato: ${field}`);
        }
    }
});
