import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';

test('check-out usa a taxa da solicitação, conclui uma vez e reverte falha de lançamento', { skip: !process.env.CHECK_OUT_TEST_DATABASE_URL }, async (t) => {
    const url = new URL(process.env.CHECK_OUT_TEST_DATABASE_URL);
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        && /^checkout_545_test_\w+$/.test(url.searchParams.get('schema') ?? ''), 'Use um schema local descartável para o check-out.');
    process.env.DATABASE_URL = url.href;
    const { prisma } = await import('../../src/lib/prisma.js');
    t.after(() => prisma.$disconnect());
    assert.equal(await prisma.user.count(), 0, 'O teste exige um schema vazio.');
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    process.env.JWT_PUBLIC_KEY = await exportSPKI(publicKey);
    const { default: app } = await import('../../src/app.js');
    const server = app.listen(0);
    await once(server, 'listening');
    t.after(() => server.close());
    const base = `http://localhost:${server.address().port}`;

    async function user(data = {}) {
        const authUserId = randomUUID();
        return prisma.user.create({ data: { authUserId, email: `${authUserId}@example.test`, name: 'Teste check-out', ...data } });
    }
    async function authHeaders(owner) {
        const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject(owner.authUserId)
            .setIssuer('hospetse-auth-service').setAudience('hospetse-backend').setExpirationTime('5m').sign(privateKey);
        return { Authorization: `Bearer ${token}` };
    }
    async function host() {
        const owner = await user();
        const provider = await prisma.provider.create({
            data: {
                userId: owner.id, name: 'Host teste', providerType: 'hotel', status: 'active', validationStatus: 'approved',
                services: { create: { name: 'Diária', price: 123.45 } },
            },
            include: { services: true },
        });
        return { provider, headers: await authHeaders(owner) };
    }
    const owner = await host();
    const other = await host();
    const tutorUser = await user({ status: 'active', profileStatus: 'complete' });
    const address = { zipCode: '87000000', street: 'Rua de Teste', number: '12', complement: null, neighborhood: 'Centro', city: 'Maringá', state: 'PR' };
    const tutor = await prisma.tutor.create({
        data: {
            user: { connect: { id: tutorUser.id } }, name: 'Tutor teste', phone: '11900000001', address: { create: address },
        },
    });
    const pet = await prisma.pet.create({ data: { tutorId: tutor.id, petName: 'Pet teste', petSpecies: 'dog' } });
    async function fixture(platformFeeAmount, paid = true) {
        const row = await prisma.reservation.create({ data: {
            tutorId: tutor.id, petId: pet.id, serviceId: owner.provider.services[0].id,
            status: 'checked_in', totalValue: 100, platformFeeAmount, checkedInAt: new Date(),
            startDate: new Date('2026-11-20'), endDate: new Date('2026-11-21'),
        } });
        const payment = paid ? await prisma.paymentTransaction.create({ data: {
            reservationId: row.id, type: 'payment', status: 'approved', value: 100,
        } }) : null;
        return { row, payment };
    }
    const checkOut = (id, host = owner) => fetch(base + `/api/v1/reservations/${id}/check-out`, { method: 'PATCH', headers: host.headers });
    const list = async () => (await fetch(base + '/api/v1/me/host/reservations?status=checked_in', { headers: owner.headers })).json();
    const entries = (id) => prisma.financialEntry.findMany({ where: { reservationId: id, type: 'host_net' } });
    const notices = () => prisma.notification.findMany({ where: { userId: tutorUser.id, type: 'reservation_checked_out' } });

    const tutorHeaders = await authHeaders(tutorUser);
    const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    const requestReservation = (offset, key = randomUUID()) => fetch(base + '/api/v1/reservations', {
        method: 'POST',
        headers: { ...tutorHeaders, 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ serviceId: owner.provider.services[0].id, petId: pet.id, startDate: day(offset), endDate: day(offset + 1) }),
    });
    delete process.env.RESERVATION_PLATFORM_FEE_PERCENT;
    const key = randomUUID();
    const first = await requestReservation(0, key);
    assert.equal(first.status, 201);
    const { id, totalValue } = await first.json();
    assert.equal(totalValue, 123.45);

    process.env.RESERVATION_PLATFORM_FEE_PERCENT = '101';
    assert.equal((await requestReservation(2)).status, 500);
    assert.equal(await prisma.reservation.count(), 1);
    process.env.RESERVATION_PLATFORM_FEE_PERCENT = '15.5';
    const replay = await requestReservation(0, key);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).id, id);
    const second = await requestReservation(2);
    assert.equal(second.status, 201);
    const { id: secondId } = await second.json();
    const secondRow = await prisma.reservation.findUniqueOrThrow({ where: { id: secondId } });
    assert.equal(secondRow.platformFeeAmount.toFixed(2), '19.13');

    const row = await prisma.reservation.update({
        where: { id },
        data: { status: 'accepted', transactions: { create: { type: 'payment', status: 'approved', value: totalValue } } },
    });
    assert.equal(row.platformFeeAmount.toFixed(2), '12.35');

    await t.test('reserva aceita e paga, mas sem check-in, permanece aceita sem lançar o líquido', async () => {
        const response = await checkOut(id);
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, 'RESERVATION_NOT_IN_PROGRESS');
        const stored = await prisma.reservation.findUniqueOrThrow({ where: { id } });
        assert.equal(stored.status, 'accepted');
        assert.equal(stored.checkedOutAt, null);
        assert.deepEqual(await entries(id), []);
        assert.deepEqual(await notices(), []);
    });

    const checkIn = await fetch(base + `/api/v1/reservations/${id}/check-in`, { method: 'PATCH', headers: owner.headers });
    assert.equal(checkIn.status, 200);
    const { items } = await list();
    assert.deepEqual(items[0].tutor, { name: tutor.name, phone: tutor.phone, address });
    assert.equal((await checkOut(row.id, other)).status, 404);
    const startedAt = Date.now();
    const attempts = await Promise.all([checkOut(row.id), checkOut(row.id)]);
    assert.deepEqual(attempts.map(res => res.status).sort(), [200, 409]);
    const result = await attempts.find(res => res.ok).json();
    assert.ok(Date.parse(result.checkedOutAt) >= startedAt && Date.parse(result.checkedOutAt) <= Date.now());
    assert.equal((await attempts.find(res => res.status === 409).json()).code, 'RESERVATION_NOT_IN_PROGRESS');

    await t.test('check-out repetido mantém a data e os efeitos da conclusão original', async () => {
        const retry = await checkOut(id);
        assert.equal(retry.status, 409);
        assert.equal((await retry.json()).code, 'RESERVATION_NOT_IN_PROGRESS');
        const stored = await prisma.reservation.findUniqueOrThrow({ where: { id } });
        assert.equal(stored.status, 'completed');
        assert.deepEqual(result, { id, status: 'completed', checkedOutAt: stored.checkedOutAt.toISOString() });
        const ledger = await entries(id);
        assert.equal(ledger.length, 1);
        assert.equal(ledger[0].amount.toFixed(2), '111.10');
        assert.equal(ledger[0].providerId, owner.provider.id);
        assert.equal(ledger[0].tutorId, tutor.id);
        assert.deepEqual((await notices()).map(({ content }) => JSON.parse(content)), [{ reservationId: id }]);
    });
    assert.equal((await list()).items.length, 0);

    for (const [fee, paid, code] of [[null, true, 'PLATFORM_FEE_UNAVAILABLE'], [0, false, 'APPROVED_PAYMENT_REQUIRED']]) {
        const { row: blocked } = await fixture(fee, paid);
        const response = await checkOut(blocked.id);
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, code);
        assert.equal((await prisma.reservation.findUniqueOrThrow({ where: { id: blocked.id } })).status, 'checked_in');
        assert.equal((await entries(blocked.id)).length, 0);
    }

    const { row: conflicting, payment } = await fixture(10);
    await prisma.financialEntry.create({ data: {
        transactionId: payment.id, reservationId: conflicting.id, tutorId: tutor.id, providerId: owner.provider.id,
        type: 'host_net', amount: 90, status: 'approved',
    } });
    assert.equal((await checkOut(conflicting.id)).status, 500);
    const unchanged = await prisma.reservation.findUniqueOrThrow({ where: { id: conflicting.id } });
    assert.equal(unchanged.status, 'checked_in');
    assert.equal(unchanged.checkedOutAt, null);
    assert.equal((await entries(conflicting.id)).length, 1);
    assert.deepEqual((await notices()).map(({ content }) => JSON.parse(content)), [{ reservationId: id }]);
});
