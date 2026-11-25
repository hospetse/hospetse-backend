// GET /api/v1/contracts/:id/timeline (HSP-PBI-052, testes da #544) contra o PostgreSQL real.
// Exige DATABASE_URL. Cria USERs (e-mail it-...@exemplo.com), Tutores, pets, prestadores, serviços, contratações e registros
// de teste, e remove tudo o que criou no after.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { prisma } from '../../src/lib/prisma.js';
import { FakeStorage } from '../../src/lib/fake-storage.js';
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
const http = axios.create({ baseURL: `http://localhost:${server.address().port}`, validateStatus: () => true });

const userIds = [];
const tutorIds = [];
const providerIds = [];

after(async () => {
    server.close();
    // Os registros saem junto com a contratação (onDelete: Cascade)
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

async function makeTutor({ user, token }) {
    const tutor = await prisma.tutor.create({ data: { userId: user.id, name: 'Ana' } });
    tutorIds.push(tutor.id);
    const pet = await prisma.pet.create({ data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog' } });
    return { tutor, pet, token };
}

const newTutor = async () => makeTutor(await newUser());

// O usuário do Host também volta, para testar o acesso do próprio prestador
async function newHotel() {
    const hostUser = await newUser();
    const provider = await prisma.provider.create({
        data: { userId: hostUser.user.id, providerType: 'hotel', name: 'Hotel Aberto', services: { create: [{ name: 'Hospedagem', price: 80 }] } },
        include: { services: true },
    });
    providerIds.push(provider.id);
    return { provider, hostUser };
}

const { provider: hotel, hostUser } = await newHotel();

function newReservation({ tutor, pet }, { status = 'checked_in', checkedInAt = null, logs = [] } = {}) {
    return prisma.reservation.create({
        data: {
            petId: pet.id, tutorId: tutor.id, serviceId: hotel.services[0].id, status, checkedInAt,
            startDate: new Date('2030-01-10'), endDate: new Date('2030-01-12'), totalValue: 160,
            activityLogs: { create: logs },
        },
        include: { activityLogs: true },
    });
}

const timeline = (token, id) => http.get(`/api/v1/contracts/${id}/timeline`, { headers: { Authorization: `Bearer ${token}` } });
const NOT_FOUND = { code: 'NOT_FOUND', message: 'Contratação não encontrada' };

test('hospedagem com registros devolve check-in e registros em ordem cronológica', async () => {
    const ana = await newTutor();
    // Gravados fora de ordem: a ordem da resposta vem do horário, não da inserção
    const reservation = await newReservation(ana, {
        checkedInAt: new Date('2030-01-10T09:00:00Z'),
        logs: [
            { activityType: 'medication', description: 'Vermífugo', registeredAt: new Date('2030-01-11T08:00:00Z') },
            { activityType: 'feeding', description: 'Ração', registeredAt: new Date('2030-01-10T12:00:00Z') },
            { activityType: 'walk', description: 'Passeio de 20 min', photoUrl: 'https://cdn.exemplo.com/rex.jpg', registeredAt: new Date('2030-01-10T17:30:00Z') },
        ],
    });

    const res = await timeline(ana.token, reservation.id);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, {
        contractId: reservation.id,
        type: 'hospedagem',
        status: 'checked_in',
        items: [
            { kind: 'check_in', at: '2030-01-10T09:00:00.000Z', description: null, photoUrl: null },
            { kind: 'routine', at: '2030-01-10T12:00:00.000Z', description: 'Ração', photoUrl: null },
            { kind: 'routine', at: '2030-01-10T17:30:00.000Z', description: 'Passeio de 20 min', photoUrl: 'https://cdn.exemplo.com/rex.jpg' },
            { kind: 'medication', at: '2030-01-11T08:00:00.000Z', description: 'Vermífugo', photoUrl: null },
        ],
    });
});

test('registro antes do check-in continua na posição do horário (a ordem não supõe o check-in primeiro)', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana, {
        checkedInAt: new Date('2030-01-10T09:00:00Z'),
        logs: [{ activityType: 'feeding', registeredAt: new Date('2030-01-10T08:59:59.999Z') }],
    });
    const res = await timeline(ana.token, reservation.id);
    assert.deepStrictEqual(res.data.items.map((i) => [i.kind, i.at]), [
        ['routine', '2030-01-10T08:59:59.999Z'],
        ['check_in', '2030-01-10T09:00:00.000Z'],
    ]);
});

test('eventos no mesmo instante saem em ordem estável, desempatados pelo id', async () => {
    const ana = await newTutor();
    const at = new Date('2030-01-10T12:00:00Z');
    const reservation = await newReservation(ana, {
        checkedInAt: at,
        logs: [
            { activityType: 'feeding', description: 'a', registeredAt: at },
            { activityType: 'walk', description: 'b', registeredAt: at },
            { activityType: 'medication', description: 'c', registeredAt: at },
        ],
    });
    // O check-in usa o id da contratação no desempate
    const expected = [
        { id: reservation.id, description: null },
        ...reservation.activityLogs.map((log) => ({ id: log.id, description: log.description })),
    ].sort((a, b) => (a.id < b.id ? -1 : 1)).map((e) => e.description);

    const first = await timeline(ana.token, reservation.id);
    const second = await timeline(ana.token, reservation.id);
    assert.deepStrictEqual(first.data.items.map((i) => i.description), expected);
    assert.deepStrictEqual(second.data.items, first.data.items);
});

test('contratação sem registros e sem check-in devolve lista vazia', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana, { status: 'accepted' });
    const res = await timeline(ana.token, reservation.id);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, { contractId: reservation.id, type: 'hospedagem', status: 'accepted', items: [] });
});

