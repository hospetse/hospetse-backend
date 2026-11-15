import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from '../lib/app-error.js';

export const FAKE_WEBHOOK_SECRET = 'whsec_fake_para_testes';

// Resultado por token, com os nomes dos cartões de teste do Stripe. Token desconhecido aprova
const RESULTS = {
    pm_card_visa: { status: 'approved', failureCode: null },
    pm_card_chargeDeclined: { status: 'rejected', failureCode: 'card_declined' },
    pm_card_threeDSecure: { status: 'pending', failureCode: null },
};

// Gateway de mentira para os testes: mesmos métodos do StripeGateway, sem rede.
// Imita a regra do Stripe: a mesma chave de idempotência nunca cria uma segunda cobrança.
export class FakePaymentGateway {
    constructor() {
        this.calls = [];             // toda chamada recebida, inclusive as repetidas
        this.charges = new Map();    // idempotencyKey → cobrança criada (no máximo uma por chave)
    }

    // Quantas cobranças de verdade foram criadas: é o número que prova "sem cobrança duplicada"
    get chargeCount() {
        return this.charges.size;
    }

    async createPayment(input) {
        this.calls.push(input);
        const saved = this.charges.get(input.idempotencyKey);
        if (saved) return saved;

        // Id único entre fakes: gateway_payment_id é UNIQUE no banco, e cada teste cria o seu fake
        const charge = { gatewayId: `pi_fake_${randomUUID()}`, ...(RESULTS[input.paymentMethodToken] ?? RESULTS.pm_card_visa) };
        // pm_timeout: o Stripe cobra, mas a resposta se perde. Só o reenvio com a mesma chave descobre o resultado
        if (input.paymentMethodToken === 'pm_timeout') {
            this.charges.set(input.idempotencyKey, { ...charge, status: 'approved', failureCode: null });
            throw new AppError('Pagamento indisponível no momento. Tente de novo', 503, 'PAYMENT_GATEWAY_UNAVAILABLE');
        }
        this.charges.set(input.idempotencyKey, charge);
        return charge;
    }

    // Assinatura do teste: HMAC-SHA256 do corpo bruto, como o Stripe faz (sem a parte do horário)
    static sign(rawBody) {
        return createHmac('sha256', FAKE_WEBHOOK_SECRET).update(rawBody).digest('hex');
    }

    parseWebhook(rawBody, signature) {
        const expected = Buffer.from(FakePaymentGateway.sign(rawBody));
        const received = Buffer.from(String(signature ?? ''));
        if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
            throw new AppError('Assinatura do webhook inválida', 400, 'INVALID_SIGNATURE');
        }
        return JSON.parse(rawBody.toString());
    }
}
