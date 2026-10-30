# Hospetse — Back-end

API do back-end do Hospetse (plataforma de hospedagem e cuidado de pets), construída em Node.js + Express.

As decisões de arquitetura do projeto (por que Express, ES Modules, estratégia de testes, etc.) estão documentadas na [wiki do projeto](https://dev.azure.com/escola-ti/Hospetse/_wiki/wikis/Hospetse.wiki/55/Arquitetura) (ADR-001 a ADR-010).

## Pré-requisitos

- **Node.js 20.12.0 ou superior** (o projeto usa `process.loadEnvFile`, disponível no Node 21.7.0 e portado para o 20.12.0 — ver ADR-009/ADR-010 na wiki). O mesmo requisito está no campo `engines` do `package.json`.
- npm (instalado junto com o Node).
- **Acesso ao banco de desenvolvimento do time** (PostgreSQL hospedado no Railway). Não é preciso instalar PostgreSQL nem Docker na máquina. A `DATABASE_URL` contém usuário e senha, por isso não fica no repositório: peça a um membro do time e coloque-a só no seu `.env`.

## Instalação

```bash
git clone https://dev.azure.com/escola-ti/Hospetse/_git/hospetse-backend
cd hospetse-backend
npm install
```

## Configuração

O projeto lê configuração por variáveis de ambiente, nunca hardcoded no código (ver ADR-009). Antes de rodar pela primeira vez:

```bash
cp .env.example .env
```

Variáveis disponíveis (ver `.env.example` para a lista completa e atualizada):

| Variável | Descrição | Exemplo |
| --- | --- | --- |
| `PORT` | Porta em que o servidor HTTP sobe | `3000` |
| `DATABASE_URL` | String de conexão do PostgreSQL usada pelo Prisma | valor mantido apenas no `.env` |
| `SMOKE_DATABASE_URL` | Opcional. Substitui a `DATABASE_URL` só no `npm run smoke:db` (para simular falhas) | valor temporário mantido apenas no ambiente |
| `JWT_PUBLIC_KEY` | Chave pública RS256 do Auth Server (PEM, entre aspas), usada para validar o access token em [`GET /api/v1/me`](#estado-do-usuário-get-apiv1me). Mesmo valor da `JWT_PUBLIC_KEY` do Auth | valor mantido apenas no `.env` |
| `INTERNAL_SERVICE_TOKEN` | Segredo compartilhado com o Auth Server, exigido na [rota interna de provisionamento](#rota-interna-de-provisionamento-do-user). Mesmo valor nos dois serviços, diferente por ambiente | valor mantido apenas no `.env` |

> O arquivo `.env` nunca deve ser commitado (já está no `.gitignore`). Segredos e configuração de ambiente ficam só localmente ou no painel da plataforma de deploy.

## Primeira execução

Na primeira vez, siga os passos nesta ordem:

1. Instale as dependências (`npm install`, ver [Instalação](#instalação)).
2. Crie o `.env` a partir do `.env.example` e troque a `DATABASE_URL` de exemplo pela URL do banco de desenvolvimento do Railway (ver [Configuração](#configuração)). Mantenha a linha `PORT`: sem ela o servidor sobe numa porta aleatória.
3. Gere o Prisma Client (o banco do Railway já tem as tabelas criadas):

   ```bash
   npx prisma generate
   ```

4. Suba o servidor e confirme que ele responde (ver [Rodando o projeto](#rodando-o-projeto)).

Sempre que trouxer mudanças da `main` que alterem o `package.json` ou o `schema.prisma`, rode `npm install` e `npx prisma generate` de novo. Sem as dependências instaladas, o `npx prisma` baixa outra versão do Prisma em vez de usar a 6.19.0 do projeto.

## Rodando o projeto

```bash
npm run dev     # desenvolvimento, com reload automático a cada alteração (nodemon)
npm start       # produção, sem reload automático
```

Depois de subir, confirme que está no ar:

```bash
curl http://localhost:3000/health        # liveness
curl http://localhost:3000/health/ready  # readiness (banco)
```

| Rota | O que verifica | Respostas |
| --- | --- | --- |
| `GET /health` | Liveness: só confirma que o processo responde. Não acessa o banco. | `200 {"status":"Server is running"}` |
| `GET /health/ready` | Readiness: executa `SELECT 1` no banco com limite de 2 s. Nunca escreve. | `200 {"status":"ready","database":"ok"}` ou `503 {"status":"not_ready","database":"unavailable"}` (falha ou timeout) |

O limite de 2 s do `/health/ready` é aplicado pela corrida da rota e também por `statement_timeout=2000` na URL derivada pelo cliente Prisma. Assim, a resposta HTTP e a consulta pendente no PostgreSQL têm o mesmo limite; a URL original de configuração não é exposta nem alterada no ambiente.

## Documentação da API

O contrato de todas as rotas está em [`docs/openapi.yaml`](docs/openapi.yaml) (OpenAPI 3.1), navegável em `GET /docs` (Swagger UI) no servidor local e em produção: https://backend-production-7298.up.railway.app/docs. As seções abaixo explicam o contexto e as decisões de cada rota. Para validar o arquivo: `npx @redocly/cli lint docs/openapi.yaml`.

### Autenticação das rotas

Tudo sob `/api/v1` é protegido por padrão no `src/app.js` (Task #298): dois `app.use` rodam antes das rotas, então uma rota nova já nasce protegida sem precisar lembrar do middleware.

| Caminho | Autenticação | Sem credencial válida |
| --- | --- | --- |
| `/api/v1/internal/*` | Token de serviço do Auth (`requireServiceToken`) | `401 SERVICE_TOKEN_INVALID` |
| Resto de `/api/v1/*` | JWT do usuário (`requireUser`) | `401 TOKEN_INVALID`; JWT válido sem USER: `404 USER_NOT_FOUND` |
| `POST` em `/api/v1/reservations`, `/service-requests`, `/checkout` | JWT do usuário + conta e perfil aptos (`requireCanContract`, #263) | `403 ACCOUNT_RESTRICTED` ou `403 PROFILE_INCOMPLETE` (ver [Contratação](#contratação-post-apiv1reservations-service-requests-e-checkout)) |
| `GET /health`, `GET /health/ready` | Nenhuma (públicas) | — |

- As rotas públicas são só as duas acima. Uma rota pública nova precisa entrar no OpenAPI e na lista `PUBLIC_ROUTES` do `test/auth-guard.test.js`, que percorre todas as rotas registradas e falha se alguma responder sem autenticação.
- Caminho inexistente sob `/api/v1` responde `401` para quem não está autenticado: sem token, não dá para descobrir quais rotas existem. Fora do `/api/v1`, responde `404 NOT_FOUND` em JSON.
- Um tratador de erro no fim do `app.js` responde em JSON o que escapar das rotas: JSON malformado vira `400 VALIDATION_ERROR` e qualquer outro erro vira `500 INTERNAL_ERROR` (só a mensagem vai para o log). Sem ele, o Express devolveria a página HTML padrão, que fora de produção mostra o stack trace.

## Rota interna de provisionamento do USER

Contrato entre o Auth Server e o back-end para criar o usuário local (Task #259, HSP-PBI-001-TSK-01). Compatível com o `HttpUserProvisioner` do Auth (#253).

### `PUT /api/v1/internal/users/{authUserId}`

Chamada só pelo Auth Server, depois de validar o PIN e criar a `user_auth`. Não é usada pelo front.

`PUT` porque é idempotente: repetir a mesma chamada (por exemplo, após um timeout) não cria um segundo USER.

**`authUserId`:** UUID gerado pelo Auth (`user_auth.id`), enviado no caminho. O back-end guarda esse valor numa coluna própria e única (`users.auth_user_id`), separada do `users.id`, que continua gerado pelo back-end. É o mesmo valor que vai no `sub` do JWT de usuário, usado para localizar o USER nas rotas autenticadas.

**Autenticação:**

```http
Authorization: Bearer <INTERNAL_SERVICE_TOKEN>
```

Provisório: segredo compartilhado, comparado em tempo constante. Quando o token de serviço RS256 do Auth (#254) existir, ele substitui o segredo no mesmo cabeçalho, sem mudar a rota nem as respostas. A autenticação é verificada antes de qualquer validação do body.

**Request:**

```json
{ "email": "tutor@exemplo.com", "name": "Maria Silva" }
```

| Campo | Regra |
| --- | --- |
| `email` | Obrigatório, formato de e-mail, até 255 caracteres. Já confirmado por PIN no Auth. Normalizado com trim e minúsculas, igual ao Auth |
| `name` | Obrigatório, não pode ser vazio nem só espaços, até 255 caracteres. Gravado sem os espaços das pontas |
| Outros campos | Recusados com `400`. A senha nunca é enviada ao back-end, e um `password` no body é tratado como erro de integração |

**Respostas:**

| Status | `code` | Caso | Body |
| --- | --- | --- | --- |
| `201` | — | USER criado agora | `{ "userId": "uuid", "authUserId": "uuid" }` |
| `200` | — | USER já existia com o mesmo `authUserId` e e-mail (retentativa) | `{ "userId": "uuid", "authUserId": "uuid" }` |
| `400` | `VALIDATION_ERROR` | `authUserId` não é UUID, payload inválido ou campo fora do contrato | `{ "code", "message", "details": [{ "field", "message" }] }`, com todos os campos inválidos |
| `401` | `SERVICE_TOKEN_INVALID` | Cabeçalho ausente, fora do formato `Bearer` ou com token errado | `{ "code", "message" }` |
| `409` | `EMAIL_ALREADY_IN_USE` | E-mail já usado por outro USER | `{ "code", "message" }` |
| `409` | `AUTH_USER_ID_CONFLICT` | `authUserId` já vinculado a outro e-mail | `{ "code", "message" }` |
| `500` | `INTERNAL_ERROR` | Falha inesperada no back-end | `{ "code", "message" }` |

A ordem das verificações é: autenticação (`401`) → validação (`400`) → regra de negócio (`200`/`201`/`409`) → persistência (`500`).

### Requisições repetidas (idempotência)

| `authUserId` já existe? | E-mail | Resposta |
| --- | --- | --- |
| Não | Livre | `201`, cria o USER |
| Sim | Igual ao gravado | `200`, devolve o USER existente sem alterar nada |
| Sim | Diferente do gravado | `409 AUTH_USER_ID_CONFLICT` |
| Não | Usado por outro USER | `409 EMAIL_ALREADY_IN_USE` |
| Duas chamadas iguais ao mesmo tempo | — | A unicidade no banco barra a segunda, que relê o USER e responde `200` |

O `name` não entra na comparação: na retentativa, o nome gravado na primeira criação é mantido. A criação é atômica, então nenhuma falha deixa um USER criado pela metade.

### Falha de comunicação e timeout

O contrato só define se repetir faz sentido. Quantas vezes repetir e quanto esperar ficam a cargo do Auth.

| Resposta | Tipo | Repetir? |
| --- | --- | --- |
| `200` / `201` | Sucesso | — |
| `400`, `401`, `409` | Definitivo | Não: a mesma chamada daria o mesmo erro |
| `500`, `502`, `503`, `504`, timeout ou sem resposta | Transitório | Sim: repetir é seguro por causa da idempotência |

Se o back-end gravar o USER e a resposta se perder (timeout), a repetição recebe `200` com o mesmo `userId`.

### Pendências

- Onde o nome é gravado (USER ou TUTOR), se o TUTOR é criado no cadastro e o fim do `account_type` dependem da HSP-DEC-002 e são definidos na TSK-02 (#260). O contrato só garante que o nome é recebido e guardado.
- Formato definitivo do erro padrão (#56). Até lá, vale `{ code, message, details? }`.
- Troca do `INTERNAL_SERVICE_TOKEN` pelo token de serviço RS256 (#254).

## Estado do usuário: `GET /api/v1/me`

Rota usada pelo app para montar a tela inicial (Task #262, HSP-PBI-001-TSK-04).

**Autenticação:** `Authorization: Bearer <accessToken>`, com o access token (JWT) devolvido pelo `register` ou pelo `refresh` do Auth. O back-end valida com a `JWT_PUBLIC_KEY`: assinatura RS256, `iss: hospetse-auth-service`, `aud: hospetse-backend` e `exp` (15 min). O `sub` do token é o `authUserId` e localiza o USER em `users.auth_user_id`.

| Status | `code` | Caso | Body |
| --- | --- | --- | --- |
| `200` | — | Token válido e USER encontrado | ver abaixo |
| `401` | `TOKEN_INVALID` | Cabeçalho ausente, token mal formado, assinatura errada, expirado ou com `iss`/`aud` diferente | `{ "code", "message" }` |
| `404` | `USER_NOT_FOUND` | Token válido, mas não existe USER com esse `authUserId` | `{ "code", "message" }` |

```json
{
  "user": { "id": "uuid", "authUserId": "uuid", "email": "tutor@exemplo.com", "name": "Maria Silva" },
  "profile": { "status": "incomplete", "missingFields": ["cpf", "birthDate", "phone", "address", "emergencyContact"] },
  "permissions": { "canSearch": true, "canContract": false }
}
```

- `missingFields`: campos do perfil do Tutor ainda vazios, entre `cpf`, `birthDate`, `phone`, `address` e `emergencyContact` (nome e telefone). Sem TUTOR, todos aparecem. É a mesma regra usada pela conclusão do perfil (PBI-002, `src/users/profile-policy.js`).
- `canSearch`: `true` para qualquer usuário autenticado.
- `canContract`: `true` só com `profile_status = complete` e conta que não esteja `blocked` ou `suspended`. A mesma regra (`src/users/profile-policy.js`) será usada no bloqueio da contratação (TSK-05).
- A resposta lista só esses campos: senha e segredos nunca saem.

## Conclusão do perfil do Tutor: `PUT /api/v1/me/tutor-profile`

Rota usada pela tela "Completar perfil" do app (Task #275, HSP-PBI-002-TSK-04). Grava os dados do Tutor e marca o perfil como `complete`, o que libera `canContract` no `/me`. A mesma rota serve para editar os dados depois.

**Autenticação:** igual ao `/me`. O usuário vem só do `sub` do JWT: não há id na URL nem no body, então ninguém altera o perfil de outro usuário.

**Body:**

```json
{
  "cpf": "529.982.247-25",
  "birthDate": "1990-05-10",
  "phone": "11999999999",
  "emergencyContact": { "name": "Maria Silva", "phone": "11988888888" },
  "address": {
    "zipCode": "01001-000",
    "street": "Praça da Sé",
    "number": "100",
    "complement": "Apto 1",
    "neighborhood": "Sé",
    "city": "São Paulo",
    "state": "SP"
  }
}
```

| Campo | Regra |
| --- | --- |
| `cpf` | Com ou sem pontuação. Dígitos verificadores válidos, sem todos os dígitos iguais e sem pertencer a outro usuário. Gravado só com os 11 dígitos |
| `birthDate` | `YYYY-MM-DD`, data real (`2000-02-30` é recusada) e idade mínima de 18 anos |
| `phone`, `emergencyContact.phone` | Só dígitos, com DDD: 10 ou 11 dígitos, sem `+55` \[assunção\] |
| `emergencyContact.name` | Obrigatório, até 255 caracteres |
| `address.zipCode` | 8 dígitos, com ou sem hífen \[assunção\]. Gravado sem o hífen |
| `address.street` / `number` | Obrigatórios, até 255 / 20 caracteres |
| `address.complement` | Opcional, até 100 caracteres |
| `address.neighborhood` / `city` | Obrigatórios, até 100 caracteres |
| `address.state` | Sigla com 2 letras. Gravada em maiúsculas |
| Outros campos | Recusados com `400` (`não faz parte do contrato`) |

**Respostas:**

| Status | `code` | Caso | Body |
| --- | --- | --- | --- |
| `204` | — | Perfil gravado e marcado como `complete` | vazio |
| `400` | `VALIDATION_ERROR` | Qualquer campo inválido, incluindo CPF já usado por outro usuário | `{ "code", "message", "details": [{ "field", "message" }] }`, com todos os campos inválidos (`address.zipCode`, `emergencyContact.name`...) |
| `401` | `TOKEN_INVALID` | Igual ao `/me` | `{ "code", "message" }` |
| `404` | `USER_NOT_FOUND` | Igual ao `/me` | `{ "code", "message" }` |
| `500` | `INTERNAL_ERROR` | Falha inesperada no back-end | `{ "code", "message" }` |

- O CPF nunca volta em resposta nem em log: o `details` diz qual campo está errado, não o valor recebido (LGPD).
- Endereço, Tutor e USER são gravados em uma transação: ou tudo, ou nada. Na primeira chamada o TUTOR é criado (com o `name` do USER); nas seguintes, os dados e o mesmo endereço são atualizados.
- `profile_completed_at` guarda a data da primeira conclusão: uma edição depois não a altera.
- Depois do `204`, o app chama o `/me` para receber o novo estado.

**Pendências:**

- \[assunção\] Formato do telefone e do CEP: alinhar com o mobile.
- Telefone como campo obrigatório do perfil completo: decisão do time, a validar com a PO (a #272 foi removida).

## Contratação: `POST /api/v1/reservations`, `/service-requests` e `/checkout`

Guarda de contratação por completude do perfil (Task #263, HSP-PBI-001-TSK-05): só quem tem conta ativa e perfil `complete` pode contratar. A regra fica no back-end, então vale mesmo que o app não bloqueie o botão.

**Ordem no `src/app.js`:** JWT do usuário (`requireUser`, global do `/api/v1`) → guarda de contratação (`requireCanContract`) → controller. A guarda segue o mesmo formato do protegido por padrão: um `app.use` com a lista `CONTRACT_PATHS`, antes das rotas. Uma rota nova sob esses caminhos já nasce com a guarda.

**Respostas:**

| Status | `code` | Caso |
| --- | --- | --- |
| `401` | `TOKEN_INVALID` | Igual ao `/me` |
| `404` | `USER_NOT_FOUND` | Igual ao `/me` |
| `403` | `ACCOUNT_RESTRICTED` | Conta `blocked` ou `suspended` (conferida antes do perfil) |
| `403` | `PROFILE_INCOMPLETE` | Perfil que não está `complete`. Mensagem: "Complete seu perfil antes de contratar um serviço." |
| `501` | `NOT_IMPLEMENTED` | Passou pela guarda, mas a criação ainda não existe (provisório) |
| `500` | `INTERNAL_ERROR` | Falha inesperada no back-end |

- A regra está em `contractDenial` (`src/users/profile-policy.js`), a mesma que calcula o `canContract` do `/me`: o app e o back-end nunca discordam. Conta `pending` não bloqueia, porque todo USER novo nasce assim.
- A guarda vale só para o `POST`: consultar ou cancelar o que já existe continua liberado para quem não pode mais contratar.
- Perfil incompleto continua navegando: `/me` e as rotas de busca não passam pela guarda.
- A regra também é conferida na camada de service (`assertCanContract`), para valer mesmo se uma rota não tiver a guarda.

**Pendências:**

- \[provisório\] `src/contracts/` só existe enquanto as rotas não têm implementação real: responde `501` para quem passa pela guarda. A #494 (PBI-039, solicitação de hospedagem) e as tasks de reserva e checkout trocam o handler pelo controller real, mantendo a guarda e chamando `assertCanContract` no service.
- Body e resposta de sucesso de cada rota: definidos por essas tasks.

## Deploy (Railway)

O back-end roda no Railway (projeto `superb-recreation`, serviço `backend`, ambiente `production`): https://backend-production-7298.up.railway.app. URLs e contratos para o Mobile estão na wiki, em Index/Desenvolvimento/Back-end/APIs publicadas - URLs e contratos.

- **Publicação:** o `azure-pipelines.yml` roda o CI (lint, `npm test` e `npm run test:integration` com um Postgres descartável) em cada PR para a `main`, e a cada push na `main` publica com `railway up --service backend` (Task #500). Deploy manual, se precisar: `railway up --service backend`, com a pasta ligada ao projeto (`railway link`).
- **Imagem:** o `Dockerfile` roda `prisma migrate deploy` antes de `node index.js`. Se uma migration falhar, o container não sobe e o deploy falha à vista.
- **Health check:** o `railway.json` configura `/health`; o Railway só troca de versão quando a nova responde.
- **Variáveis do serviço** (no Railway, nunca no repositório):

| Variável | Valor |
| --- | --- |
| `DATABASE_URL` | Referência `${{backend-service-db.DATABASE_URL}}`: rede interna do Railway, sem passar pela internet |
| `JWT_PUBLIC_KEY` | A mesma chave pública do Auth |
| `INTERNAL_SERVICE_TOKEN` | O mesmo valor do Auth |
| `PORT` | Definida pelo próprio Railway (hoje 8080) |

- **Auth → back-end:** o Auth chama a rota interna pela rede interna, com `BACKEND_URL=http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:8080` no serviço do Auth.

## Scripts disponíveis

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Sobe o servidor em modo desenvolvimento (reload automático) |
| `npm start` | Sobe o servidor em modo produção |
| `npm run lint` | Roda o ESLint sobre o projeto, apontando problemas de código |
| `npm test` | Roda só os testes sem banco (test runner nativo do Node); não exige `DATABASE_URL` |
| `npm run test:integration` | Roda os testes de integração contra o banco real (exige `DATABASE_URL`) |
| `npm run smoke:db` | Smoke check do banco: imprime um relatório JSON e sai com 0 (ok) ou 1 (falha). `npm run smoke:db -- --falha-escrita` simula uma escrita rejeitada |

## Estrutura do projeto

```text
.
├── index.js            # Carrega o ambiente e chama .listen() — ponto de entrada real
├── src/
│   ├── app.js          # Exporta a aplicação Express e registra as rotas (sem subir servidor)
│   ├── lib/            # prisma.js (instância única do Prisma Client), app-error.js, jwt.js, cpf.js
│   ├── middlewares/    # service-token.js (rota interna), user-token.js (JWT do usuário), can-contract.js (guarda de contratação)
│   ├── contracts/      # controller e service provisórios das rotas de contratação (respondem 501)
│   ├── tutors/         # controller e service da conclusão do perfil do Tutor
│   └── users/          # controllers, service e regras do USER (provisionamento, /me e profile-policy.js)
├── docs/openapi.yaml   # Contrato OpenAPI 3.1 de todas as rotas
├── docs/index.html     # Página do Swagger UI servida em /docs
├── Dockerfile          # Imagem publicada no Railway (aplica as migrations ao subir)
├── azure-pipelines.yml # CI (lint e testes) e CD (deploy no Railway a partir da main)
├── railway.json        # Configuração do serviço no Railway (health check)
├── eslint.config.js    # Configuração do linter
├── prisma.config.ts    # Configuração do Prisma CLI (schema, migrações e DATABASE_URL)
├── tsconfig.json       # Só para o editor resolver os tipos do prisma.config.ts
├── prisma/
│   ├── schema.prisma   # Modelo de dados (fonte da verdade do banco)
│   └── migrations/     # Histórico de migrações SQL versionadas
├── test/
│   ├── app.test.js     # Testes sem banco (node:test)
│   ├── health.test.js  # /health sem banco
│   ├── auth-guard.test.js # Proteção das rotas: inventário, tokens inválidos, 404/400/500 em JSON
│   ├── cpf.test.js     # Validação de CPF
│   ├── profile-policy.test.js # Regra de completude, idade mínima e regra de contratação
│   ├── contracts.test.js # Guarda de contratação: 403, 501 e só o POST (USERs simulados, sem banco)
│   ├── smoke/
│   │   └── smoke-db.js # Smoke check do banco (npm run smoke:db)
│   └── integration/    # Testes contra o banco real (npm run test:integration)
│       ├── db.test.js
│       ├── ready.test.js
│       ├── provisioning.test.js # Cadastro: PUT interno (idempotência, conflitos, sem senha, 401) e /me em seguida
│       ├── tutor-profile.test.js
│       └── user-token.test.js # JWT válido sem USER
├── .env.example        # Modelo das variáveis de ambiente necessárias
└── package.json
```

`app.js` e `index.js` são propositalmente separados: isso permite que os testes importem o `app` sem disparar o efeito colateral de abrir uma porta de rede real (ver ADR-010 na wiki para detalhes). O `app.js` importa diretamente a instância única do Prisma. O `index.js` carrega o `.env` antes do import dinâmico do app e apenas inicia o servidor. A rota `/health` é liveness e não acessa o banco; `/health/ready` executa `SELECT 1` no banco real, com timeout de 2 segundos.

## Persistência de dados

O projeto usa **Prisma 6.19.0 + PostgreSQL** (ADR-002 e ADR-003 na wiki). As versões de `prisma` e `@prisma/client` são fixadas e devem ser atualizadas sempre juntas.

### Como a estrutura de migração funciona

- `prisma/schema.prisma` é a fonte da verdade: toda mudança de tabela, coluna, índice ou relação começa aqui.
- `prisma/migrations/` guarda o histórico em SQL. Cada pasta `<timestamp>_<nome>/migration.sql` é uma migração, aplicada uma única vez e em ordem cronológica.
- O Prisma registra no banco, na tabela `_prisma_migrations`, quais migrações já foram aplicadas. Por isso **uma migração já aplicada/commitada nunca deve ser editada, renomeada ou apagada**: para corrigir algo, crie uma nova migração.
- `prisma/migrations/migration_lock.toml` trava o provider (`postgresql`) e não deve ser editado à mão.
- `prisma.config.ts` diz ao Prisma CLI onde ficam o schema e as migrações e lê a `DATABASE_URL` do `.env`.
- A migração `20260904100000_init` cria a estrutura inicial completa (extensão `pgcrypto`, enums, tabelas, índices, chaves estrangeiras e constraints `CHECK`). Ela unifica as migrações por domínio que existiam antes de qualquer banco ser migrado.

### Fluxo de trabalho

O banco de desenvolvimento no Railway é **compartilhado por todo o time**. Por isso, ninguém aplica migrações nele a partir da própria máquina: elas só entram no banco depois do merge na `main`, via `npx prisma migrate deploy`.

> **Nunca rode `prisma migrate dev` nem `prisma migrate reset` com a `DATABASE_URL` do Railway.** Se detectarem divergência entre as migrações e o banco, esses comandos oferecem recriar o banco, o que apaga os dados de todo o time.

Para criar uma nova migração depois de alterar o `schema.prisma`:

```bash
# 1. Traga a main para a sua branch antes, para comparar com o estado mais recente do banco
git fetch origin && git merge origin/main

# 2. Crie a pasta da migração (timestamp AAAAMMDDHHMMSS + nome descritivo)
mkdir prisma/migrations/20261010120000_adiciona-campo-x

# 3. Gere o SQL comparando o banco do Railway com o seu schema.prisma (só lê o banco, não altera nada)
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20261010120000_adiciona-campo-x/migration.sql

# 4. Atualize o Prisma Client local com o novo schema
npx prisma generate
```

Sempre revise o `migration.sql` gerado antes de commitar. Ele deve conter só a sua mudança. Se aparecerem comandos que você não esperava (por exemplo `DROP` de algo que outra pessoa criou), a sua branch está desatualizada em relação à `main` ou o `schema.prisma` diverge do banco.

Utilitários:

```bash
npx prisma validate          # valida o schema.prisma
npx prisma generate          # regera o Prisma Client
npx prisma migrate status    # mostra quais migrações ainda não foram aplicadas no banco (só leitura)
```

## Testes

```bash
npm test
```

Os testes usam o test runner nativo do Node (`node:test` + `node:assert`), sem framework externo — decisão registrada na ADR-010. Cada teste sobe o `app` numa porta efêmera (evitando conflito com o servidor de desenvolvimento ou outros testes rodando em paralelo).

Há três grupos:

- `test/*.test.js`: testes somente das rotas `/` e `/health`, sem banco (`npm test`). Não carregam o `.env` nem exigem `DATABASE_URL`.
- `test/integration/`: testes de readiness e operações contra o banco real (`npm run test:integration`).
- `test/smoke/smoke-db.js`: smoke check do banco (`npm run smoke:db`).

Os scripts listam os arquivos explicitamente (o `npm` no Windows usa `cmd`, que não expande glob, e `node --test` sem argumentos rodaria também smoke e integração). Ao criar um novo teste sem banco, inclua o arquivo no script `test` do `package.json`.

### Smoke check e validação de banco

Há quatro verificações com responsabilidades diferentes:

- **Smoke check** (`npm run smoke:db`) é uma verificação curta, sequencial e operacional do caminho Prisma + PostgreSQL: configuração, conexão, `SELECT 1`, leitura de `coupons`, escrita com commit, leitura após o commit e limpeza.
- **Teste de integração** (`npm run test:integration`) exerce o banco real com vários cenários: `SELECT 1`, leitura de `coupons` vazia ou populada, escrita/commit/leitura/remoção, violação de `CHECK`, execuções consecutivas, schema inexistente (`P2021`), banco inacessível (`P1001`) e readiness.
- **Liveness** (`GET /health`) verifica apenas se o processo HTTP responde; não consulta o banco.
- **Readiness** (`GET /health/ready`) verifica se a aplicação pode consultar o banco com `SELECT 1`. Responde `200` com `{"status":"ready","database":"ok"}` quando está pronta e `503` com `{"status":"not_ready","database":"unavailable"}` quando a consulta falha ou excede 2 segundos. A rota não escreve dados.

Os comandos disponíveis são:

```text
npm test
npm run test:integration
npm run smoke:db
npm run smoke:db -- --falha-escrita
```

`npm test` cobre as rotas sem exigir `DATABASE_URL`. `npm run test:integration` e `npm run smoke:db` exigem uma `DATABASE_URL` configurada no ambiente ou no `.env`; não coloque essa configuração no repositório. A variável `SMOKE_DATABASE_URL` substitui a `DATABASE_URL` somente no smoke e permite simular um banco inacessível ou schema ausente sem alterar o `.env`. Exemplo seguro no PowerShell, usando um valor local temporário:

```powershell
$env:SMOKE_DATABASE_URL = '<URL-DE-TESTE-INACESSIVEL>'
npm run smoke:db
Remove-Item Env:SMOKE_DATABASE_URL
```

O smoke e os testes de escrita usam somente a tabela `coupons`, escolhida por permitir a criação de um cupom sem fornecer dependências obrigatórias. A estratégia `commit_e_limpeza` insere um registro com `active: false` e `code` único `smoke-...`, confirma o commit, lê fora da transação, exclui apenas pelo `id` criado e verifica a ausência posterior. Registros existentes não são alterados nem apagados. Nenhuma migração, reset ou `db push` foi executado para validar essa implementação.

O relatório do smoke é JSON sanitizado e contém, em termos gerais, data/hora, ambiente, commit, versões do Node/Prisma/PostgreSQL, estratégia, modo, etapas, resultado da limpeza e `codigoSaida`. Cada etapa pode ser `aprovada`, `reprovada` com categoria/código sanitizados ou `nao_executada` por dependência de uma falha anterior. O processo termina com código `0` quando não há etapa reprovada e `1` quando há falha. Os exemplos esperados são: execução normal com `codigoSaida: 0` e limpeza `removido`; `--falha-escrita` com categoria `violacao_constraint` e código `1`; configuração ausente, banco inacessível ou schema ausente com a categoria correspondente e código `1`. Os exemplos são critérios esperados, não resultados novos registrados neste documento.

O limite de readiness é duplo: a rota interrompe a espera após 2 s, e `src/lib/prisma.js` deriva uma URL do Prisma com `statement_timeout=2000` para limitar a consulta pendente no PostgreSQL. Isso é diferente do liveness, que não depende da conectividade do banco.

Limites conhecidos: a permissão negada (`permissao_negada`) é classificada pelo smoke, mas não é coberta pelos testes porque exigiria um usuário restrito no banco. O relatório não expõe URL, host, porta, usuário, senha, dados pessoais ou mensagens brutas do Prisma/driver.
