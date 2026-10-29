import express from 'express';
import { prisma } from './lib/prisma.js';
import { requireServiceToken } from './middlewares/service-token.js';
import { provisionUserController } from './users/internal-users.controller.js';
import { requireUser } from './middlewares/user-token.js';
import { meController } from './users/me.controller.js';
import { tutorProfileController } from './tutors/tutor-profile.controller.js';

// Tempo máximo que /health/ready espera pela verificação do banco.
export const READY_TIMEOUT_MS = 2000;

const app = express();

// Rotas públicas (inventário no docs/openapi.yaml): só /health e /health/ready, fora do /api/v1.

// Liveness: só confirma que o processo responde; não acessa o banco.
app.get('/health', (req, res)=>{
    res.status(200).json(
        { status: "Server is running"}
    );
    console.log("/health");
});

// Readiness: executa SELECT 1 com limite de READY_TIMEOUT_MS; nunca escreve.
app.get('/health/ready', async (req, res)=>{
    let timer;
    try {
        await Promise.race([
            prisma.$queryRaw`SELECT 1`,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('timeout')), READY_TIMEOUT_MS);
            }),
        ]);
        res.status(200).json({ status: 'ready', database: 'ok' });
    } catch {
        res.status(503).json({ status: 'not_ready', database: 'unavailable' });
    } finally {
        clearTimeout(timer);
    }
});

// Protegido por padrão (TSK-04 #298): tudo sob /api/v1 exige autenticação antes de chegar na rota,
// então uma rota nova já nasce protegida. As internas usam o token de serviço do Auth; o resto, o JWT do usuário.
app.use('/api/v1/internal', requireServiceToken);
app.use('/api/v1', (req, res, next) => (req.path.startsWith('/internal/') ? next() : requireUser(req, res, next)));

// Provisionamento do USER pelo Auth Server (TSK-01 #259). Ordem: token de serviço → leitura do JSON → controller.
app.put('/api/v1/internal/users/:authUserId', express.json(), provisionUserController);

// Estado do usuário e do perfil para o app (TSK-04 #262). Ordem: JWT do usuário → controller.
app.get('/api/v1/me', meController);

// Conclusão do perfil do Tutor (TSK-04 #275). Ordem: JWT do usuário → leitura do JSON → controller.
app.put('/api/v1/me/tutor-profile', express.json(), tutorProfileController);

// Rota inexistente fora do /api/v1 (dentro dele, sem token, o 401 vem antes): JSON em vez da página HTML do Express.
app.use((req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Rota não encontrada' });
});

// Erro que escapou de uma rota ou middleware (ex.: banco fora do ar no requireUser, JSON malformado).
// Sem isso, o Express responde a página HTML padrão, que fora de produção traz o stack trace.
// eslint-disable-next-line no-unused-vars -- o Express só reconhece o tratador de erro pelos 4 parâmetros
app.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed') {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'JSON inválido' });
    }
    if (error.status >= 400 && error.status < 500) {
        return res.status(error.status).json({ code: 'BAD_REQUEST', message: 'Requisição inválida' });
    }
    console.log(error.message); // só a mensagem: nada de token ou dado pessoal no log
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
});

export default app;
