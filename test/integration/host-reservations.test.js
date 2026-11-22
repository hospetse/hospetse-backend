// GET /api/v1/me/host/reservations (HSP-PBI-041-TSK-01 #485, testes da #487) contra o PostgreSQL real. Exige DATABASE_URL.
// Cria USERs (e-mail it-...@exemplo.com), Tutores, pets, Hosts, serviços e solicitações de teste, e remove tudo o que criou no after.
// O JWT é assinado por um par de chaves gerado aqui: não depende do Auth.
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
const addressIds = [];

after(async () => {
    server.close();
    await prisma.reservation.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.pet.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.tutor.deleteMany({ where: { id: { in: tutorIds } } });
    await prisma.address.deleteMany({ where: { id: { in: addressIds } } });
    await prisma.service.deleteMany({ where: { providerId: { in: providerIds } } });
    await prisma.provider.deleteMany({ where: { id: { in: providerIds } } });
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

// Tutor com CPF e telefone (que não podem sair na lista do Host) e um pet
async function newTutor() {
    const { user, token } = await newUser('Ana Tutora');
    const tutor = await prisma.tutor.create({ data: { userId: user.id, name: 'Ana Tutora', phone: '11999999999' } });
    tutorIds.push(tutor.id);
    const pet = await prisma.pet.create({
        data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog', petSize: 'medium', petBreed: 'Vira-lata', medicalNotes: 'Alergia a frango' },
    });
    return { user, tutor, pet, token };
}

async function newHost() {
    const { user, token } = await newUser();
    const provider = await prisma.provider.create({
        data: { userId: user.id, providerType: 'hotel', name: 'Hotelzinho de Teste', services: { create: [{ name: 'Diária', price: 100 }] } },
        include: { services: true },
    });
    providerIds.push(provider.id);
    return { provider, service: provider.services[0], token };
}

// Solicitação gravada direto no banco: o que se testa aqui é a lista, não a criação (#494)
function newReservation({ tutor, pet }, service, data = {}) {
    return prisma.reservation.create({
        data: {
            tutorId: tutor.id,
            petId: pet.id,
            serviceId: service.id,
            startDate: new Date('2026-12-10'),
            endDate: new Date('2026-12-12'),
            dailyPrice: 100,
            totalValue: 200,
            ...data,
        },
    });
}

const list = (token, params) => http.get('/api/v1/me/host/reservations', {
    params,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
});

test('sem token: 401', async () => {
    const res = await list(null);
    assert.strictEqual(res.status, 401);
});

test('usuário que não é Host: 403 HOST_REQUIRED', async () => {
    const { token } = await newTutor();
    const res = await list(token);
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(res.data, { code: 'HOST_REQUIRED', message: 'Apenas Hosts acessam as solicitações recebidas.' });
});

test('Host com pendente: 200 com Tutor, pet, período e snapshot, sem dados pessoais do Tutor', async () => {
    const tutor = await newTutor();
    const { service, token } = await newHost();
    const reservation = await newReservation(tutor, service, { notes: 'Toma remédio às 8h' });

    const res = await list(token);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, {
        items: [{
            id: reservation.id,
            status: 'requested',
            serviceId: service.id,
            startDate: '2026-12-10',
            endDate: '2026-12-12',
            dailyPrice: 100,
            totalValue: 200,
            notes: 'Toma remédio às 8h',
            createdAt: reservation.createdDate.toISOString(),
            tutor: { name: 'Ana Tutora' },
            pet: { name: 'Rex', species: 'dog', size: 'medium', breed: 'Vira-lata', medicalNotes: 'Alergia a frango', behavioralNotes: null },
        }],
        page: 1,
        pageSize: 20,
        total: 1,
    });
    const body = JSON.stringify(res.data);
    for (const personal of ['11999999999', tutor.user.email, tutor.tutor.id]) {
        assert.ok(!body.includes(personal), `${personal} não pode sair na lista do Host`);
    }
});

test('solicitações já decididas não aparecem', async () => {
    const tutor = await newTutor();
    const { service, token } = await newHost();
    const pending = await newReservation(tutor, service);
    await newReservation(tutor, service, { status: 'accepted' });
    await newReservation(tutor, service, { status: 'rejected' });

    const res = await list(token);

    assert.deepStrictEqual(res.data.items.map((item) => item.id), [pending.id]);
    assert.strictEqual(res.data.total, 1);
});

test('Host sem pendentes: lista vazia, mesmo com pendentes de outro Host', async () => {
    const tutor = await newTutor();
    const other = await newHost();
    await newReservation(tutor, other.service);
    const { token } = await newHost();

    const res = await list(token);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, { items: [], page: 1, pageSize: 20, total: 0 });
});

test('a mais antiga primeiro, com paginação', async () => {
    const tutor = await newTutor();
    const { service, token } = await newHost();
    const created = [];
    for (const day of [1, 2, 3]) {
        created.push(await newReservation(tutor, service, { createdDate: new Date(`2026-10-0${day}T12:00:00Z`) }));
    }

    const first = await list(token, { pageSize: 2 });
    const second = await list(token, { page: 2, pageSize: 2 });

    assert.deepStrictEqual(first.data.items.map((item) => item.id), [created[0].id, created[1].id]);
    assert.deepStrictEqual(second.data.items.map((item) => item.id), [created[2].id]);
    assert.strictEqual(first.data.total, 3);
    assert.strictEqual(second.data.total, 3);
});

