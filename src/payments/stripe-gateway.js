import Stripe from 'stripe';
import { AppError } from '../lib/app-error.js';

// O padrão do SDK é esperar 80 s: o App desistiria antes. Curto, e o reenvio com a mesma chave recupera o resultado
const DEFAULT_TIMEOUT_MS = 10000;

// Status do PaymentIntent no Stripe → status da nossa transação. O que não está aqui (processing, requires_action) fica pending
const STATUS = { succeeded: 'approved', requires_payment_method: 'rejected', canceled: 'rejected' };

// Stripe em modo de teste (ADR-016). Único arquivo que importa o SDK: o resto usa getPaymentGateway().
export class StripeGateway {
    // client só nos testes, para não usar a rede
    constructor(env = process.env, client) {
        this.webhookSecret = env.STRIPE_WEBHOOK_SECRET;
        if (client) {
            this.client = client;
            return;
        }
        if (!env.STRIPE_SECRET_KEY) throw unavailable('configuração ausente');
        this.client = new Stripe(env.STRIPE_SECRET_KEY, {
            timeout: Number(env.STRIPE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
            // Repete falha de rede com a mesma chave de idempotência: o Stripe não cobra duas vezes
            maxNetworkRetries: 2,
        });
    }

    // Cria e confirma o PaymentIntent numa chamada só. Devolve { gatewayId, status, failureCode }, nunca dado do cartão.
    async createPayment({ amountCents, currency = 'brl', paymentMethodToken, idempotencyKey, metadata }) {
        try {
            const intent = await this.client.paymentIntents.create(
                {
                    amount: amountCents,
                    currency,
                    payment_method: paymentMethodToken,
                    payment_method_types: ['card'],
                    confirm: true,
                    metadata,
                },
                { idempotencyKey },
            );
            return {
                gatewayId: intent.id,
                status: STATUS[intent.status] ?? 'pending',
                failureCode: intent.last_payment_error?.code ?? null,
            };
        } catch (error) {
            // Recusa do cartão é resposta de negócio, não falha: o PaymentIntent existe e fica registrado como recusado
            if (error.type === 'StripeCardError') {
                return { gatewayId: error.payment_intent?.id ?? null, status: 'rejected', failureCode: error.code ?? 'card_declined' };
            }
            throw unavailable(error.type);
        }
    }

    // Confere a assinatura do webhook (#528) sobre o corpo bruto. Assinatura inválida ou antiga (replay) vira 400.
    parseWebhook(rawBody, signature) {
        try {
            return this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
        } catch (error) {
            console.log(`stripe webhook: ${error.type ?? error.name}`);
            throw new AppError('Assinatura do webhook inválida', 400, 'INVALID_SIGNATURE');
        }
    }
}

// O log leva só o tipo do erro: a mensagem do Stripe pode trazer dados da requisição
function unavailable(type) {
    console.log(`stripe: ${type ?? 'erro desconhecido'}`);
    return new AppError('Pagamento indisponível no momento. Tente de novo', 503, 'PAYMENT_GATEWAY_UNAVAILABLE');
}