test('contratação em andamento sem horário de check-in gravado (legado) não inventa o check-in', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana, { status: 'checked_in', checkedInAt: null });
    assert.deepStrictEqual((await timeline(ana.token, reservation.id)).data.items, []);
});

test('contratação concluída ou cancelada continua com a linha do tempo visível', async () => {
    const ana = await newTutor();
    for (const status of ['completed', 'cancelled']) {
        const reservation = await newReservation(ana, {
            status,
            checkedInAt: new Date('2030-01-10T09:00:00Z'),
            logs: [{ activityType: 'feeding', registeredAt: new Date('2030-01-10T12:00:00Z') }],
        });
        const res = await timeline(ana.token, reservation.id);
        assert.strictEqual(res.status, 200, status);
        assert.strictEqual(res.data.status, status);
        assert.strictEqual(res.data.items.length, 2, status);
    }
});

test('só medication exato vira medicação; qualquer outro tipo vira rotina', async () => {
    const ana = await newTutor();
    const types = ['medication', 'Medication', 'MEDICATION', 'medicação', ' medication', 'bath'];
    const reservation = await newReservation(ana, {
        logs: types.map((activityType, i) => ({ activityType, registeredAt: new Date(Date.UTC(2030, 0, 10, 10 + i)) })),
    });
    const res = await timeline(ana.token, reservation.id);
    assert.deepStrictEqual(res.data.items.map((i) => i.kind), ['medication', 'routine', 'routine', 'routine', 'routine', 'routine']);
});

test('foto guardada no bucket sai como URL assinada; URL externa e foto ausente passam sem mudança', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana, {
        logs: [
            { activityType: 'walk', photoUrl: 'activity-logs/rex.jpg', registeredAt: new Date('2030-01-10T10:00:00Z') },
            { activityType: 'walk', photoUrl: 'https://cdn.exemplo.com/rex.jpg', registeredAt: new Date('2030-01-10T11:00:00Z') },
            { activityType: 'walk', photoUrl: null, registeredAt: new Date('2030-01-10T12:00:00Z') },
        ],
    });
    const res = await timeline(ana.token, reservation.id);
    assert.deepStrictEqual(res.data.items.map((i) => i.photoUrl), [
        'https://fake-storage.test/activity-logs/rex.jpg?signed=1',
        'https://cdn.exemplo.com/rex.jpg',
        null,
    ]);
});

test('registros de outra contratação do mesmo Tutor não aparecem', async () => {
    const ana = await newTutor();
    const mine = await newReservation(ana, { logs: [{ activityType: 'feeding', description: 'desta', registeredAt: new Date('2030-01-10T10:00:00Z') }] });
    await newReservation(ana, { logs: [{ activityType: 'feeding', description: 'da outra', registeredAt: new Date('2030-01-10T11:00:00Z') }] });
    const res = await timeline(ana.token, mine.id);
    assert.deepStrictEqual(res.data.items.map((i) => i.description), ['desta']);
});

test('outro Tutor recebe o mesmo 404 de uma contratação inexistente, sem nenhum dado', async () => {
    const ana = await newTutor();
    const beto = await newTutor();
    const reservation = await newReservation(ana, { logs: [{ activityType: 'feeding', registeredAt: new Date('2030-01-10T10:00:00Z') }] });

    const ofOther = await timeline(beto.token, reservation.id);
    const missing = await timeline(beto.token, randomUUID());
    assert.strictEqual(ofOther.status, 404);
    assert.deepStrictEqual(ofOther.data, NOT_FOUND);
    assert.deepStrictEqual(missing.data, ofOther.data);
});

test('o Host da contratação não acessa: sem perfil de Tutor, 403; com perfil de Tutor, 404', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana);

    const asHost = await timeline(hostUser.token, reservation.id);
    assert.strictEqual(asHost.status, 403);
    assert.strictEqual(asHost.data.code, 'PROFILE_INCOMPLETE');

    // Um prestador que também é Tutor continua fora: o acesso é pelo Tutor da contratação, não pelo papel
    const { provider, hostUser: hostTutorUser } = await newHotel();
    const hostTutor = await makeTutor(hostTutorUser);
    const ofHisHotel = await prisma.reservation.create({
        data: { petId: ana.pet.id, tutorId: ana.tutor.id, serviceId: provider.services[0].id, status: 'checked_in', startDate: new Date('2030-01-10'), totalValue: 80 },
    });
    const res = await timeline(hostTutor.token, ofHisHotel.id);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(res.data, NOT_FOUND);
});

test('id fora do formato UUID recebe 404, sem erro de banco', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana);
    for (const id of ['nao-e-uuid', '123', `${reservation.id}x`, reservation.id.slice(0, -1), '%20', `${reservation.id}%20`, "1' OR '1'='1"]) {
        const res = await timeline(ana.token, encodeURIComponent(decodeURIComponent(id)));
        assert.strictEqual(res.status, 404, id);
        assert.deepStrictEqual(res.data, NOT_FOUND, id);
    }
});

test('UUID em maiúsculas encontra a mesma contratação', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana);
    const res = await timeline(ana.token, reservation.id.toUpperCase());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.contractId, reservation.id);
});

test('sem token ou com token inválido: 401', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana);
    assert.strictEqual((await http.get(`/api/v1/contracts/${reservation.id}/timeline`)).status, 401);
    assert.strictEqual((await timeline('token-invalido', reservation.id)).status, 401);
});

test.todo('visita e passeio: início, registros e fim em ordem cronológica (entra com a #570, HSP-PBI-053-TSK-01)');
test.todo('check-out no fim da hospedagem (entra com a #545, HSP-PBI-049-TSK-01)');
