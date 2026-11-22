import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { prisma } from '../../src/lib/prisma.js';

try { process.loadEnvFile(); } catch { /* DATABASE_URL pode vir do ambiente */ }
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente: configure um banco local de teste');
const { publicKey, privateKey } = await generateKeyPair('RS256');
process.env.JWT_PUBLIC_KEY = await exportSPKI(publicKey);
const { default: app } = await import('../../src/app.js');
const server = app.listen(0);
await once(server, 'listening');
const base = `http://localhost:${server.address().port}`;
const userIds = [];

after(async () => {
    server.close();
    await prisma.reservation.deleteMany({ where: { service: { provider: { userId: { in: userIds } } } } });
    await prisma.pet.deleteMany({ where: { tutor: { userId: { in: userIds } } } });
    await prisma.tutor.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.service.deleteMany({ where: { provider: { userId: { in: userIds } } } });
    await prisma.provider.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

async function user(providerType, validationStatus = 'approved') {
    const authUserId = randomUUID();
    const saved = await prisma.user.create({ data: { authUserId, email: `it-area-${authUserId}@hospetse.test`, name: 'Teste' } });
    userIds.push(saved.id);
    const provider = providerType && await prisma.provider.create({ data: { userId: saved.id, providerType, name: 'Cuidados', validationStatus } });
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject(authUserId)
        .setIssuer('hospetse-auth-service').setAudience('hospetse-backend').setExpirationTime('5m').sign(privateKey);
    return { saved, provider, headers: { Authorization: `Bearer ${token}` } };
}

async function api(method, path, headers, body) {
    const res = await fetch(base + path, { method, headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
}

const config = (overrides = {}) => ({ serviceCity: 'São Paulo', serviceNeighborhoods: ['Centro'],
    workingHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }], price: 50, ...overrides });
const query = (params) => `/api/v1/providers/search?${new URLSearchParams(params)}`;
const monday = () => {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + (8 - day.getUTCDay()) % 7 + 7);
    return day.toISOString().slice(0, 10);
};

test('só Sitter ou Walker aprovado e autenticado configura; inválido preserva a versão anterior', async () => {
    const sitter = await user('pet_sitter');
    const pending = await user('pet_walker', 'draft');
    const rejected = await user('pet_sitter', 'rejected');
    const hotel = await user('hotel');
    assert.equal((await api('GET', '/api/v1/me/provider/availability')).status, 401);
    assert.equal((await api('PUT', '/api/v1/me/provider/availability', pending.headers, config({ durationWalkMinutes: 60 }))).status, 403);
    assert.equal((await api('GET', '/api/v1/me/provider/availability', pending.headers)).status, 403);
    assert.equal((await api('PUT', '/api/v1/me/provider/availability', rejected.headers, config())).status, 403);
    assert.equal((await prisma.service.count({ where: { providerId: rejected.provider.id } })), 0);
    assert.equal((await api('GET', '/api/v1/me/provider/availability', hotel.headers)).status, 404);
    const empty = await api('GET', '/api/v1/me/provider/availability', sitter.headers);
    assert.equal(empty.status, 200);
    assert.equal(empty.data.price, null);
    const saved = await api('PUT', '/api/v1/me/provider/availability', sitter.headers, config());
    assert.equal(saved.status, 200);
    assert.equal(saved.data.price, 50);
    assert.deepEqual(saved.data.workingHours, config().workingHours);
    assert.equal((await prisma.service.count({ where: { providerId: sitter.provider.id } })), 1);
    const beforeInvalid = (await api('GET', '/api/v1/me/provider/availability', sitter.headers)).data;
    for (const [change, field] of [
        [{ serviceNeighborhoods: ['Centro', 'centro'] }, 'serviceNeighborhoods.1'],
        [{ workingHours: [{ dayOfWeek: 1, startTime: '10:00', endTime: '10:00' }] }, 'workingHours.0.endTime'],
        [{ price: 50.001 }, 'price'],
    ]) {
        const response = await api('PUT', '/api/v1/me/provider/availability', sitter.headers, config(change));
        assert.equal(response.status, 400);
        assert.deepEqual(response.data.details.map((item) => item.field), [field]);
        assert.deepEqual((await api('GET', '/api/v1/me/provider/availability', sitter.headers)).data, beforeInvalid);
    }
    const invalid = await api('PUT', '/api/v1/me/provider/availability', sitter.headers, config({ price: -1, serviceCity: '',
        workingHours: [{ dayOfWeek: 1, startTime: '11:00', endTime: '12:00' }, { dayOfWeek: 1, startTime: '11:30', endTime: '13:00' }],
        userId: pending.saved.id }));
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.data.details.map((item) => item.field), ['serviceCity', 'workingHours', 'price', 'userId']);
    assert.equal((await api('GET', '/api/v1/me/provider/availability', sitter.headers)).data.price, 50);
    assert.deepEqual((await api('GET', '/api/v1/me/provider/availability', sitter.headers)).data.workingHours, config().workingHours);
    assert.equal((await prisma.provider.findUnique({ where: { id: sitter.provider.id } })).serviceCity, 'São Paulo');
});

