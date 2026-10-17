import { PrismaClient } from '@prisma/client';

// Limita consultas PostgreSQL pendentes para que o timeout de readiness
// também encerre a execução no servidor, em vez de apenas a resposta HTTP.
const datasourceUrl = process.env.DATABASE_URL
    ? (() => {
        const url = new URL(process.env.DATABASE_URL);
        url.searchParams.set('statement_timeout', '2000');
        return url.toString();
    })()
    : undefined;

// Instância única do Prisma Client compartilhada pela aplicação.
export const prisma = new PrismaClient({
    ...(datasourceUrl ? { datasourceUrl } : {}),
});
