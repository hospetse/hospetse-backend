// POST /api/v1/contracts/:id/payment (HSP-PBI-067-TSK-01 #530) contra o PostgreSQL real, com o FakePaymentGateway (sem rede).
// Exige DATABASE_URL. Cria USERs (e-mail it-...@exemplo.com), Tutores, pets, Host, serviço, contratações e tentativas de teste,
// e remove tudo o que criou no after. Sem webhook aqui: nenhum lançamento é gravado, então tudo pode ser apagado.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { prisma } from '../../src/lib/prisma.js';
import { FakePaymentGateway } from '../../src/payments/fake-payment-gateway.js';
import { usePaymentGateway } from '../../src/payments/payment-gateway.js';

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

const gateway = new FakePaymentGateway();
usePaymentGateway(gateway);

const { default: app } = await import('../../src/app.js');
const server = app.listen(0);
await once(server, 'listening');
const http = axios.create({ baseURL: `http://localhost:${server.address().port}`, validateStatus: () => true });

const userIds = [];
const tutorIds = [];
const reservationIds = [];
let provider;
// O teste ponta a ponta grava lançamento (#528), que é só de inserção: nada ligado a ele pode ser apagado.
// Ele usa Tutor e Host próprios, e o que estiver aqui fica no banco (rode em banco descartável)
const kept = new Set();

after(async () => {
    server.close();
    const drop = (ids) => ids.filter((id) => !kept.has(id));
    await prisma.paymentTransaction.deleteMany({ where: { reservationId: { in: drop(reservationIds) } } });
    await prisma.reservation.deleteMany({ where: { id: { in: drop(reservationIds) } } });
    await prisma.pet.deleteMany({ where: { tutorId: { in: drop(tutorIds) } } });
    await prisma.tutor.deleteMany({ where: { id: { in: drop(tutorIds) } } });
    await prisma.service.deleteMany({ where: { providerId: provider.id } });
    await prisma.provider.deleteMany({ where: { id: provider.id } });
    await prisma.user.deleteMany({ where: { id: { in: drop(userIds) } } });
    await prisma.$disconnect();
});

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

// Tutor apto a contratar (conta ativa e perfil completo), com um pet
async function newTutor(userData = { status: 'active', profileStatus: 'complete' }) {
    const { user, token } = await newUser(userData);
    const tutor = await prisma.tutor.create({ data: { userId: user.id, name: user.name } });
    tutorIds.push(tutor.id);
    const pet = await prisma.pet.create({ data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog' } });
    return { tutor, pet, token };
}

const { user: hostUser } = await newUser();
provider = await prisma.provider.create({
    data: { userId: hostUser.id, providerType: 'hotel', name: 'Hotelzinho de Teste', services: { create: [{ name: 'Diária', price: 120.05 }] } },
    include: { services: true },
});

async function newReservation({ tutor, pet }, status = 'awaiting_payment', serviceId = provider.services[0].id) {
    const reservation = await prisma.reservation.create({
        data: { petId: pet.id, tutorId: tutor.id, serviceId, status, startDate: new Date('2030-01-10'), endDate: new Date('2030-01-12'), totalValue: 240.1 },
    });
    reservationIds.push(reservation.id);
    return reservation;
}

function pay(token, reservationId, body, idempotencyKey = randomUUID()) {
    const headers = { Authorization: `Bearer ${token}`, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) };
    return http.post(`/api/v1/contracts/${reservationId}/payment`, body, { headers });
}

test('paga a contratação aguardando pagamento com o valor do snapshot: 202 aprovado', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana);
    const calls = gateway.calls.length;

    const res = await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_visa' });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.data.status, 'approved');
    assert.strictEqual(res.data.amount, 240.1);
    assert.strictEqual(res.data.failureCode, null);
    // A contratação só é confirmada pelo webhook (#528)
    assert.strictEqual(res.data.reservationStatus, 'awaiting_payment');
    assert.strictEqual(gateway.calls.length, calls + 1);
    assert.strictEqual(gateway.calls.at(-1).amountCents, 24010);
});

test('mesma chave duas vezes devolve a mesma tentativa sem nova cobrança', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana);
    const key = randomUUID();

    const first = await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_visa' }, key);
    const calls = gateway.calls.length;
    const again = await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_visa' }, key);
    assert.strictEqual(again.status, 202);
    assert.strictEqual(again.data.transactionId, first.data.transactionId);
    assert.strictEqual(gateway.calls.length, calls);
});

