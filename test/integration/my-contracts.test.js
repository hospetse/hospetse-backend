// GET /api/v1/me/contracts (HSP-PBI-046, testes da #535) contra o PostgreSQL real.
// Exige DATABASE_URL. Cria USERs (e-mail it-...@exemplo.com), Tutores, pets, prestadores dos três tipos, serviços e contratações
// de teste, e remove tudo o que criou no after.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { prisma } from '../../src/lib/prisma.js';
import { CONTRACT_STATUS_LABELS } from '../../src/contracts/contract-status.js';

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
const tutorIds = [];
const providerIds = [];

after(async () => {
    server.close();
    await prisma.reservation.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.pet.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.tutor.deleteMany({ where: { id: { in: tutorIds } } });
    await prisma.service.deleteMany({ where: { providerId: { in: providerIds } } });
    await prisma.provider.deleteMany({ where: { id: { in: providerIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

async function newUser() {
    const authUserId = randomUUID();
    const user = await prisma.user.create({ data: { authUserId, email: `it-${authUserId}@exemplo.com`, name: 'Teste Integração' } });
    userIds.push(user.id);
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(authUserId)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setExpirationTime('5m')
        .sign(privateKey);
    return { user, token };
}

async function newTutor(petName = 'Rex') {
    const { user, token } = await newUser();
    const tutor = await prisma.tutor.create({ data: { userId: user.id, name: 'Ana' } });
    tutorIds.push(tutor.id);
    const pet = await prisma.pet.create({ data: { tutorId: tutor.id, petName, petSpecies: 'dog' } });
    return { tutor, pet, token };
}

// Prestador de um tipo, com um serviço
async function newProvider(providerType, name) {
    const { user } = await newUser();
    const provider = await prisma.provider.create({
        data: { userId: user.id, providerType, name, services: { create: [{ name: 'Serviço', price: 80 }] } },
        include: { services: true },
    });
    providerIds.push(provider.id);
    return provider;
}

const hotel = await newProvider('hotel', 'Hotel Aberto');
const sitter = await newProvider('pet_sitter', 'Sitter da Vila');
const walker = await newProvider('pet_walker', 'Passeios do Bairro');

// createdDate explícito: a ordem da lista é pela data da solicitação
function newReservation({ tutor, pet }, provider, { status = 'requested', createdDate = new Date(), totalValue = 240.1 } = {}) {
    return prisma.reservation.create({
        data: {
            petId: pet.id, tutorId: tutor.id, serviceId: provider.services[0].id, status, createdDate,
            startDate: new Date('2030-01-10'), endDate: new Date('2030-01-12'), totalValue,
        },
    });
}

const list = (token, query = '') => http.get(`/api/v1/me/contracts${query}`, { headers: { Authorization: `Bearer ${token}` } });

test('Tutor com contratações dos três tipos recebe todas, da mais recente para a mais antiga', async () => {
    const ana = await newTutor();
    const old = await newReservation(ana, hotel, { createdDate: new Date('2030-01-01T10:00:00Z') });
    const middle = await newReservation(ana, sitter, { createdDate: new Date('2030-01-02T10:00:00Z') });
    const recent = await newReservation(ana, walker, { createdDate: new Date('2030-01-03T10:00:00Z') });

    const res = await list(ana.token);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data.items.map((c) => c.id), [recent.id, middle.id, old.id]);
    assert.deepStrictEqual(res.data.items.map((c) => c.type), ['passeio', 'visita', 'hospedagem']);
    assert.deepStrictEqual(res.data.items[2], {
        id: old.id,
        type: 'hospedagem',
        status: 'requested',
        statusLabel: 'Aguardando aceite',
        provider: { id: hotel.id, name: 'Hotel Aberto' },
        pet: { id: ana.pet.id, name: 'Rex' },
        startDate: '2030-01-10',
        endDate: '2030-01-12',
        totalValue: 240.1,
    });
});

test('Tutor sem contratações recebe lista vazia', async () => {
    const ana = await newTutor();
    const res = await list(ana.token);
    assert.deepStrictEqual(res.data, { items: [], page: 1, pageSize: 20, total: 0 });
});

test('Tutor não vê contratações de outro Tutor', async () => {
    const ana = await newTutor();
    const beto = await newTutor('Thor');
    const ofAna = await newReservation(ana, hotel);
    await newReservation(beto, hotel);
    await newReservation(beto, walker);

    const res = await list(ana.token);
    assert.deepStrictEqual(res.data.items.map((c) => c.id), [ofAna.id]);
    assert.strictEqual(res.data.total, 1);
    // Não existe parâmetro para escolher o Tutor: o filtro vem só do JWT
    const forged = await list(ana.token, `?tutorId=${beto.tutor.id}`);
    assert.strictEqual(forged.status, 400);
});

test('status vem com o nome oficial do Glossário', async () => {
    const ana = await newTutor();
    for (const status of Object.keys(CONTRACT_STATUS_LABELS)) await newReservation(ana, hotel, { status });

    const res = await list(ana.token, '?pageSize=50');
    for (const item of res.data.items) assert.strictEqual(item.statusLabel, CONTRACT_STATUS_LABELS[item.status], item.status);
    assert.strictEqual(res.data.items.find((c) => c.status === 'awaiting_payment').statusLabel, 'Aguardando pagamento');
    assert.strictEqual(res.data.items.find((c) => c.status === 'checked_out').statusLabel, 'Concluída');
});

test('paginação devolve total correto e não repete itens entre páginas', async () => {
    const ana = await newTutor();
    for (let day = 1; day <= 5; day += 1) {
        await newReservation(ana, hotel, { createdDate: new Date(`2030-02-0${day}T10:00:00Z`) });
    }
    const page1 = await list(ana.token, '?page=1&pageSize=2');
    const page3 = await list(ana.token, '?page=3&pageSize=2');
    assert.strictEqual(page1.data.total, 5);
    assert.strictEqual(page1.data.items.length, 2);
    assert.strictEqual(page3.data.items.length, 1);
    const all = [...page1.data.items, ...(await list(ana.token, '?page=2&pageSize=2')).data.items, ...page3.data.items];
    assert.strictEqual(new Set(all.map((c) => c.id)).size, 5);

    const invalid = await list(ana.token, '?page=0&pageSize=51');
    assert.strictEqual(invalid.status, 400);
    assert.deepStrictEqual(invalid.data.details.map((d) => d.field), ['page', 'pageSize']);
});

test('quem ainda não é Tutor recebe 403', async () => {
    const { token } = await newUser();
    const res = await list(token);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.data.code, 'PROFILE_INCOMPLETE');
});
