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

app.get('/', (req, res)=>{
    res.send('Hello World');
});

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

// Provisionamento do USER pelo Auth Server (TSK-01 #259). Ordem: token → leitura do JSON → controller.
app.put('/api/v1/internal/users/:authUserId', requireServiceToken, express.json(), provisionUserController);

// Estado do usuário e do perfil para o app (TSK-04 #262). Ordem: JWT do usuário → controller.
app.get('/api/v1/me', requireUser, meController);

// Conclusão do perfil do Tutor (TSK-04 #275). Ordem: JWT do usuário → leitura do JSON → controller.
app.put('/api/v1/me/tutor-profile', requireUser, express.json(), tutorProfileController);

export default app;
