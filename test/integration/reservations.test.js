// POST /api/v1/reservations (HSP-PBI-039-TSK-01 #494) contra o PostgreSQL real. Exige DATABASE_URL.
// Cria USERs (e-mail it-...@exemplo.com), Tutores, pets, Hosts e serviços de teste, e remove tudo o que criou no after.
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

after(async () => {
    server.close();
    // bloqueios e fotos saem em cascata com o prestador; o resto, na ordem das chaves estrangeiras
    await prisma.reservation.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.pet.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.tutor.deleteMany({ where: { id: { in: tutorIds } } });
    await prisma.service.deleteMany({ where: { providerId: { in: providerIds } } });
    await prisma.provider.deleteMany({ where: { id: { in: providerIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

// Dia em UTC a partir de hoje, no formato do contrato
const day = (offset) => new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function newUser(data = {}) {
    const authUserId = randomUUID();
    const user = await prisma.user.create({ data: { authUserId, email: `it-${authUserId}@exemplo.com`, name: 'Teste Integração', ...data } });
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

// Tutor com perfil completo e um pet ativo (cachorro médio)
async function newTutor(pet = {}) {
    const { user, token } = await newUser({ status: 'active', profileStatus: 'complete' });
    const tutor = await prisma.tutor.create({ data: { userId: user.id, name: user.name } });
    tutorIds.push(tutor.id);
    const created = await prisma.pet.create({
        data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog', petSize: 'medium', petBreed: 'Vira-lata', ...pet },
    });
    return { tutor, pet: created, token };
}

// Host elegível com um serviço de diária a R$ 120,50; overrides mudam o Host, service muda o serviço
async function newHost(overrides = {}, service = {}) {
    const { user } = await newUser();
    const provider = await prisma.provider.create({
        data: {
            userId: user.id,
            providerType: 'hotel',
            name: 'Hotelzinho de Teste',
            status: 'active',
            validationStatus: 'approved',
            services: { create: [{ name: 'Diária', price: 120.5, ...service }] },
            ...overrides,
        },
        include: { services: true },
    });
    providerIds.push(provider.id);
    return { provider, service: provider.services[0] };
}

function post(body, { token, key = randomUUID() } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (key) headers['Idempotency-Key'] = key;
    return http.post('/api/v1/reservations', body, { headers });
}

const validBody = (service, pet) => ({ serviceId: service.id, petId: pet.id, startDate: day(10), endDate: day(13), notes: 'Toma remédio às 8h' });

test('perfil incompleto: 403 PROFILE_INCOMPLETE pela guarda da #263', async () => {
    const { token } = await newUser();
    const res = await post({}, { token });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.data.code, 'PROFILE_INCOMPLETE');
});

test('dados válidos: 201 com uma solicitação pendente e o snapshot da diária e do total', async () => {
    const { tutor, pet, token } = await newTutor();
    const { provider, service } = await newHost();
    const key = randomUUID();

    const res = await post(validBody(service, pet), { token, key });

    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(res.data, {
        id: res.data.id,
        status: 'requested',
        hostId: provider.id,
        serviceId: service.id,
        petId: pet.id,
        startDate: day(10),
        endDate: day(13),
        dailyPrice: 120.5,
        totalValue: 361.5,
        notes: 'Toma remédio às 8h',
        createdAt: res.data.createdAt,
    });
    const saved = await prisma.reservation.findMany({ where: { tutorId: tutor.id } });
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].idempotencyKey, key);
});

test('reenvio com a mesma Idempotency-Key: 200 com a mesma solicitação, sem duplicar, mesmo se o preço mudar', async () => {
    const { tutor, pet, token } = await newTutor();
    const { service } = await newHost();
    const key = randomUUID();

    const first = await post(validBody(service, pet), { token, key });
    await prisma.service.update({ where: { id: service.id }, data: { price: 200 } });
    const again = await post(validBody(service, pet), { token, key });

    assert.strictEqual(first.status, 201);
    assert.strictEqual(again.status, 200);
    assert.deepStrictEqual(again.data, first.data);
    assert.strictEqual(await prisma.reservation.count({ where: { tutorId: tutor.id } }), 1);
});

test('dois envios simultâneos com a mesma chave criam uma única solicitação', async () => {
    const { tutor, pet, token } = await newTutor();
    const { service } = await newHost();
    const key = randomUUID();

    const results = await Promise.all([post(validBody(service, pet), { token, key }), post(validBody(service, pet), { token, key })]);

    assert.deepStrictEqual(results.map((res) => res.status).sort(), [200, 201]);
    assert.strictEqual(results[0].data.id, results[1].data.id);
    assert.strictEqual(await prisma.reservation.count({ where: { tutorId: tutor.id } }), 1);
});

test('mesma chave com outra intenção: 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { pet, token } = await newTutor();
    const { service } = await newHost();
    const key = randomUUID();

    await post(validBody(service, pet), { token, key });
    const res = await post({ ...validBody(service, pet), endDate: day(15) }, { token, key });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.data.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('payload inválido: 400 com todos os campos e nada gravado', async () => {
    const { tutor, token } = await newTutor();

    const res = await post({ startDate: day(-1), endDate: '2026-02-30', notes: 'x'.repeat(1001), tutorId: tutor.id }, { token, key: null });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'VALIDATION_ERROR');
    assert.deepStrictEqual(res.data.details.map((detail) => detail.field), [
        'Idempotency-Key', 'serviceId', 'petId', 'startDate', 'endDate', 'notes', 'tutorId',
    ]);
    assert.strictEqual(await prisma.reservation.count({ where: { tutorId: tutor.id } }), 0);
});

test('fim igual ou antes do início: 400 em endDate', async () => {
    const { pet, token } = await newTutor();
    const { service } = await newHost();

    const res = await post({ ...validBody(service, pet), endDate: day(10) }, { token });

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data.details, [{ field: 'endDate', message: 'deve ser depois de startDate' }]);
});

test('pet de outro Tutor ou inativo: 400 em petId, como se não existisse', async () => {
    const { token } = await newTutor();
    const other = await newTutor();
    const inactive = await newTutor({ active: false });
    const { service } = await newHost();

    for (const pet of [other.pet, inactive.pet]) {
        const res = await post(validBody(service, pet), { token: pet === inactive.pet ? inactive.token : token });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.data.details, [{ field: 'petId', message: 'pet não encontrado' }]);
    }
});

test('serviço inativo ou de Host não elegível: 400 em serviceId', async () => {
    const { pet, token } = await newTutor();
    const inactiveService = await newHost({}, { active: false });
    const pending = await newHost({ validationStatus: 'pending' });

    for (const { service } of [inactiveService, pending]) {
        const res = await post(validBody(service, pet), { token });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.data.details, [{ field: 'serviceId', message: 'serviço não encontrado ou indisponível' }]);
    }
});

test('pet que o Host não aceita: 400 em petId; lista vazia aceita tudo', async () => {
    const { pet, token } = await newTutor();
    const onlyCats = await newHost({ acceptedSpecies: ['cat'], acceptedSizes: ['small'], acceptedBreeds: ['Siamês'] });
    const noRestriction = await newHost();

    const refused = await post(validBody(onlyCats.service, pet), { token });
    const accepted = await post(validBody(noRestriction.service, pet), { token });

    assert.strictEqual(refused.status, 400);
    assert.deepStrictEqual(refused.data.details.map((detail) => detail.message), [
        'espécie não aceita pelo Host', 'porte não aceito pelo Host', 'raça não aceita pelo Host',
    ]);
    assert.strictEqual(accepted.status, 201);
});

test('período com dia bloqueado pelo Host: 409 PERIOD_UNAVAILABLE; o dia da saída não conta', async () => {
    const { tutor, pet, token } = await newTutor();
    const { provider, service } = await newHost();
    await prisma.providerBlockedDate.create({ data: { providerId: provider.id, date: new Date(day(12)) } });

    const blocked = await post(validBody(service, pet), { token });
    const checkoutOnBlockedDay = await post({ ...validBody(service, pet), startDate: day(8), endDate: day(12) }, { token });

    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.data.code, 'PERIOD_UNAVAILABLE');
    assert.strictEqual(checkoutOnBlockedDay.status, 201);
    assert.strictEqual(await prisma.reservation.count({ where: { tutorId: tutor.id } }), 1);
});
