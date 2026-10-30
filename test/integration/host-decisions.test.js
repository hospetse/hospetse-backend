// POST /api/v1/me/host/reservations/:id/accept e /reject (HSP-PBI-042-TSK-01 #491, testes da #493) contra o PostgreSQL real.
// Exige DATABASE_URL. Cria USERs (e-mail it-...@exemplo.com), Tutores, pets, Hosts, serviços e solicitações de teste,
// e remove tudo o que criou no after. O JWT é assinado por um par de chaves gerado aqui: não depende do Auth.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
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
const tutorIds = [];
const providerIds = [];

after(async () => {
    server.close();
    // notificações e detalhes do hotel saem em cascata com o USER e o prestador
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

async function newTutor() {
    const { user, token } = await newUser();
    const tutor = await prisma.tutor.create({ data: { userId: user.id, name: user.name } });
    tutorIds.push(tutor.id);
    const pet = await prisma.pet.create({ data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog' } });
    return { user, tutor, pet, token };
}

// Host com um serviço; capacity null = sem hotel_details (vale 1)
async function newHost(capacity = null) {
    const { user, token } = await newUser();
    const provider = await prisma.provider.create({
        data: {
            userId: user.id,
            providerType: 'hotel',
            name: 'Hotelzinho de Teste',
            services: { create: [{ name: 'Diária', price: 100 }] },
            ...(capacity ? { hotelDetail: { create: { capacity } } } : {}),
        },
        include: { services: true },
    });
    providerIds.push(provider.id);
    return { provider, service: provider.services[0], token };
}

// Solicitação pendente de 2026-12-<start> a 2026-12-<end>, gravada direto no banco: o que se testa aqui é a decisão
function newReservation({ tutor, pet }, service, start = 10, end = 12) {
    return prisma.reservation.create({
        data: {
            tutorId: tutor.id,
            petId: pet.id,
            serviceId: service.id,
            startDate: new Date(Date.UTC(2026, 11, start)),
            endDate: new Date(Date.UTC(2026, 11, end)),
            dailyPrice: 100,
            totalValue: 100 * (end - start),
        },
    });
}

const headers = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const accept = (token, id) => http.post(`/api/v1/me/host/reservations/${id}/accept`, null, { headers: headers(token) });

test('aceite: 200 em awaiting_payment, com decidedAt, e sai da lista de pendentes', async () => {
    const tutor = await newTutor();
    const { service, token } = await newHost();
    const reservation = await newReservation(tutor, service);

    const res = await accept(token, reservation.id);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.id, reservation.id);
    assert.strictEqual(res.data.status, 'awaiting_payment');
    assert.strictEqual(res.data.rejectionReason, null);
    const saved = await prisma.reservation.findUnique({ where: { id: reservation.id } });
    assert.strictEqual(saved.status, 'awaiting_payment');
    assert.strictEqual(saved.decidedAt.toISOString(), res.data.decidedAt);

    const pending = await http.get('/api/v1/me/host/reservations', { headers: headers(token) });
    assert.deepStrictEqual(pending.data.items, []);
});

test('aceitar duas vezes: a segunda recebe 409 RESERVATION_ALREADY_DECIDED', async () => {
    const tutor = await newTutor();
    const { service, token } = await newHost();
    const reservation = await newReservation(tutor, service);

    await accept(token, reservation.id);
    const again = await accept(token, reservation.id);

    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.data.code, 'RESERVATION_ALREADY_DECIDED');
});

test('período ocupado depois do aceite: sem vaga, outro aceite no período recebe 409 NO_CAPACITY', async () => {
    const tutor = await newTutor();
    const { service, token } = await newHost(); // sem capacidade cadastrada: um pet por vez
    const first = await newReservation(tutor, service, 10, 12);
    const overlapping = await newReservation(tutor, service, 11, 13);

    await accept(token, first.id);
    const res = await accept(token, overlapping.id);

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.data.code, 'NO_CAPACITY');
    const saved = await prisma.reservation.findUnique({ where: { id: overlapping.id } });
    assert.strictEqual(saved.status, 'requested');
});

test('o dia da saída não ocupa: período que começa na saída de outro é aceito', async () => {
    const tutor = await newTutor();
    const { service, token } = await newHost();
    const first = await newReservation(tutor, service, 10, 12);
    const next = await newReservation(tutor, service, 12, 14);

    await accept(token, first.id);
    const res = await accept(token, next.id);

    assert.strictEqual(res.status, 200);
});

test('capacidade 2: dois aceites no mesmo período passam e o terceiro recebe 409', async () => {
    const tutor = await newTutor();
    const { service, token } = await newHost(2);
    const reservations = [await newReservation(tutor, service), await newReservation(tutor, service), await newReservation(tutor, service)];

    const statuses = [];
    for (const reservation of reservations) statuses.push((await accept(token, reservation.id)).status);

    assert.deepStrictEqual(statuses, [200, 200, 409]);
});

test('Host de outra solicitação: 404, igual à inexistente, e a solicitação não muda', async () => {
    const tutor = await newTutor();
    const owner = await newHost();
    const other = await newHost();
    const reservation = await newReservation(tutor, owner.service);

    const res = await accept(other.token, reservation.id);
    const missing = await accept(other.token, randomUUID());
    const notUuid = await accept(other.token, 'abc');

    for (const response of [res, missing, notUuid]) {
        assert.strictEqual(response.status, 404);
        assert.strictEqual(response.data.code, 'NOT_FOUND');
    }
    const saved = await prisma.reservation.findUnique({ where: { id: reservation.id } });
    assert.strictEqual(saved.status, 'requested');
});

test('quem não é Host: 403 HOST_REQUIRED; sem token: 401', async () => {
    const tutor = await newTutor();
    const { service } = await newHost();
    const reservation = await newReservation(tutor, service);

    const notHost = await accept(tutor.token, reservation.id);
    const noToken = await accept(null, reservation.id);

    assert.strictEqual(notHost.status, 403);
    assert.strictEqual(notHost.data.code, 'HOST_REQUIRED');
    assert.strictEqual(noToken.status, 401);
});
