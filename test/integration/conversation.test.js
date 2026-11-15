// Conversa da contratação e histórico (HSP-PBI-055-TSK-02 #548) contra o PostgreSQL real.
// Exige DATABASE_URL. Cria USERs (e-mail it-...@exemplo.com), Tutores, pet, Host, serviço, contratações, conversas e mensagens
// de teste, e remove tudo o que criou no after.
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
const reservationIds = [];

after(async () => {
    server.close();
    // as mensagens saem em cascata com a conversa
    await prisma.conversation.deleteMany({ where: { reservationId: { in: reservationIds } } });
    await prisma.reservation.deleteMany({ where: { id: { in: reservationIds } } });
    await prisma.pet.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.tutor.deleteMany({ where: { id: { in: tutorIds } } });
    await prisma.service.deleteMany({ where: { providerId: provider.id } });
    await prisma.provider.deleteMany({ where: { id: provider.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

async function newUser(name = 'Teste Integração') {
    const authUserId = randomUUID();
    const user = await prisma.user.create({ data: { authUserId, email: `it-${authUserId}@exemplo.com`, name } });
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

async function newTutor(name) {
    const { user, token } = await newUser(name);
    const tutor = await prisma.tutor.create({ data: { userId: user.id, name } });
    tutorIds.push(tutor.id);
    const pet = await prisma.pet.create({ data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog' } });
    return { user, tutor, pet, token };
}

const host = await newUser('Dono do Hotel');
const provider = await prisma.provider.create({
    data: { userId: host.user.id, providerType: 'hotel', name: 'Hotelzinho de Teste', services: { create: [{ name: 'Diária', price: 120.05 }] } },
    include: { services: true },
});

async function newReservation({ tutor, pet }, status = 'requested') {
    const reservation = await prisma.reservation.create({
        data: { petId: pet.id, tutorId: tutor.id, serviceId: provider.services[0].id, status, startDate: new Date('2030-01-10'), endDate: new Date('2030-01-12'), totalValue: 240.1 },
    });
    reservationIds.push(reservation.id);
    return reservation;
}

const auth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
const open = (token, reservationId) => http.post(`/api/v1/contracts/${reservationId}/conversation`, null, auth(token));
const history = (token, conversationId, query = '') => http.get(`/api/v1/conversations/${conversationId}/messages${query}`, auth(token));

test('Tutor abre a conversa (201) e reabre a mesma (200); o Host abre a mesma', async () => {
    const ana = await newTutor('Ana');
    const reservation = await newReservation(ana);

    const first = await open(ana.token, reservation.id);
    assert.strictEqual(first.status, 201);
    assert.deepStrictEqual(first.data.participants, { tutor: { name: 'Ana' }, host: { name: 'Hotelzinho de Teste' } });
    assert.strictEqual(first.data.contractId, reservation.id);
    assert.strictEqual(first.data.open, true);

    const again = await open(ana.token, reservation.id);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.data.id, first.data.id);

    const byHost = await open(host.token, reservation.id);
    assert.strictEqual(byHost.status, 200);
    assert.strictEqual(byHost.data.id, first.data.id);
    assert.strictEqual(await prisma.conversation.count({ where: { reservationId: reservation.id } }), 1);
});

test('Tutor e Host abrem ao mesmo tempo: uma conversa só', async () => {
    const ana = await newTutor('Ana');
    const reservation = await newReservation(ana);
    const [a, b] = await Promise.all([open(ana.token, reservation.id), open(host.token, reservation.id)]);
    assert.strictEqual(a.data.id, b.data.id);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 201]);
});

test('quem não participa, contratação inexistente ou id inválido: 404 sem dados', async () => {
    const ana = await newTutor('Ana');
    const beto = await newTutor('Beto');
    const reservation = await newReservation(ana);
    const conversation = (await open(ana.token, reservation.id)).data;

    for (const id of [reservation.id, randomUUID(), 'abc']) {
        const res = await open(beto.token, id);
        assert.strictEqual(res.status, 404, id);
        assert.strictEqual(res.data.code, 'NOT_FOUND');
        // Nenhum dado da conversa nem dos participantes
        assert.strictEqual(res.data.id, undefined);
        assert.strictEqual(res.data.participants, undefined);
    }
    const res = await history(beto.token, conversation.id);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.data.items, undefined);
});

test('contratação concluída, recusada ou cancelada: conversa abre com open false', async () => {
    const ana = await newTutor('Ana');
    for (const status of ['completed', 'rejected', 'cancelled']) {
        const reservation = await newReservation(ana, status);
        const res = await open(ana.token, reservation.id);
        assert.strictEqual(res.status, 201, status);
        assert.strictEqual(res.data.open, false, status);
    }
});

test('histórico: página 1 com as mais recentes, em ordem cronológica dentro da página', async () => {
    const ana = await newTutor('Ana');
    const reservation = await newReservation(ana, 'accepted');
    const conversation = (await open(ana.token, reservation.id)).data;
    // 5 mensagens fora de ordem de inserção, alternando Tutor e Host
    const base = Date.parse('2030-01-01T10:00:00Z');
    for (const i of [3, 1, 5, 2, 4]) {
        const fromTutor = i % 2 === 1;
        await prisma.message.create({
            data: {
                conversationId: conversation.id,
                senderType: fromTutor ? 'tutor' : 'host',
                senderUserId: fromTutor ? ana.user.id : host.user.id,
                content: `mensagem ${i}`,
                sentAt: new Date(base + i * 60000),
            },
        });
    }

    const page1 = await history(host.token, conversation.id, '?pageSize=2');
    assert.strictEqual(page1.status, 200);
    assert.deepStrictEqual(page1.data.items.map((m) => m.text), ['mensagem 4', 'mensagem 5']);
    assert.strictEqual(page1.data.total, 5);
    assert.strictEqual(page1.data.open, true);
    assert.deepStrictEqual(page1.data.items[0].author, { role: 'host', name: 'Dono do Hotel' });
    assert.deepStrictEqual(page1.data.items[1].author, { role: 'tutor', name: 'Ana' });

    const page3 = await history(ana.token, conversation.id, '?page=3&pageSize=2');
    assert.deepStrictEqual(page3.data.items.map((m) => m.text), ['mensagem 1']);
});

test('histórico vazio e paginação inválida', async () => {
    const ana = await newTutor('Ana');
    const conversation = (await open(ana.token, (await newReservation(ana)).id)).data;

    const empty = await history(ana.token, conversation.id);
    assert.deepStrictEqual(empty.data, { items: [], page: 1, pageSize: 20, total: 0, open: true });

    const invalid = await history(ana.token, conversation.id, '?pageSize=51&foo=1');
    assert.strictEqual(invalid.status, 400);
    assert.deepStrictEqual(invalid.data.details.map((d) => d.field).sort(), ['foo', 'pageSize']);
});
