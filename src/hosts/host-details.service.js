import { prisma } from '../lib/prisma.js';
import { ELIGIBLE_HOST } from './host-policy.js';

// Regra de negócio dos detalhes públicos do Host (GET /api/v1/hosts/:id). Não conhece HTTP.
// Só Host elegível (host-policy.js). Pendente, rejeitado, inativo ou inexistente voltam null (o controller responde 404).
// O select lista campo a campo o que pode sair (LGPD): CPF/CNPJ, e-mail, telefone e endereço completo nem são lidos do banco.
export function findPublicHostService(id) {
    return prisma.provider.findFirst({
        where: { id, ...ELIGIBLE_HOST },
        select: {
            id: true,
            name: true,
            description: true,
            urlPicture: true,
            rating: true,
            acceptedSpecies: true,
            acceptedSizes: true,
            acceptedBreeds: true,
            address: { select: { city: true, neighborhood: true } },
            photos: { select: { url: true }, orderBy: { createdAt: 'asc' } },
            services: { where: { active: true }, select: { id: true, name: true, price: true }, orderBy: { price: 'asc' } },
            _count: { select: { reviews: true } },
        },
    });
}