test('busca usa área, dia, horário e preço; contratação aceita bloqueia o horário sem alterar snapshot', async () => {
    const city = `it-area-${randomUUID()}`;
    const sitter = await user('pet_sitter');
    const walker = await user('pet_walker');
    const tutor = await user();
    const tutorProfile = await prisma.tutor.create({ data: { userId: tutor.saved.id, name: 'Tutor' } });
    const pet = await prisma.pet.create({ data: { tutorId: tutorProfile.id, petName: 'Rex', petSpecies: 'dog' } });
    await prisma.provider.update({ where: { id: sitter.provider.id }, data: { acceptedSpecies: ['dog'] } });
    assert.equal((await api('PUT', '/api/v1/me/provider/availability', sitter.headers, config({ serviceCity: city }))).status, 200);
    assert.equal((await api('PUT', '/api/v1/me/provider/availability', walker.headers, config({ serviceCity: city, durationWalkMinutes: 60, price: 80, serviceNeighborhoods: [] }))).status, 200);
    assert.equal((await api('GET', '/api/v1/me/provider/availability', walker.headers)).data.durationWalkMinutes, 60);
    const date = monday();
    const filters = { providerType: 'pet_sitter', city, neighborhood: 'centro', date, startTime: '10:00', endTime: '11:00' };
    const available = await api('GET', query(filters), tutor.headers);
    assert.equal(available.status, 200);
    assert.equal(available.data.total, 1);
    assert.equal(available.data.items[0].providerId, sitter.provider.id);
    const withPet = await api('GET', query({ ...filters, petId: pet.id }), tutor.headers);
    assert.equal(withPet.status, 200, JSON.stringify(withPet.data));
    assert.equal(withPet.data.total, 1);
    assert.equal((await api('GET', query({ ...filters, species: 'cat' }), tutor.headers)).data.total, 0);
    assert.equal((await api('GET', query({ ...filters, petId: pet.id }), sitter.headers)).status, 400);
    assert.equal((await api('GET', query({ ...filters, neighborhood: 'Moema' }), tutor.headers)).data.total, 0);
    assert.equal((await api('GET', query({ ...filters, minPrice: 60 }), tutor.headers)).data.total, 0);
    assert.equal((await api('GET', query({ ...filters, startTime: '18:00', endTime: '19:00' }), tutor.headers)).data.total, 0);
    assert.equal((await api('GET', query({ ...filters, providerType: 'pet_walker', neighborhood: 'Moema' }), tutor.headers)).data.total, 1);
    const serviceId = available.data.items[0].serviceId;
    const reservation = await prisma.reservation.create({ data: { serviceId, petId: pet.id, tutorId: tutorProfile.id,
        status: 'requested', startDate: new Date(`${date}T10:30:00-03:00`), endDate: new Date(`${date}T11:30:00-03:00`), totalValue: 50, dailyPrice: 50 } });
    assert.equal((await api('GET', query(filters), tutor.headers)).data.total, 1);
    assert.deepEqual((await api('GET', `/api/v1/me/provider/availability?date=${date}`, sitter.headers)).data.busyIntervals, []);
    await prisma.reservation.update({ where: { id: reservation.id }, data: { status: 'accepted' } });
    assert.equal((await api('GET', query(filters), tutor.headers)).data.total, 0);
    assert.deepEqual((await api('GET', `/api/v1/me/provider/availability?date=${date}`, sitter.headers)).data.busyIntervals,
        [{ startTime: '10:30', endTime: '11:30' }]);
    const previous = new Date(`${date}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    await prisma.reservation.createMany({ data: [
        { serviceId, petId: pet.id, tutorId: tutorProfile.id, status: 'accepted',
            startDate: new Date(`${previous.toISOString().slice(0, 10)}T23:30:00-03:00`), endDate: new Date(`${date}T01:00:00-03:00`), totalValue: 50 },
        { serviceId, petId: pet.id, tutorId: tutorProfile.id, status: 'accepted',
            startDate: new Date(`${date}T23:00:00-03:00`), endDate: new Date(`${next.toISOString().slice(0, 10)}T01:00:00-03:00`), totalValue: 50 },
    ] });
    assert.deepEqual((await api('GET', `/api/v1/me/provider/availability?date=${date}`, sitter.headers)).data.busyIntervals,
        [{ startTime: '00:00', endTime: '01:00' }, { startTime: '10:30', endTime: '11:30' }, { startTime: '23:00', endTime: '24:00' }]);
    assert.equal((await api('GET', query({ ...filters, startTime: '09:00', endTime: '10:30' }), tutor.headers)).data.total, 1);
    assert.equal((await api('PUT', '/api/v1/me/provider/availability', sitter.headers, config({ serviceCity: city, price: 75 }))).status, 200);
    assert.equal(Number((await prisma.reservation.findUnique({ where: { id: reservation.id } })).totalValue), 50);
    assert.equal((await api('GET', query({ ...filters, startTime: '09:00', endTime: '10:30', maxPrice: 60 }), tutor.headers)).data.total, 0);
});

test('Walker atualiza área, horário, preço e duração; a busca usa apenas a configuração nova', async () => {
    const walker = await user('pet_walker');
    const tutor = await user();
    const oldCity = `it-area-${randomUUID()}`;
    const newCity = `it-area-${randomUUID()}`;
    assert.equal((await api('PUT', '/api/v1/me/provider/availability', walker.headers,
        config({ serviceCity: oldCity, serviceNeighborhoods: [], durationWalkMinutes: 60 }))).status, 200);
    const updated = config({ serviceCity: newCity, serviceNeighborhoods: ['Centro'],
        workingHours: [{ dayOfWeek: 1, startTime: '12:00', endTime: '14:00' }], price: 95, durationWalkMinutes: 45 });
    assert.equal((await api('PUT', '/api/v1/me/provider/availability', walker.headers, updated)).status, 200);
    const current = await api('GET', '/api/v1/me/provider/availability', walker.headers);
    assert.equal(current.status, 200);
    assert.deepEqual(current.data, { providerType: 'pet_walker', serviceCity: newCity,
        serviceNeighborhoods: ['Centro'], workingHours: updated.workingHours,
        price: 95, durationWalkMinutes: 45, busyIntervals: [] });
    const invalid = await api('PUT', '/api/v1/me/provider/availability', walker.headers,
        { ...updated, durationWalkMinutes: 0 });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.data.details.map((item) => item.field), ['durationWalkMinutes']);
    assert.deepEqual((await api('GET', '/api/v1/me/provider/availability', walker.headers)).data, current.data);
    const filters = { providerType: 'pet_walker', city: newCity, neighborhood: 'centro',
        date: monday(), startTime: '12:00', endTime: '13:00' };
    const found = await api('GET', query(filters), tutor.headers);
    assert.equal(found.data.total, 1);
    assert.equal(found.data.items[0].providerId, walker.provider.id);
    assert.equal(found.data.items[0].price, 95);
    assert.equal(found.data.items[0].durationWalkMinutes, 45);
    assert.equal((await api('GET', query({ ...filters, city: oldCity }), tutor.headers)).data.total, 0);
    assert.equal((await api('GET', query({ ...filters, startTime: '10:00', endTime: '11:00' }), tutor.headers)).data.total, 0);
});

test('busca pagina por preço sem repetir nem omitir ofertas', async () => {
    const city = `it-area-${randomUUID()}`;
    const first = await user('pet_sitter');
    const second = await user('pet_sitter');
    const tutor = await user();
    assert.equal((await api('PUT', '/api/v1/me/provider/availability', first.headers, config({ serviceCity: city, price: 90 }))).status, 200);
    assert.equal((await api('PUT', '/api/v1/me/provider/availability', second.headers, config({ serviceCity: city, price: 40 }))).status, 200);
    const filters = { providerType: 'pet_sitter', city, pageSize: 1 };
    const page1 = await api('GET', query({ ...filters, page: 1 }), tutor.headers);
    const page2 = await api('GET', query({ ...filters, page: 2 }), tutor.headers);
    assert.equal(page1.data.total, 2);
    assert.equal(page2.data.total, 2);
    assert.equal(page1.data.items[0].providerId, second.provider.id);
    assert.equal(page2.data.items[0].providerId, first.provider.id);
});
