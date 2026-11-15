// POST /webhooks/stripe e registro financeiro (HSP-PBI-073-TSK-02 #528) contra o PostgreSQL real, com o FakePaymentGateway.
// Exige DATABASE_URL. Cria USERs (e-mail it-...@exemplo.com), Tutor, pet, Host, serviço, contratações e pagamentos de teste.
// Os lançamentos são só de inserção, e o banco não deixa apagar o que tem lançamento: os dados deste arquivo ficam no banco.
// Rode num banco descartável (gotcha do .env apontando para produção).
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { prisma } from '../../src/lib/prisma.js';
import { FakePaymentGateway } from '../../src/payments/fake-payment-gateway.js';
import { usePaymentGateway } from '../../src/payments/payment-gateway.js';
import { createPaymentIntentService } from '../../src/payments/payment-intent.service.js';
import { recordCorrectionService } from '../../src/payments/ledger.service.js';

try {
    process.loadEnvFile();
} catch {
    // sem .env: a verificação abaixo falha com mensagem clara
}
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL ausente: configure o .env para rodar os testes de integração');
}

const gateway = new FakePaymentGateway();
usePaymentGateway(gateway);

const { default: app } = await import('../../src/app.js');
const server = app.listen(0);
await once(server, 'listening');
const http = axios.create({ baseURL: `http://localhost:${server.address().port}`, validateStatus: () => true });

after(async () => {
    server.close();
    await prisma.$disconnect();
});

async function newUser() {
    const authUserId = randomUUID();
    return prisma.user.create({ data: { authUserId, email: `it-${authUserId}@exemplo.com`, name: 'Teste Integração' } });
}

