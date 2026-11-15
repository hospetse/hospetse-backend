import { StripeGateway } from './stripe-gateway.js';

// Gateway de pagamento em uso (ADR-016). Só a pasta payments conhece o Stripe: o resto do código pede getPaymentGateway().
let gateway;

// Criado no primeiro uso: quem não paga nada (testes, rotas sem pagamento) não precisa das variáveis STRIPE_*
export function getPaymentGateway() {
    gateway ??= new StripeGateway();
    return gateway;
}

// Os testes trocam pelo FakePaymentGateway, para não usar a rede nem cobrar no sandbox
export function usePaymentGateway(implementation) {
    gateway = implementation;
}
