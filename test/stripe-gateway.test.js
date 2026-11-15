// StripeGateway (#527, ADR-016) com um client falso no lugar do SDK: sem rede e sem chave real.
import { test } from 'node:test';
import assert from 'node:assert';
import { StripeGateway } from '../src/payments/stripe-gateway.js';

const SECRET = 'sk_test_segredo_que_nao_pode_vazar';
const input = { amountCents: 24010, paymentMethodToken: 'pm_card_visa', idempotencyKey: 'tx-1', metadata: { reservationId: 'r-1' } };

// create devolve o PaymentIntent pedido ou lança o erro pedido, e guarda o que recebeu
function fakeClient({ intent, error } = {}) {
    const received = [];
    return {
        received,
        paymentIntents: {
            create: async (params, options) => {
                received.push({ params, options });
                if (error) throw error;
                return intent;
            },
        },
        webhooks: {
            constructEvent: () => {
                throw Object.assign(new Error(`assinatura não confere com ${SECRET}`), { type: 'StripeSignatureVerificationError' });
            },
        },
    };
}

test('envia valor em centavos, token, confirmação e a chave de idempotência', async () => {
    const client = fakeClient({ intent: { id: 'pi_1', status: 'succeeded' } });
    await new StripeGateway({}, client).createPayment(input);

    const [{ params, options }] = client.received;
    assert.deepStrictEqual(params, {
        amount: 24010, currency: 'brl', payment_method: 'pm_card_visa', payment_method_types: ['card'], confirm: true, metadata: { reservationId: 'r-1' },
    });
    assert.deepStrictEqual(options, { idempotencyKey: 'tx-1' });
});

test('traduz o status do Stripe para approved, rejected ou pending', async () => {
    const cases = { succeeded: 'approved', requires_payment_method: 'rejected', canceled: 'rejected', processing: 'pending', requires_action: 'pending' };
    for (const [stripeStatus, expected] of Object.entries(cases)) {
        const client = fakeClient({ intent: { id: 'pi_1', status: stripeStatus } });
        const result = await new StripeGateway({}, client).createPayment(input);
        assert.strictEqual(result.status, expected, stripeStatus);
    }
});

test('cartão recusado vira rejected com o motivo, sem erro', async () => {
    const error = Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined', payment_intent: { id: 'pi_2' } });
    const result = await new StripeGateway({}, fakeClient({ error })).createPayment(input);
    assert.deepStrictEqual(result, { gatewayId: 'pi_2', status: 'rejected', failureCode: 'card_declined' });
});

test('erro de rede vira 503, e o segredo não aparece no erro nem no log', async (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const error = Object.assign(new Error(`falha usando ${SECRET}`), { type: 'StripeConnectionError' });

    await assert.rejects(new StripeGateway({}, fakeClient({ error })).createPayment(input), (thrown) => {
        assert.strictEqual(thrown.statusCode, 503);
        assert.strictEqual(thrown.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
        assert.ok(!thrown.message.includes(SECRET));
        return true;
    });
    const logged = log.mock.calls.flatMap((call) => call.arguments).join(' ');
    assert.ok(logged.includes('StripeConnectionError'));
    assert.ok(!logged.includes(SECRET));
});

test('sem STRIPE_SECRET_KEY: 503 no primeiro uso', (t) => {
    t.mock.method(console, 'log', () => {});
    assert.throws(() => new StripeGateway({}), { statusCode: 503, code: 'PAYMENT_GATEWAY_UNAVAILABLE' });
});

test('webhook com assinatura inválida: 400, sem vazar o segredo no log', (t) => {
    const log = t.mock.method(console, 'log', () => {});
    const gateway = new StripeGateway({ STRIPE_WEBHOOK_SECRET: 'whsec_x' }, fakeClient());
    assert.throws(() => gateway.parseWebhook(Buffer.from('{}'), 'assinatura-falsa'), { statusCode: 400, code: 'INVALID_SIGNATURE' });
    const logged = log.mock.calls.flatMap((call) => call.arguments).join(' ');
    assert.ok(!logged.includes(SECRET));
});
