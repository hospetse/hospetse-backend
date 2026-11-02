// Agenda do Host (HSP-PBI-036-TSK-01 #482) contra o PostgreSQL real. Exige DATABASE_URL.
// Cria USERs (e-mail it-agenda-...@exemplo.com), Hosts, Tutores e reservas de teste, e remove tudo o que criou no after.
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
    // bloqueios e hotel_details saem em cascata com o prestador; o resto, na ordem das chaves estrangeiras
    await prisma.reservation.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.pet.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.tutor.deleteMany({ where: { id: { in: tutorIds } } });
    await prisma.service.deleteMany({ where: { providerId: { in: providerIds } } });
    await prisma.provider.deleteMany({ where: { id: { in: providerIds } } });
    await prisma.address.deleteMany({ where: { id: { in: addressIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

const day = (offset) => new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const auth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

async function newUser(data = {}) {
    const authUserId = randomUUID();
    const user = await prisma.user.create({ data: { authUserId, email: `it-agenda-${authUserId}@exemplo.com`, name: 'Teste Agenda', ...data } });
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

// Tutor com perfil completo e um pet ativo
async function newTutor() {
    const { user, token } = await newUser({ status: 'active', profileStatus: 'complete' });
    const tutor = await prisma.tutor.create({ data: { userId: user.id, name: user.name } });
    tutorIds.push(tutor.id);
    const pet = await prisma.pet.create({ data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog', petSize: 'medium' } });
    return { tutor, pet, token };
}

// Host elegível numa cidade só dele, com uma diária; devolve o token do dono para as rotas /me/host
async function newHost() {
    const { user, token } = await newUser();
    const address = await prisma.address.create({
        data: { zipCode: '01001000', street: 'Rua Teste', number: '1', neighborhood: 'Centro', city: `it-agenda-${randomUUID()}`, state: 'SP' },
    });
    addressIds.push(address.id);
    const provider = await prisma.provider.create({
        data: {
            userId: user.id, providerType: 'hotel', name: 'Hotelzinho de Teste', status: 'active', validationStatus: 'approved',
            addressId: address.id, services: { create: [{ name: 'Diária', price: 100 }] },
        },
        include: { services: true },
    });
    providerIds.push(provider.id);
    return { provider, service: provider.services[0], token, city: address.city };
}

function booked(service, { tutor, pet }, start, end, status = 'accepted') {
    return prisma.reservation.create({
        data: {
            tutorId: tutor.id, petId: pet.id, serviceId: service.id, status,
            startDate: new Date(day(start)), endDate: new Date(day(end)), dailyPrice: 100, totalValue: 100 * (end - start),
        },
    });
}

const agenda = (token, start, end) => http.get('/api/v1/me/host/agenda', { params: { startDate: day(start), endDate: day(end) }, ...auth(token) });
const block = (token, body) => http.post('/api/v1/me/host/agenda/blocks', body, auth(token));

test('quem não é Host recebe 403 HOST_REQUIRED nas três rotas', async () => {
    const { token } = await newUser();
    const responses = [
        await http.get('/api/v1/me/host/agenda', auth(token)),
        await block(token, { startDate: day(1), endDate: day(2) }),
        await http.delete(`/api/v1/me/host/agenda/blocks/${randomUUID()}`, auth(token)),
    ];
    for (const res of responses) {
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.data.code, 'HOST_REQUIRED');
    }
});

test('agenda distingue livre, bloqueado e ocupado; com vaga sobrando, o dia segue livre com a contagem', async () => {
    const host = await newHost();
    const occupant = await newTutor();
    await prisma.providerBlockedDate.create({ data: { providerId: host.provider.id, date: new Date(day(11)), reason: 'Reforma' } });
    await booked(host.service, occupant, 12, 13);

    const single = await agenda(host.token, 10, 13);
    await prisma.hotelDetail.create({ data: { providerId: host.provider.id, capacity: 2 } });
    const double = await agenda(host.token, 12, 13);

    assert.strictEqual(single.status, 200);
    assert.strictEqual(single.data.capacity, 1);
    assert.deepStrictEqual(single.data.days.map((d) => [d.date, d.status, d.occupied]), [
        [day(10), 'free', 0], [day(11), 'blocked', 0], [day(12), 'occupied', 1],
    ]);
    assert.strictEqual(single.data.days[1].block.reason, 'Reforma');
    assert.deepStrictEqual(double.data.days.map((d) => [d.status, d.occupied]), [['free', 1]]);
});

test('bloquear período livre: uma linha por dia, o fim não entra, e repetir não duplica', async () => {
    const host = await newHost();

    const first = await block(host.token, { startDate: day(10), endDate: day(13), reason: 'Férias' });
    const again = await block(host.token, { startDate: day(12), endDate: day(14) });

    assert.strictEqual(first.status, 201);
    assert.deepStrictEqual(first.data.items.map((b) => [b.date, b.reason]), [[day(10), 'Férias'], [day(11), 'Férias'], [day(12), 'Férias']]);
    assert.strictEqual(again.status, 201);
    assert.deepStrictEqual(again.data.items.map((b) => [b.date, b.reason]), [[day(12), 'Férias'], [day(13), null]]);
    assert.strictEqual(await prisma.providerBlockedDate.count({ where: { providerId: host.provider.id } }), 4);
});

test('bloquear sobre hospedagem aceita: 409 PERIOD_OCCUPIED, nenhum dia criado e a reserva intacta', async () => {
    const host = await newHost();
    const reservation = await booked(host.service, await newTutor(), 11, 12);

    const res = await block(host.token, { startDate: day(10), endDate: day(13) });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.data.code, 'PERIOD_OCCUPIED');
    assert.strictEqual(await prisma.providerBlockedDate.count({ where: { providerId: host.provider.id } }), 0);
    assert.strictEqual((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, 'accepted');
});

test('bloquear sobre solicitação só pendente: 201, e o aceite dela passa a responder 409 PERIOD_UNAVAILABLE', async () => {
    const host = await newHost();
    const pending = await booked(host.service, await newTutor(), 11, 12, 'requested');

    const blocked = await block(host.token, { startDate: day(10), endDate: day(13) });
    const accept = await http.post(`/api/v1/me/host/reservations/${pending.id}/accept`, null, auth(host.token));

    assert.strictEqual(blocked.status, 201);
    assert.strictEqual(accept.status, 409);
    assert.strictEqual(accept.data.code, 'PERIOD_UNAVAILABLE');
    assert.strictEqual((await prisma.reservation.findUnique({ where: { id: pending.id } })).status, 'requested');
});

test('dia bloqueado some da busca e não aceita solicitação nova', async () => {
    const host = await newHost();
    const { pet, token } = await newTutor();
    await block(host.token, { startDate: day(11), endDate: day(12) });

    const search = await http.get('/api/v1/hosts/search', { params: { city: host.city, startDate: day(10), endDate: day(13) }, ...auth(token) });
    const created = await http.post('/api/v1/reservations',
        { serviceId: host.service.id, petId: pet.id, startDate: day(10), endDate: day(13) },
        { headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() } });

    assert.deepStrictEqual(search.data.items, []);
    assert.strictEqual(created.status, 409);
    assert.strictEqual(created.data.code, 'PERIOD_UNAVAILABLE');
});

test('período inválido: 400 com todos os campos e nada gravado', async () => {
    const host = await newHost();

    const res = await block(host.token, { startDate: day(-1), endDate: day(-2), providerId: randomUUID() });
    const query = await http.get('/api/v1/me/host/agenda', { params: { startDate: day(5), endDate: day(200) }, ...auth(host.token) });

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data.details.map((d) => d.field), ['startDate', 'endDate', 'providerId']);
    assert.strictEqual(await prisma.providerBlockedDate.count({ where: { providerId: host.provider.id } }), 0);
    assert.strictEqual(query.status, 400);
    assert.deepStrictEqual(query.data.details, [{ field: 'endDate', message: 'até 90 dias depois de startDate' }]);
});

test('um Host não vê nem apaga o bloqueio de outro; o dono apaga e o dia volta a livre', async () => {
    const owner = await newHost();
    const other = await newHost();
    const { data } = await block(owner.token, { startDate: day(10), endDate: day(11) });
    const [ownBlock] = data.items;

    const otherAgenda = await agenda(other.token, 10, 11);
    const otherDelete = await http.delete(`/api/v1/me/host/agenda/blocks/${ownBlock.id}`, auth(other.token));
    const badId = await http.delete('/api/v1/me/host/agenda/blocks/abc', auth(owner.token));
    const ownDelete = await http.delete(`/api/v1/me/host/agenda/blocks/${ownBlock.id}`, auth(owner.token));
    const after = await agenda(owner.token, 10, 11);

    assert.strictEqual(otherAgenda.data.days[0].status, 'free');
    assert.strictEqual(otherDelete.status, 404);
    assert.strictEqual(otherDelete.data.code, 'NOT_FOUND');
    assert.strictEqual(badId.status, 404);
    assert.strictEqual(ownDelete.status, 204);
    assert.strictEqual(after.data.days[0].status, 'free');
});

// #484: matriz completa da agenda (estados, limites, desbloqueio, isolamento e concorrência com o aceite)
test('sem token: 401 nas três rotas', async () => {
    const responses = [
        await http.get('/api/v1/me/host/agenda'),
        await http.post('/api/v1/me/host/agenda/blocks', { startDate: day(1), endDate: day(2) }),
        await http.delete(`/api/v1/me/host/agenda/blocks/${randomUUID()}`),
    ];
    for (const res of responses) assert.strictEqual(res.status, 401);
});

test('agenda sem datas: 30 dias a partir de hoje, todos livres, com a capacidade cadastrada', async () => {
    const host = await newHost();
    await prisma.hotelDetail.create({ data: { providerId: host.provider.id, capacity: 3 } });

    const res = await http.get('/api/v1/me/host/agenda', auth(host.token));

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.startDate, day(0));
    assert.strictEqual(res.data.capacity, 3);
    assert.strictEqual(res.data.days.length, 30);
    assert.ok(res.data.days.every((d) => d.status === 'free' && d.occupied === 0));
});

test('só aguardando pagamento, aceita e em andamento ocupam o dia; os demais status deixam livre', async () => {
    const occupant = await newTutor();
    const statuses = ['awaiting_payment', 'accepted', 'checked_in', 'requested', 'rejected', 'cancelled', 'completed'];
    const result = {};
    for (const status of statuses) {
        const host = await newHost();
        await booked(host.service, occupant, 10, 11, status);
        const res = await agenda(host.token, 10, 11);
        result[status] = [res.data.days[0].status, res.data.days[0].occupied];
    }

    assert.deepStrictEqual(result, {
        awaiting_payment: ['occupied', 1], accepted: ['occupied', 1], checked_in: ['occupied', 1],
        requested: ['free', 0], rejected: ['free', 0], cancelled: ['free', 0], completed: ['free', 0],
    });
});

test('ocupação por dia: o dia da saída fica livre; com capacidade 2, duas reservas no mesmo dia ocupam', async () => {
    const host = await newHost();
    await prisma.hotelDetail.create({ data: { providerId: host.provider.id, capacity: 2 } });
    await booked(host.service, await newTutor(), 10, 12);
    await booked(host.service, await newTutor(), 11, 13);

    const res = await agenda(host.token, 10, 14);

    assert.deepStrictEqual(res.data.days.map((d) => [d.status, d.occupied]), [
        ['free', 1], ['occupied', 2], ['free', 1], ['free', 0],
    ]);
});

test('dia com bloqueio e reserva ao mesmo tempo aparece como bloqueado', async () => {
    const host = await newHost();
    await booked(host.service, await newTutor(), 10, 11);
    // Só existe gravando direto: a rota não deixa bloquear dia ocupado
    await prisma.providerBlockedDate.create({ data: { providerId: host.provider.id, date: new Date(day(10)) } });

    const res = await agenda(host.token, 10, 11);

    assert.deepStrictEqual([res.data.days[0].status, res.data.days[0].occupied], ['blocked', 1]);
});

test('bloqueio sobre reserva: 409 em aguardando pagamento e em andamento; 201 em recusada, cancelada e a partir da saída', async () => {
    const occupant = await newTutor();
    const outcomes = {};
    for (const status of ['awaiting_payment', 'checked_in', 'rejected', 'cancelled']) {
        const host = await newHost();
        await booked(host.service, occupant, 10, 12, status);
        const res = await block(host.token, { startDate: day(10), endDate: day(12) });
        outcomes[status] = res.status === 409 ? res.data.code : res.status;
    }
    const adjacent = await newHost();
    await booked(adjacent.service, occupant, 10, 12);
    const fromCheckout = await block(adjacent.token, { startDate: day(12), endDate: day(14) });

    assert.deepStrictEqual(outcomes, { awaiting_payment: 'PERIOD_OCCUPIED', checked_in: 'PERIOD_OCCUPIED', rejected: 201, cancelled: 201 });
    assert.strictEqual(fromCheckout.status, 201);
});

test('limites do bloqueio: um dia a partir de hoje e 365 dias passam; 366 dias recebe 400', async () => {
    const host = await newHost();

    const oneDay = await block(host.token, { startDate: day(0), endDate: day(1) });
    const fullYear = await block(host.token, { startDate: day(1), endDate: day(366) });
    const tooLong = await block(host.token, { startDate: day(1), endDate: day(367) });

    assert.strictEqual(oneDay.status, 201);
    assert.deepStrictEqual(oneDay.data.items.map((b) => b.date), [day(0)]);
    assert.strictEqual(fullYear.status, 201);
    assert.strictEqual(fullYear.data.items.length, 365);
    assert.strictEqual(tooLong.status, 400);
    assert.deepStrictEqual(tooLong.data.details, [{ field: 'endDate', message: 'até 365 dias depois de startDate' }]);
});

test('desbloquear devolve o dia à busca e à solicitação; apagar de novo responde 404', async () => {
    const host = await newHost();
    const { pet, token } = await newTutor();
    const period = { city: host.city, startDate: day(10), endDate: day(12) };
    const { data } = await block(host.token, { startDate: day(11), endDate: day(12) });
    const [blocked] = data.items;

    const hidden = await http.get('/api/v1/hosts/search', { params: period, ...auth(token) });
    const removed = await http.delete(`/api/v1/me/host/agenda/blocks/${blocked.id}`, auth(host.token));
    const again = await http.delete(`/api/v1/me/host/agenda/blocks/${blocked.id}`, auth(host.token));
    const shown = await http.get('/api/v1/hosts/search', { params: period, ...auth(token) });
    const created = await http.post('/api/v1/reservations',
        { serviceId: host.service.id, petId: pet.id, startDate: day(10), endDate: day(12) },
        { headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() } });

    assert.deepStrictEqual(hidden.data.items, []);
    assert.strictEqual(removed.status, 204);
    assert.strictEqual(again.status, 404);
    assert.deepStrictEqual(shown.data.items.map((i) => i.hostId), [host.provider.id]);
    assert.strictEqual(created.status, 201);
});

test('a agenda de um Host não mostra a ocupação nem os bloqueios de outro', async () => {
    const busy = await newHost();
    const other = await newHost();
    await booked(busy.service, await newTutor(), 10, 11);
    await block(busy.token, { startDate: day(11), endDate: day(12) });

    const res = await agenda(other.token, 10, 12);

    assert.deepStrictEqual(res.data.days.map((d) => [d.status, d.occupied]), [['free', 0], ['free', 0]]);
});

test('bloqueio e aceite ao mesmo tempo no mesmo período: só um passa e o estado final é coerente', async () => {
    const host = await newHost();
    const pending = await booked(host.service, await newTutor(), 10, 12, 'requested');

    const [blocked, accepted] = await Promise.all([
        block(host.token, { startDate: day(10), endDate: day(12) }),
        http.post(`/api/v1/me/host/reservations/${pending.id}/accept`, null, auth(host.token)),
    ]);

    const status = (await prisma.reservation.findUnique({ where: { id: pending.id } })).status;
    const blocks = await prisma.providerBlockedDate.count({ where: { providerId: host.provider.id } });
    if (blocked.status === 201) {
        assert.strictEqual(accepted.status, 409);
        assert.strictEqual(accepted.data.code, 'PERIOD_UNAVAILABLE');
        assert.deepStrictEqual([status, blocks], ['requested', 2]);
    } else {
        assert.strictEqual(blocked.status, 409);
        assert.strictEqual(blocked.data.code, 'PERIOD_OCCUPIED');
        assert.strictEqual(accepted.status, 200);
        assert.deepStrictEqual([status, blocks], ['awaiting_payment', 0]);
    }
});
