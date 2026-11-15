import { IDEMPOTENCY_KEY_MAX } from './payment-intent.service.js';

// Mesmo formato da Idempotency-Key da solicitação (#494): um UUID gerado pelo App serve
const IDEMPOTENCY_KEY = new RegExp(`^[\\w-]{1,${IDEMPOTENCY_KEY_MAX}}$`);
// Token do cartão criado pelo SDK do Stripe no App. O número e o CVV nunca passam pelo back-end
const PAYMENT_METHOD_TOKEN = /^pm_[A-Za-z0-9_]{1,250}$/;

// Pagamento da contratação (POST /api/v1/contracts/:id/payment, #530), sem banco.
// Body estrito: só o token. Qualquer outro campo (cardNumber, cvv...) é recusado pelo nome, sem ecoar nem logar o valor.
// Devolve todos os erros de uma vez em details; sem erro, os dados no formato do service.
export function parseContractPayment(headers, body) {
    const details = [];
    const invalid = (field, message) => details.push({ field, message });

    const idempotencyKey = headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
        invalid('Idempotency-Key', `header obrigatório: até ${IDEMPOTENCY_KEY_MAX} letras, números, - ou _`);
    }

    const isObject = body !== null && typeof body === 'object' && !Array.isArray(body);
    const { paymentMethodToken, ...extra } = isObject ? body : {};
    if (typeof paymentMethodToken !== 'string' || !PAYMENT_METHOD_TOKEN.test(paymentMethodToken)) {
        invalid('paymentMethodToken', 'token do cartão gerado pelo Stripe (pm_...)');
    }
    for (const field of Object.keys(extra)) invalid(field, 'não faz parte do contrato');

    if (details.length) return { details };
    return { details, payment: { idempotencyKey, paymentMethodToken } };
}