test('body com dados do cartão é recusado sem cobrar nem gravar', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana);
    const calls = gateway.calls.length;

    const res = await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_visa', cardNumber: '4242424242424242', cvv: '123', amount: 1 });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data.details.map((d) => d.field), ['cardNumber', 'cvv', 'amount']);
    // O valor recusado não volta na resposta
    assert.ok(!JSON.stringify(res.data).includes('4242'));
    assert.strictEqual(gateway.calls.length, calls);
    assert.strictEqual(await prisma.paymentTransaction.count({ where: { reservationId: reservation.id } }), 0);
});

test('sem Idempotency-Key ou com token fora do formato: 400 com os dois campos', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana);
    const res = await pay(ana.token, reservation.id, { paymentMethodToken: '4242424242424242' }, null);
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data.details.map((d) => d.field), ['Idempotency-Key', 'paymentMethodToken']);
});

test('contratação fora de aguardando pagamento: 409 sem chamar o gateway', async () => {
    const ana = await newTutor();
    const calls = gateway.calls.length;
    for (const status of ['requested', 'accepted', 'rejected', 'cancelled']) {
        const reservation = await newReservation(ana, status);
        const res = await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_visa' });
        assert.strictEqual(res.status, 409, status);
        assert.strictEqual(res.data.code, 'RESERVATION_NOT_PAYABLE');
    }
    assert.strictEqual(gateway.calls.length, calls);
});

test('contratação de outro Tutor, inexistente ou com id inválido: 404 igual', async () => {
    const ana = await newTutor();
    const beto = await newTutor();
    const reservationOfBeto = await newReservation(beto);
    const calls = gateway.calls.length;
    for (const id of [reservationOfBeto.id, randomUUID(), 'abc']) {
        const res = await pay(ana.token, id, { paymentMethodToken: 'pm_card_visa' });
        assert.strictEqual(res.status, 404, id);
        assert.strictEqual(res.data.code, 'NOT_FOUND');
    }
    // Ninguém é cobrado, e a contratação do Beto continua sem pagamento
    assert.strictEqual(gateway.calls.length, calls);
    assert.strictEqual(await prisma.paymentTransaction.count({ where: { reservationId: reservationOfBeto.id } }), 0);
});

test('recusa mantém aguardando pagamento, e outro cartão com outra chave pode pagar', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana);

    const declined = await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_chargeDeclined' });
    assert.strictEqual(declined.status, 202);
    assert.strictEqual(declined.data.status, 'rejected');
    assert.strictEqual(declined.data.failureCode, 'card_declined');
    assert.strictEqual(declined.data.reservationStatus, 'awaiting_payment');

    const retry = await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_visa' });
    assert.strictEqual(retry.data.status, 'approved');
    assert.notStrictEqual(retry.data.transactionId, declined.data.transactionId);
});

test('pagamento em andamento com outra chave: 409 PAYMENT_IN_PROGRESS', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana);
    await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_threeDSecure' });

    const res = await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_visa' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.data.code, 'PAYMENT_IN_PROGRESS');
});

test('perfil incompleto não paga: 403 PROFILE_INCOMPLETE', async () => {
    const ana = await newTutor({ status: 'active', profileStatus: 'incomplete' });
    const reservation = await newReservation(ana);
    const res = await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_visa' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.data.code, 'PROFILE_INCOMPLETE');
});

// Comprovante (GET): o App consulta depois do 202, até a tentativa sair de pending e a contratação ser confirmada
const getPayment = (token, reservationId) => http.get(`/api/v1/contracts/${reservationId}/payment`, { headers: { Authorization: `Bearer ${token}` } });

test('comprovante devolve a tentativa mais recente e o status atual da contratação', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana);
    await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_chargeDeclined' });
    const approved = await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_visa' });

    const res = await getPayment(ana.token, reservation.id);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.transactionId, approved.data.transactionId);
    assert.strictEqual(res.data.status, 'approved');
    assert.strictEqual(res.data.amount, 240.1);
    assert.ok(res.data.createdAt);
    assert.strictEqual(res.data.reservationStatus, 'awaiting_payment');
    // Nenhum dado do cartão nem o token na resposta
    assert.ok(!JSON.stringify(res.data).includes('pm_'));

    // Depois do webhook (#528), a mesma consulta mostra a contratação confirmada
    await prisma.reservation.update({ where: { id: reservation.id }, data: { status: 'accepted' } });
    assert.strictEqual((await getPayment(ana.token, reservation.id)).data.reservationStatus, 'accepted');
});