const tutorUser = await newUser();
const tutor = await prisma.tutor.create({ data: { userId: tutorUser.id, name: tutorUser.name } });
const pet = await prisma.pet.create({ data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog' } });
const hostUser = await newUser();
const provider = await prisma.provider.create({
    data: { userId: hostUser.id, providerType: 'hotel', name: 'Hotelzinho de Teste', services: { create: [{ name: 'Diária', price: 120.05 }] } },
    include: { services: true },
});

function newReservation() {
    return prisma.reservation.create({
        data: { petId: pet.id, tutorId: tutor.id, serviceId: provider.services[0].id, status: 'awaiting_payment', startDate: new Date('2030-01-10'), endDate: new Date('2030-01-12'), totalValue: 240.1 },
    });
}

// Contratação aguardando pagamento, com uma tentativa já enviada ao gateway (#527)
async function newPayment(token = 'pm_card_threeDSecure') {
    const reservation = await newReservation();
    const transaction = await createPaymentIntentService({ reservation, paymentMethodToken: token, idempotencyKey: randomUUID() });
    return { reservation, transaction };
}

// Evento no formato do Stripe, assinado com o segredo do fake
function stripeEvent(type, transaction, extra = {}) {
    return { id: `evt_${randomUUID()}`, type, data: { object: { id: transaction.gatewayPaymentId, metadata: { transactionId: transaction.id }, ...extra } } };
}

function sendWebhook(event, signature) {
    const body = Buffer.from(JSON.stringify(event));
    return http.post('/webhooks/stripe', body, {
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature ?? FakePaymentGateway.sign(body) },
        transformRequest: [(data) => data],
    });
}

const entriesOf = (transactionId) => prisma.financialEntry.findMany({ where: { transactionId } });
const notificationsOf = (reservationId) =>
    prisma.notification.findMany({ where: { userId: hostUser.id, type: 'payment_approved', content: { contains: reservationId } } });

test('retorno aprovado confirma a transação, grava um lançamento e confirma a contratação', async () => {
    const { reservation, transaction } = await newPayment();
    assert.strictEqual(transaction.status, 'pending');

    const res = await sendWebhook(stripeEvent('payment_intent.succeeded', transaction));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, { received: true });

    assert.strictEqual((await prisma.paymentTransaction.findUnique({ where: { id: transaction.id } })).status, 'approved');
    const [entry, ...others] = await entriesOf(transaction.id);
    assert.strictEqual(others.length, 0);
    assert.strictEqual(entry.type, 'payment');
    assert.strictEqual(entry.status, 'approved');
    assert.strictEqual(entry.amount.toString(), '240.1');
    assert.strictEqual(entry.tutorId, tutor.id);
    assert.strictEqual(entry.providerId, provider.id);
    assert.strictEqual((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, 'accepted');
    assert.strictEqual((await notificationsOf(reservation.id)).length, 1);
});

test('resposta do gateway aprovou antes do webhook: ainda grava o lançamento e confirma a contratação', async () => {
    const { reservation, transaction } = await newPayment('pm_card_visa');
    assert.strictEqual(transaction.status, 'approved');
    assert.strictEqual((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, 'awaiting_payment');

    assert.strictEqual((await sendWebhook(stripeEvent('payment_intent.succeeded', transaction))).status, 200);
    assert.strictEqual((await entriesOf(transaction.id)).length, 1);
    assert.strictEqual((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, 'accepted');
});

test('retorno recusado marca rejected e mantém awaiting_payment', async () => {
    const { reservation, transaction } = await newPayment();
    const event = stripeEvent('payment_intent.payment_failed', transaction, { last_payment_error: { code: 'card_declined' } });

    assert.strictEqual((await sendWebhook(event)).status, 200);
    const saved = await prisma.paymentTransaction.findUnique({ where: { id: transaction.id } });
    assert.strictEqual(saved.status, 'rejected');
    assert.strictEqual(saved.failureCode, 'card_declined');
    const [entry] = await entriesOf(transaction.id);
    assert.strictEqual(entry.status, 'rejected');
    assert.strictEqual((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, 'awaiting_payment');
    assert.strictEqual((await notificationsOf(reservation.id)).length, 0);
});

test('assinatura ausente ou inválida responde 400 e não altera nada', async () => {
    const { reservation, transaction } = await newPayment();
    const event = stripeEvent('payment_intent.succeeded', transaction);

    for (const signature of ['assinatura-falsa', '']) {
        const res = await sendWebhook(event, signature);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.data.code, 'WEBHOOK_SIGNATURE_INVALID');
    }
    // Sem Content-Type JSON o corpo nem é lido: também 400
    const plain = await http.post('/webhooks/stripe', JSON.stringify(event), { headers: { 'Content-Type': 'text/plain' } });
    assert.strictEqual(plain.status, 400);

    assert.strictEqual((await prisma.paymentTransaction.findUnique({ where: { id: transaction.id } })).status, 'pending');
    assert.strictEqual((await entriesOf(transaction.id)).length, 0);
    assert.strictEqual((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, 'awaiting_payment');
    assert.strictEqual(await prisma.paymentEvent.count({ where: { id: event.id } }), 0);
});

test('mesmo evento duas vezes não gera segundo lançamento nem segunda notificação', async () => {
    const { reservation, transaction } = await newPayment();
    const event = stripeEvent('payment_intent.succeeded', transaction);

    assert.strictEqual((await sendWebhook(event)).status, 200);
    assert.strictEqual((await sendWebhook(event)).status, 200);
    // Outro aviso de sucesso do mesmo pagamento (outro evt_) também não duplica
    assert.strictEqual((await sendWebhook(stripeEvent('payment_intent.succeeded', transaction))).status, 200);

    assert.strictEqual((await entriesOf(transaction.id)).length, 1);
    assert.strictEqual((await notificationsOf(reservation.id)).length, 1);
});

test('evento de tipo ignorado ou de pagamento desconhecido: 200, registrado e sem efeito', async () => {
    const { transaction } = await newPayment();
    const ignored = stripeEvent('charge.updated', transaction);
    const unknown = { id: `evt_${randomUUID()}`, type: 'payment_intent.succeeded', data: { object: { id: 'pi_de_outro_sistema', metadata: {} } } };

    for (const event of [ignored, unknown]) {
        assert.strictEqual((await sendWebhook(event)).status, 200);
        assert.strictEqual(await prisma.paymentEvent.count({ where: { id: event.id } }), 1);
    }
    assert.strictEqual((await prisma.paymentTransaction.findUnique({ where: { id: transaction.id } })).status, 'pending');
    assert.strictEqual((await entriesOf(transaction.id)).length, 0);
});

test('UPDATE e DELETE em financial_entries são recusados pelo banco', async () => {
    const { transaction } = await newPayment();
    await sendWebhook(stripeEvent('payment_intent.succeeded', transaction));
    const [entry] = await entriesOf(transaction.id);

    await assert.rejects(prisma.financialEntry.update({ where: { id: entry.id }, data: { amount: 0 } }), /só de inserção/);
    await assert.rejects(prisma.financialEntry.delete({ where: { id: entry.id } }), /só de inserção/);
    await assert.rejects(prisma.$executeRaw`UPDATE financial_entries SET amount = 0 WHERE id = ${entry.id}::uuid`, /só de inserção/);
    assert.strictEqual((await prisma.financialEntry.findUnique({ where: { id: entry.id } })).amount.toString(), '240.1');
});

test('correção cria novo lançamento ligado ao original, sem alterar o original', async () => {
    const { transaction } = await newPayment();
    await sendWebhook(stripeEvent('payment_intent.succeeded', transaction));
    const [original] = await entriesOf(transaction.id);

    const correction = await recordCorrectionService(original.id, { amount: -10.05, reason: ' Desconto combinado com o Tutor ' });
    assert.strictEqual(correction.type, 'correction');
    assert.strictEqual(correction.originalEntryId, original.id);
    assert.strictEqual(correction.amount.toString(), '-10.05');
    assert.strictEqual(correction.reason, 'Desconto combinado com o Tutor');
    assert.strictEqual(correction.tutorId, original.tutorId);
    assert.deepStrictEqual(await prisma.financialEntry.findUnique({ where: { id: original.id } }), original);

    await assert.rejects(recordCorrectionService(original.id, { amount: 0, reason: '' }), (error) => {
        assert.strictEqual(error.statusCode, 400);
        assert.deepStrictEqual(error.details.map((d) => d.field), ['amount', 'reason']);
        return true;
    });
    await assert.rejects(recordCorrectionService(original.id, { amount: 1.001, reason: 'x' }), { statusCode: 400 });
    await assert.rejects(recordCorrectionService(randomUUID(), { amount: 1, reason: 'x' }), { statusCode: 404 });
});

// Ponta a ponta (#529): o caso mais perigoso para cobrança dupla, com a #527 e a #528 juntas
test('timeout, webhook aprova antes do reenvio, e o reenvio com a mesma chave não chama o gateway', async () => {
    const reservation = await newReservation();
    const idempotencyKey = randomUUID();
    const pay = () => createPaymentIntentService({ reservation, paymentMethodToken: 'pm_timeout', idempotencyKey });

    // 1. O Stripe cobra, mas a resposta se perde: a transação fica pendente, sem o id do Stripe
    await assert.rejects(pay(), { statusCode: 503, code: 'PAYMENT_GATEWAY_UNAVAILABLE' });
    const pending = await prisma.paymentTransaction.findFirst({ where: { reservationId: reservation.id } });
    assert.strictEqual(pending.status, 'pending');
    assert.strictEqual(pending.gatewayPaymentId, null);

    // 2. O webhook chega antes do reenvio: acha a transação pelo metadata e confirma tudo
    const charge = gateway.charges.get(pending.id);
    const event = { id: `evt_${randomUUID()}`, type: 'payment_intent.succeeded', data: { object: { id: charge.gatewayId, metadata: { transactionId: pending.id } } } };
    assert.strictEqual((await sendWebhook(event)).status, 200);
    assert.strictEqual((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, 'accepted');

    // 3. A Ana toca de novo com a mesma chave: recebe a tentativa aprovada, sem nova chamada ao gateway
    const callsBefore = gateway.calls.length;
    const retry = await pay();
    assert.strictEqual(retry.id, pending.id);
    assert.strictEqual(retry.status, 'approved');
    assert.strictEqual(retry.gatewayPaymentId, charge.gatewayId);
    assert.strictEqual(gateway.calls.length, callsBefore);

    // Uma tentativa, uma cobrança, um lançamento e uma notificação
    assert.strictEqual(await prisma.paymentTransaction.count({ where: { reservationId: reservation.id } }), 1);
    assert.strictEqual(gateway.calls.filter((call) => call.idempotencyKey === pending.id).length, 1);
    assert.strictEqual((await entriesOf(pending.id)).length, 1);
    assert.strictEqual((await notificationsOf(reservation.id)).length, 1);
});