test('parâmetros inválidos: 400 com todos os campos', async () => {
    const { token } = await newHost();
    const res = await list(token, { status: 'unknown', page: 0, pageSize: 51 });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'VALIDATION_ERROR');
    assert.deepStrictEqual(res.data.details.map((detail) => detail.field), ['status', 'page', 'pageSize']);
});

const checkIn = (token, id, body) => http.patch(`/api/v1/reservations/${id}/check-in`, body, {
    headers: { Authorization: `Bearer ${token}` },
});

test('check-in do Host é único e libera só o contato do Tutor após a transição', async () => {
    const tutor = await newTutor();
    const { token, service } = await newHost();
    const other = await newHost();
    const address = { zipCode: '87000000', street: 'Rua de Teste', number: '12', complement: null, neighborhood: 'Centro', city: 'Maringá', state: 'PR' };
    const savedAddress = await prisma.address.create({ data: address });
    addressIds.push(savedAddress.id);
    await prisma.tutor.update({ where: { id: tutor.tutor.id }, data: { addressId: savedAddress.id } });
    const today = new Date(new Date().toISOString().slice(0, 10));
    const reservation = await newReservation(tutor, service, { status: 'accepted', startDate: today, endDate: new Date(today.getTime() + 86400000) });

    const before = await list(token, { status: 'accepted' });
    assert.equal(before.status, 200);
    assert.deepEqual(before.data.items[0].tutor, { name: tutor.tutor.name });
    const forbidden = await checkIn(other.token, reservation.id);
    const missing = await checkIn(other.token, randomUUID());
    assert.equal(forbidden.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(forbidden.data, missing.data);
    assert.equal(await prisma.reservation.count({ where: { id: reservation.id, status: 'accepted', checkedInAt: null } }), 1);
    assert.equal(await prisma.notification.count({ where: { userId: tutor.user.id } }), 0);
    assert.equal((await checkIn(tutor.token, reservation.id)).status, 403);
    const invalid = await checkIn(token, reservation.id, { userId: other.provider.userId });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.data.details.map(({ field }) => field), ['userId']);

    const startedAt = Date.now();
    const attempts = await Promise.all([checkIn(token, reservation.id), checkIn(token, reservation.id)]);
    assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 409]);
    const { data } = attempts.find(({ status }) => status === 200);
    assert.ok(Date.parse(data.checkedInAt) >= startedAt && Date.parse(data.checkedInAt) <= Date.now());
    const retry = await checkIn(token, reservation.id);
    assert.equal(retry.status, 409);
    assert.equal(retry.data.code, 'RESERVATION_NOT_CONFIRMED');
    const stored = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    assert.equal(stored.status, 'checked_in');
    assert.deepEqual(data, { id: reservation.id, status: 'checked_in', checkedInAt: stored.checkedInAt.toISOString() });
    const notifications = await prisma.notification.findMany({ where: { userId: tutor.user.id, type: 'reservation_checked_in' } });
    assert.deepEqual(notifications.map(({ content }) => JSON.parse(content)), [{ reservationId: reservation.id }]);

    const after = await list(token, { status: 'checked_in' });
    assert.equal(after.status, 200);
    assert.equal(after.data.items[0].checkedInAt, data.checkedInAt);
    assert.deepEqual(after.data.items[0].tutor, { name: tutor.tutor.name, phone: tutor.tutor.phone, address });
    assert.deepEqual((await list(other.token, { status: 'checked_in' })).data.items, []);
});

test('reserva em andamento sem horário de check-in mantém o contato do Tutor oculto', async () => {
    const tutor = await newTutor();
    const { token, service } = await newHost();
    const address = await prisma.address.create({
        data: { zipCode: '87000000', street: 'Rua de Teste', number: '12', neighborhood: 'Centro', city: 'Maringá', state: 'PR' },
    });
    addressIds.push(address.id);
    await prisma.tutor.update({ where: { id: tutor.tutor.id }, data: { addressId: address.id } });
    const reservation = await newReservation(tutor, service, { status: 'checked_in' });

    const res = await list(token, { status: 'checked_in' });
    assert.equal(res.status, 200);
    const [item] = res.data.items;
    assert.equal(item.id, reservation.id);
    assert.equal(Object.hasOwn(item, 'checkedInAt'), false);
    assert.deepEqual(item.tutor, { name: tutor.tutor.name });
});

test('check-in recusa pagamento pendente e data futura sem alterar a reserva', async () => {
    const tutor = await newTutor();
    const { service, token } = await newHost();
    const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
    for (const [status, days, code] of [
        ['awaiting_payment', 0, 'RESERVATION_NOT_CONFIRMED'],
        ['accepted', 1, 'CHECK_IN_TOO_EARLY'],
    ]) {
        const reservation = await newReservation(tutor, service, {
            status, startDate: new Date(today + days * 86400000), endDate: new Date(today + 2 * 86400000),
        });
        const res = await checkIn(token, reservation.id);
        assert.equal(res.status, 409);
        assert.equal(res.data.code, code);
        const stored = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
        assert.equal(stored.status, status);
        assert.equal(stored.checkedInAt, null);
    }
    assert.equal(await prisma.notification.count({ where: { userId: tutor.user.id } }), 0);
});
