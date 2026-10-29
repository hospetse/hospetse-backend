import { assertCanContract } from '../users/profile-policy.js';

// Início de uma contratação (TSK-05 #263). Confere a regra de novo: vale mesmo se a rota esquecer o middleware.
// shortcut: não cria nada no banco; a #494 (solicitação) e as tasks de reserva/checkout trocam pela criação real.
export function startContractService(user) {
    assertCanContract(user);
}
