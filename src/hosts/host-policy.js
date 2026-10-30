import { AppError } from '../lib/app-error.js';

// Host elegível (#479): hospedagem, ativo e aprovado. Pendente, rejeitado ou inativo não aparece nem recebe solicitação.
// Usado como filtro do Prisma nos detalhes públicos (#479) e na criação da solicitação (#494).
export const ELIGIBLE_HOST = { providerType: 'hotel', status: 'active', validationStatus: 'approved' };

// Papel de Host (#485): o USER tem linha em providers. Vale para qualquer situação do Host, para ele seguir vendo o que já recebeu.
export function requireHost(user) {
    if (!user.provider) {
        throw new AppError('Apenas Hosts acessam as solicitações recebidas.', 403, 'HOST_REQUIRED');
    }
    return user.provider;
}
