import { AppError } from '../lib/app-error.js';
import { getPaymentGateway } from './payment-gateway.js';
import { handlePaymentEventService } from './webhook.service.js';

// POST /webhooks/stripe (HSP-PBI-073-TSK-02 #528). Sem JWT: quem chama é o Stripe, autenticado pela assinatura.
// req.body é o corpo bruto (express.raw): a assinatura é calculada byte a byte, e um JSON reconvertido não confere.
// 200 também para evento repetido ou ignorado; 500 faz o Stripe reenviar mais tarde.
export async function stripeWebhookController(req, res) {
    try {
        const event = getPaymentGateway().parseWebhook(req.body, req.headers['stripe-signature']);
        const outcome = await handlePaymentEventService(event);
        // Só o tipo e o resultado: o evento traz dados do pagamento
        console.log(`webhook stripe: ${event.type} → ${outcome}`);
        return res.status(200).json({ received: true });
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ code: error.code, message: error.message });
        }
        console.log(`webhook stripe: erro ${error.name}`);
        return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
    }
}
