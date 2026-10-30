// Host elegível (#479): hospedagem, ativo e aprovado. Pendente, rejeitado ou inativo não aparece nem recebe solicitação.
// Usado como filtro do Prisma nos detalhes públicos (#479) e na criação da solicitação (#494).
export const ELIGIBLE_HOST = { providerType: 'hotel', status: 'active', validationStatus: 'approved' };