test('comprovante: sem pagamento, de outro Tutor ou id inválido responde 404', async () => {
    const ana = await newTutor();
    const beto = await newTutor();
    const unpaid = await newReservation(ana);
    const ofBeto = await newReservation(beto);
    await pay(beto.token, ofBeto.id, { paymentMethodToken: 'pm_card_visa' });

    for (const id of [unpaid.id, ofBeto.id, 'abc']) {
        const res = await getPayment(ana.token, id);
        assert.strictEqual(res.status, 404, id);
        assert.strictEqual(res.data.code, 'NOT_FOUND');
    }
});

test('comprovante continua disponível para perfil que não pode mais contratar', async () => {
    const ana = await newTutor();
    const reservation = await newReservation(ana);
    await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_visa' });
    await prisma.user.update({ where: { id: (await prisma.tutor.findUnique({ where: { id: ana.tutor.id } })).userId }, data: { status: 'suspended' } });

    assert.strictEqual((await getPayment(ana.token, reservation.id)).status, 200);
    assert.strictEqual((await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_visa' })).status, 403);
});

// #532: o fluxo inteiro da Ana, com o retorno do gateway chegando pelo webhook assinado (HMAC do fake)
test('pagamento aprovado confirma a contratação depois do retorno do gateway', async () => {
    const ana = await newTutor();
    const { user: hostUser } = await newUser();
    const host = await prisma.provider.create({
        data: { userId: hostUser.id, providerType: 'hotel', name: 'Hotel do Fluxo Completo', services: { create: [{ name: 'Diária', price: 120.05 }] } },
        include: { services: true },
    });
    const reservation = await newReservation(ana, 'awaiting_payment', host.services[0].id);
    for (const id of [reservation.id, ana.tutor.id, ana.tutor.userId, hostUser.id]) kept.add(id);

    // 1. A Ana paga: 3D Secure deixa a tentativa pendente, e a contratação ainda aguarda
    const paid = await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_threeDSecure' });
    assert.strictEqual(paid.status, 202);
    assert.strictEqual(paid.data.status, 'pending');
    assert.strictEqual(paid.data.reservationStatus, 'awaiting_payment');

    // 2. O Stripe avisa pelo webhook, com assinatura
    const transaction = await prisma.paymentTransaction.findUnique({ where: { id: paid.data.transactionId } });
    const event = { id: `evt_${randomUUID()}`, type: 'payment_intent.succeeded', data: { object: { id: transaction.gatewayPaymentId, metadata: { transactionId: transaction.id } } } };
    const body = Buffer.from(JSON.stringify(event));
    const webhook = await http.post('/webhooks/stripe', body, {
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': FakePaymentGateway.sign(body) },
        transformRequest: [(data) => data],
    });
    assert.strictEqual(webhook.status, 200);

    // 3. O App consulta o comprovante: pago e contratação confirmada
    const receipt = await http.get(`/api/v1/contracts/${reservation.id}/payment`, { headers: { Authorization: `Bearer ${ana.token}` } });
    assert.strictEqual(receipt.data.transactionId, paid.data.transactionId);
    assert.strictEqual(receipt.data.status, 'approved');
    assert.strictEqual(receipt.data.reservationStatus, 'accepted');

    // Um lançamento, e o prestador avisado uma vez
    assert.strictEqual(await prisma.financialEntry.count({ where: { transactionId: transaction.id } }), 1);
    assert.strictEqual(await prisma.notification.count({ where: { userId: hostUser.id, type: 'payment_approved' } }), 1);

    // 4. Pagar de novo com outra chave: a contratação já não aguarda pagamento
    const again = await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_visa' });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.data.code, 'RESERVATION_NOT_PAYABLE');
});

test('valor cobrado é o snapshot da contratação, mesmo com o preço do serviço alterado depois', async () => {
    const ana = await newTutor();
    const service = await prisma.service.create({ data: { providerId: provider.id, name: 'Diária com reajuste', price: 120.05 } });
    const reservation = await newReservation(ana, 'awaiting_payment', service.id);
    // O Host reajusta a diária depois da solicitação
    await prisma.service.update({ where: { id: service.id }, data: { price: 999.99 } });

    const res = await pay(ana.token, reservation.id, { paymentMethodToken: 'pm_card_visa' });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.data.amount, 240.1);
    assert.strictEqual(gateway.calls.at(-1).amountCents, 24010);
});
