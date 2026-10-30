import express from 'express';
import { fileURLToPath } from 'node:url';
import { prisma } from './lib/prisma.js';
import { requireServiceToken } from './middlewares/service-token.js';
import { provisionUserController } from './users/internal-users.controller.js';
import { requireUser } from './middlewares/user-token.js';
import { meController } from './users/me.controller.js';
import { tutorProfileController } from './tutors/tutor-profile.controller.js';
import { hostDetailsController } from './hosts/host-details.controller.js';
import { requireCanContract } from './middlewares/can-contract.js';
import { startContractController } from './contracts/contracts.controller.js';
import { createPetController, listPetsController } from './pets/pet.controller.js';
import { createReservationController } from './reservations/create-reservation.controller.js';
import { listHostReservationsController } from './reservations/list-host-reservations.controller.js';

// Tempo máximo que /health/ready espera pela verificação do banco.
export const READY_TIMEOUT_MS = 2000;

const app = express();

// Rotas públicas (inventário no docs/openapi.yaml): /health, /health/ready e a documentação em /docs, fora do /api/v1.

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

// Documentação da API (TSK-02 #501): página do Swagger UI e o contrato que ela lê.
const docsDir = fileURLToPath(new URL('../docs/', import.meta.url));
app.get('/docs', (req, res) => res.sendFile('index.html', { root: docsDir }));
app.get('/docs/openapi.yaml', (req, res) => res.type('text/yaml').sendFile('openapi.yaml', { root: docsDir }));

// Protegido por padrão (TSK-04 #298): tudo sob /api/v1 exige autenticação antes de chegar na rota,
// então uma rota nova já nasce protegida. As internas usam o token de serviço do Auth; o resto, o JWT do usuário.
// Um middleware só decide o token: o regex casa /internal como as rotas do Express (sem diferenciar maiúsculas, com ou sem / no fim).
app.use('/api/v1', (req, res, next) =>
    (/^\/internal(\/|$)/i.test(req.path) ? requireServiceToken(req, res, next) : requireUser(req, res, next)));

// Contratação protegida por padrão (TSK-05 #263): todo POST sob estes caminhos exige conta e perfil aptos.
// Só o POST: consultar ou cancelar o que já existe continua liberado para quem não pode mais contratar.
const CONTRACT_PATHS = ['/api/v1/reservations', '/api/v1/service-requests', '/api/v1/checkout'];
app.use(CONTRACT_PATHS, (req, res, next) => (req.method === 'POST' ? requireCanContract(req, res, next) : next()));

// Provisionamento do USER pelo Auth Server (TSK-01 #259). Ordem: token de serviço → leitura do JSON → controller.
app.put('/api/v1/internal/users/:authUserId', express.json(), provisionUserController);

// Estado do usuário e do perfil para o app (TSK-04 #262). Ordem: JWT do usuário → controller.
app.get('/api/v1/me', meController);

// Conclusão do perfil do Tutor (TSK-04 #275). Ordem: JWT do usuário → leitura do JSON → controller.
app.put('/api/v1/me/tutor-profile', express.json(), tutorProfileController);

// Detalhes públicos do Host (HSP-PBI-031-TSK-01 #479). Ordem: JWT do usuário → controller (GET, sem body).
app.get('/api/v1/hosts/:id', hostDetailsController);

// Pets do Tutor (TSK-04 #369). Ordem: JWT do usuário → leitura do JSON → controller (exige ser Tutor).
app.post('/api/v1/me/pets', express.json(), createPetController);
app.get('/api/v1/me/pets', listPetsController);

// Solicitação de hospedagem (HSP-PBI-039-TSK-01 #494). Ordem: JWT do usuário → conta e perfil aptos → leitura do JSON → controller.
app.post('/api/v1/reservations', express.json(), createReservationController);

// Solicitações recebidas pelo Host (HSP-PBI-041-TSK-01 #485). Ordem: JWT do usuário → controller (exige ser Host).
app.get('/api/v1/me/host/reservations', listHostReservationsController);

// Contratação (TSK-05 #263). Ordem: JWT do usuário → conta e perfil aptos → controller (provisório, responde 501).
for (const path of CONTRACT_PATHS.filter((path) => path !== '/api/v1/reservations')) app.post(path, startContractController);

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
