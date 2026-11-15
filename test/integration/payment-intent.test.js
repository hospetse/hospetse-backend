// Intenção de pagamento idempotente (HSP-PBI-073-TSK-01 #527) contra o PostgreSQL real, com o FakePaymentGateway (sem rede).
// Exige DATABASE_URL. Cria USERs (e-mail it-...@exemplo.com), Tutor, pet, Host, serviço e contratações de teste,
// e remove tudo o que criou no after.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/lib/prisma.js';
import { FakePaymentGateway } from '../../src/payments/fake-payment-gateway.js';
import { usePaymentGateway } from '../../src/payments/payment-gateway.js';
import { createPaymentIntentService } from '../../src/payments/payment-intent.service.js';

try {
    process.loadEnvFile();
} catch {
    // sem .env: a verificação abaixo falha com mensagem clara
}
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL ausente: configure o .env para rodar os testes de integração');
}

const userIds = [];
const reservationIds = [];
let tutor;
let pet;
let service;
let gateway;

beforeEach(() => {
    gateway = new FakePaymentGateway();
    usePaymentGateway(gateway);
});

after(async () => {
    await prisma.paymentTransaction.deleteMany({ where: { reservationId: { in: reservationIds } } });
    await prisma.reservation.deleteMany({ where: { id: { in: reservationIds } } });
    await prisma.pet.deleteMany({ where: { tutorId: tutor.id } });
    await prisma.tutor.deleteMany({ where: { id: tutor.id } });
    await prisma.service.deleteMany({ where: { id: service.id } });
    await prisma.provider.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

async function newUser() {
    const authUserId = randomUUID();
    const user = await prisma.user.create({ data: { authUserId, email: `it-${authUserId}@exemplo.com`, name: 'Teste Integração' } });
    userIds.push(user.id);
    return user;
}

// Tutor, pet e Host com um serviço, uma vez para o arquivo todo
const tutorUser = await newUser();
tutor = await prisma.tutor.create({ data: { userId: tutorUser.id, name: tutorUser.name } });
pet = await prisma.pet.create({ data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog' } });
const hostUser = await newUser();
const provider = await prisma.provider.create({
    data: { userId: hostUser.id, providerType: 'hotel', name: 'Hotelzinho de Teste', services: { create: [{ name: 'Diária', price: 120.05 }] } },
    include: { services: true },
});
service = provider.services[0];

// Uma contratação nova por teste: cada uma começa sem pagamento
async function newReservation() {
    const reservation = await prisma.reservation.create({
        data: { petId: pet.id, tutorId: tutor.id, serviceId: service.id, status: 'awaiting_payment', startDate: new Date('2030-01-10'), endDate: new Date('2030-01-12'), totalValue: 240.1 },
    });
    reservationIds.push(reservation.id);
    return reservation;
}

const pay = (reservation, idempotencyKey, paymentMethodToken = 'pm_card_visa') =>
    createPaymentIntentService({ reservation, paymentMethodToken, idempotencyKey });

test('chave inédita gera uma cobrança com o valor da contratação, em centavos', async () => {
    const reservation = await newReservation();
    const transaction = await pay(reservation, 'k-1');

    assert.strictEqual(transaction.status, 'approved');
    assert.strictEqual(transaction.value.toString(), '240.1');
    assert.match(transaction.gatewayPaymentId, /^pi_fake_/);
    assert.strictEqual(gateway.chargeCount, 1);
    const [call] = gateway.calls;
    assert.strictEqual(call.amountCents, 24010);
    // Ao Stripe vai o id da transação, não a chave do App
    assert.strictEqual(call.idempotencyKey, transaction.id);
    assert.deepStrictEqual(call.metadata, { reservationId: reservation.id, transactionId: transaction.id });
});

test('mesma chave com resultado final não chama o gateway', async () => {
    const reservation = await newReservation();
    const first = await pay(reservation, 'k-1');
    const again = await pay(reservation, 'k-1');

    assert.deepStrictEqual(again, first);
    assert.strictEqual(gateway.calls.length, 1);
    assert.strictEqual(await prisma.paymentTransaction.count({ where: { reservationId: reservation.id } }), 1);
});

test('timeout seguido de reenvio com a mesma chave não cobra duas vezes', async () => {
    const reservation = await newReservation();
    await assert.rejects(pay(reservation, 'k-1', 'pm_timeout'), { statusCode: 503, code: 'PAYMENT_GATEWAY_UNAVAILABLE' });
    const pending = await prisma.paymentTransaction.findFirst({ where: { reservationId: reservation.id } });
    assert.strictEqual(pending.status, 'pending');

    const transaction = await pay(reservation, 'k-1', 'pm_timeout');
    assert.strictEqual(transaction.id, pending.id);
    assert.strictEqual(transaction.status, 'approved');
    assert.strictEqual(gateway.calls.length, 2);
    assert.strictEqual(gateway.chargeCount, 1);
});

test('mesma chave ao mesmo tempo: uma transação e uma cobrança', async () => {
    const reservation = await newReservation();
    const [a, b] = await Promise.all([pay(reservation, 'k-1'), pay(reservation, 'k-1')]);

    assert.strictEqual(a.id, b.id);
    assert.strictEqual(gateway.chargeCount, 1);
    assert.strictEqual(await prisma.paymentTransaction.count({ where: { reservationId: reservation.id } }), 1);
});

test('recusa: fica rejected com o motivo, e outra chave pode tentar de novo', async () => {
    const reservation = await newReservation();
    const declined = await pay(reservation, 'k-1', 'pm_card_chargeDeclined');
    assert.strictEqual(declined.status, 'rejected');
    assert.strictEqual(declined.failureCode, 'card_declined');

    const retry = await pay(reservation, 'k-2');
    assert.strictEqual(retry.status, 'approved');
    assert.notStrictEqual(retry.id, declined.id);
});

test('chave diferente com pagamento pendente ou aprovado: 409 sem nova cobrança', async () => {
    for (const token of ['pm_card_threeDSecure', 'pm_card_visa']) {
        const reservation = await newReservation();
        await pay(reservation, 'k-1', token);
        const calls = gateway.calls.length;

        await assert.rejects(pay(reservation, 'k-2'), { statusCode: 409, code: 'PAYMENT_ALREADY_EXISTS' });
        assert.strictEqual(gateway.calls.length, calls, token);
    }
});

test('mesma chave em contratações diferentes: cada uma tem a sua cobrança', async () => {
    const [first, second] = [await newReservation(), await newReservation()];
    const a = await pay(first, 'k-igual');
    const b = await pay(second, 'k-igual');

    assert.notStrictEqual(a.id, b.id);
    assert.notStrictEqual(a.gatewayPaymentId, b.gatewayPaymentId);
    assert.strictEqual(gateway.chargeCount, 2);
});

test('chave vazia ou maior que 100 caracteres: 400 sem gravar nem chamar o gateway', async () => {
    const reservation = await newReservation();
    for (const key of ['', '   ', 'x'.repeat(101), undefined]) {
        await assert.rejects(pay(reservation, key), { statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    assert.strictEqual(gateway.calls.length, 0);
    assert.strictEqual(await prisma.paymentTransaction.count({ where: { reservationId: reservation.id } }), 0);
});
