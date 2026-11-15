# Hospetse — Back-end

API do back-end do Hospetse (plataforma de hospedagem e cuidado de pets), construída em Node.js + Express.

As decisões de arquitetura do projeto (por que Express, ES Modules, estratégia de testes, etc.) estão documentadas na [wiki do projeto](https://dev.azure.com/escola-ti/Hospetse/_wiki/wikis/Hospetse.wiki/55/Arquitetura) (ADR-001 a ADR-010).

## Seed de demonstração (#497, #314)

Execução manual, fora do deploy. Com dependências instaladas e `DATABASE_URL` do back-end configurada no `.env`, aplique as migrations com `npx prisma migrate deploy` e execute:

```bash
npx prisma db seed
```

Execute **primeiro neste repositório e depois no Auth Server**, usando os bancos do mesmo ambiente. O Auth possui seu próprio seed e recebe as senhas por `SEED_ADMIN_PASSWORD` e `SEED_TUTOR_PASSWORD` no `.env` privado. Nenhuma senha fica no back-end.

| Conta | E-mail de demonstração | Estado |
| --- | --- | --- |
| Administrador | `admin@hospetse.dev` | `admin`, sem Tutor ou prestador |
| Tutor completo | `tutor.completo@hospetse.dev` | Perfil completo, adulto, endereço e contato de emergência |
| Tutor incompleto | `tutor.incompleto@hospetse.dev` | Perfil incompleto, sem registro de Tutor até concluir o perfil |

O Tutor completo possui Rex (`dog`, `medium`, Vira-lata), Mia (`cat`, `small`, Siamês) e Thor (`dog`, `large`, Labrador), todos ativos. Os dados de perfil são fixtures de demonstração.

**Hosts de demonstração (#498).** Seis contas `host.*@hospetse.dev`, com identidade criada pelo seed do Auth, cada uma com prestador, endereço, diária, capacidade e fotos placeholder. Os validados gravam os mesmos valores do fluxo do Administrador (`hotel`, `active`, `approved`): a busca não tem desvio para dados de seed.

| E-mail | Hotel | Cidade | Diária | Aceita | Capacidade | Agenda | Na busca |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `host.aberto@` | Hotel Aberto | São Paulo | 80 | tudo | 3 | livre | sim |
| `host.caes@` | Hotel Só Cães | São Paulo | 120 | `dog`, `small`/`medium` | 2 | bloqueado de hoje+7 a hoje+9 | sim |
| `host.gatos@` | Hotel Gatos | Campinas | 150 | `cat` | 1 | ocupado de hoje+14 a hoje+16 (Mia) | sim |
| `host.racas@` | Hotel Raças | Rio de Janeiro | 200 | `dog`, raças Labrador e Golden | 2 | livre | sim |
| `host.pendente@` | Hotel Pendente | São Paulo | 90 | tudo | 1 | — | não (`pending`) |
| `host.inativo@` | Hotel Inativo | São Paulo | 90 | tudo | 1 | — | não (`inactive`) |

Com os pets do Tutor completo: Rex encontra Aberto e Só Cães; Mia, Aberto e Gatos; Thor, Aberto e Raças. A agenda é relativa ao dia em que o seed roda: cada execução recria fotos, bloqueios e a reserva de ocupação dos Hosts do seed (o total não cresce). Bloqueios feitos à mão nesses Hosts se perdem ao rodar de novo. A ocupação usa a Mia: ela fica com `PET_ALREADY_BOOKED` nesse período. Os UUIDs e e-mails de `prisma/seed-accounts.js` devem permanecer iguais nos dois repositórios: no Auth o UUID é `user_auth.id`; aqui é `users.auth_user_id`.

Reexecutar preserva IDs e a data de conclusão do perfil, restaura os dados de demonstração e não duplica contas, endereços, Tutor, pets, prestadores, serviços, fotos, bloqueios ou reservas. Conflitos de UUID/e-mail/papel, prestador em conta de Admin ou Tutor, Tutor em conta de Host ou em conta reservada incompleta, pet de outro Tutor, e prestador, endereço, serviço ou reserva do seed pertencentes a outro cadastro abortam a transação inteira. Conflito de CPF também causa rollback. Investigue o conflito; não exclua contas reais para liberar o seed.

`[assunção]` (#497) A rota de serviço do Auth citada no card ainda não existe. Usamos dois seeds locais, cada um acessando somente seu banco. A transação é por banco; não há atomicidade entre serviços. Se a segunda execução falhar, corrija o problema e repita. Não rode como parte do Dockerfile ou pipeline.

Após os dois seeds, faça login no Auth (`POST /api/v1/auth/login`) e use o access token no back-end em `GET /api/v1/me`. O Tutor completo retorna `canContract: true` e três pets em `GET /api/v1/me/pets`; o incompleto retorna `canContract: false`. O papel de Administrador é persistido no banco; confirme com `GET /api/v1/admin/me` (`{ id, accountType }`). A recuperação da senha do Administrador é feita no seed do Auth (`SEED_ADMIN_PASSWORD`, #314 / DA-07), não por rota pública.

### Teste isolado do seed

Configure no processo `SEED_TEST_DATABASE_URL` apontando para um PostgreSQL local **vazio e descartável**, com nome terminado em `_seed_test`. Aplique as migrations nesse banco usando `DATABASE_URL` com o mesmo valor. Execute:

```bash
node --test test/integration/seed.test.js
```

O teste valida criação, reexecução sem duplicatas (também dos dados de Host), JWT resolvido pelo `sub`, `/me`, pets, a busca com cada filtro sobre os Hosts do seed (pendente e inativo fora), a agenda bloqueada e ocupada e rollback por conflitos. Só remove os registros de teste. Também entra em `npm run test:integration`, mas fica ignorado sem `SEED_TEST_DATABASE_URL`; não usa o Railway como fallback. Rode separadamente dos demais testes de banco, pois exige banco vazio.

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
| `CORS_ORIGINS` | Origens do navegador liberadas no CORS, separadas por vírgula e sem barra no fim. Vazio bloqueia todas. Precisa estar no Railway para a web local chamar o back-end | `http://localhost:8081` |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Acesso ao bucket privado do Railway, onde ficam documentos e fotos do Host. Copiar da aba Credentials do bucket | valores mantidos apenas no `.env` |
| `STORAGE_SIGNED_URL_SECONDS` | Opcional. Validade dos links temporários de arquivos, em segundos. Padrão: `300` | `300` |

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

## Detalhes públicos do Host: `GET /api/v1/hosts/{id}`

Rota usada pelo Tutor para ver um Host antes de solicitar (Task #479, HSP-PBI-031-TSK-01).

**Autenticação:** igual ao `/me`. Qualquer usuário autenticado pode consultar.

**Host elegível:** `provider_type = hotel`, `status = active` e `validation_status = approved`.

| Status | `code` | Caso | Body |
| --- | --- | --- | --- |
| `200` | — | Host elegível | ver abaixo |
| `401` | `TOKEN_INVALID` | Igual ao `/me` | `{ "code", "message" }` |
| `404` | `NOT_FOUND` | Host inexistente, pendente, rejeitado, inativo ou `id` fora do formato UUID | `{ "code", "message" }` |
| `404` | `USER_NOT_FOUND` | Igual ao `/me` | `{ "code", "message" }` |

```json
{
  "id": "uuid",
  "name": "Hotelzinho da Ana",
  "description": "Casa com quintal",
  "pictureUrl": "https://exemplo.com/perfil.jpg",
  "location": { "city": "São Paulo", "neighborhood": "Pinheiros" },
  "photos": ["https://exemplo.com/1.jpg"],
  "accepts": { "species": ["dog", "cat"], "sizes": ["small", "medium"], "breeds": [] },
  "services": [{ "id": "uuid", "name": "Diária", "price": 120.5 }],
  "reputation": { "rating": 4.8, "reviewCount": 12 }
}
```

- O mesmo `404` para todos os casos não elegíveis: a resposta não revela que um Host pendente ou inativo existe.
- O service lê do banco só os campos públicos (`select` campo a campo). CPF/CNPJ, e-mail, telefone, rua, número e CEP nunca saem (LGPD).
- `services`: só os ativos, do mais barato para o mais caro. `accepts.breeds` vazio significa que o Host aceita todas as raças.
- `reputation.rating` é `null` enquanto o Host não tem avaliações.

## Busca de Hosts: `GET /api/v1/hosts/search`

Rota usada pelo Tutor para encontrar ofertas de hospedagem compatíveis com o pet e o período (Task #476, HSP-PBI-030-TSK-01).

**Autenticação:** igual ao `/me`. Basta estar autenticado: não exige perfil completo (`canSearch`).

```http
GET /api/v1/hosts/search?city=São Paulo&startDate=2026-11-10&endDate=2026-11-13&petId=<uuid>&page=1&pageSize=20
```

| Parâmetro | Regra |
| --- | --- |
| `city` | Opcional. Sem diferenciar maiúsculas |
| `minPrice` / `maxPrice` | Opcionais, `>= 0`, `minPrice <= maxPrice`. Aplicados à diária |
| `startDate` / `endDate` | Opcionais, mas sempre juntos. `YYYY-MM-DD`, a partir de hoje, fim depois do início |
| `petId` | Opcional. Pet ativo do próprio Tutor; espécie, porte e raça vêm dele |
| `species` / `size` / `breed` | Opcionais, só sem `petId`. `species`: `dog`, `cat`; `size`: `small`, `medium`, `large` |
| `page` / `pageSize` | Padrão 1 e 20; `pageSize` até 50 |

Uma oferta (serviço ativo de um Host elegível) só aparece se, com os filtros informados:
- o pet for aceito: lista vazia aceita tudo, sem diferenciar maiúsculas; Host que restringe um campo recusa pet sem o dado;
- nenhum dia do período estiver bloqueado na agenda do Host;
- houver vaga em todos os dias do período: reservas aguardando pagamento, aceitas ou em andamento, até a capacidade (1 se não cadastrada).

São as mesmas regras do `POST /api/v1/reservations`: o que a busca mostra, a solicitação aceita com o mesmo pet e período.
A ordem é a menor diária primeiro, com desempate pelo `serviceId`, o que deixa a paginação estável.

| Status | `code` | Caso | Body |
| --- | --- | --- | --- |
| `200` | — | Busca feita, mesmo sem resultado | `{ items, page, pageSize, total }` |
| `400` | `VALIDATION_ERROR` | Todos os parâmetros inválidos em `details`, incluindo os fora do contrato, os repetidos e pet que não é do Tutor | `{ "code", "message", "details" }` |
| `401` / `404` | `TOKEN_INVALID` / `USER_NOT_FOUND` | Igual ao `/me` | `{ "code", "message" }` |

```json
{
  "items": [
    {
      "hostId": "uuid",
      "serviceId": "uuid",
      "name": "Hotelzinho do Rex",
      "serviceName": "Diária",
      "dailyPrice": 95,
      "pictureUrl": null,
      "location": { "city": "São Paulo", "neighborhood": "Bela Vista" },
      "reputation": { "rating": 4.5, "reviewCount": 12 }
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1
}
```

- Os filtros rodam no banco (`src/hosts/host-search.service.js`), antes de paginar: filtrar depois perderia e repetiria resultados.
- Os campos de cada item são os públicos do `GET /api/v1/hosts/{id}`. CPF/CNPJ, e-mail, telefone, rua, número e CEP nunca saem (LGPD).

**Pendências**
- `[assunção]` (HSP-DEC-005) Só a ordenação por menor preço; outras opções ficam para depois.
- `[assunção]` `species` informada à mão, além do porte e da raça que o card cita.
- Sem busca por raio ou geolocalização: `latitude` e `longitude` existem, mas estão vazias.
- O pet que já tem hospedagem no período não filtra a busca; a solicitação responde `409 PET_ALREADY_BOOKED`.
- `[provisório]` Agenda lida de `provider_blocked_dates` (um dia por linha) até a #482.

## Pets do Tutor: `/api/v1/me/pets`

Cadastro e listagem (Task #369, HSP-PBI-016-TSK-04), edição e exclusão (Task #371) dos pets do Tutor. Só Tutor tem pet: o pet aponta para `tutors.id`, e o TUTOR nasce na conclusão do perfil (`PUT /api/v1/me/tutor-profile`). Antes disso, todas as rotas respondem `403 PROFILE_INCOMPLETE`.

**Autenticação:** igual ao `/me`. O Tutor vem só do `sub` do JWT: um `tutorId` no body é recusado como campo fora do contrato, então ninguém cadastra pet para outro Tutor.

**Body do `POST`:**

```json
{
  "name": "Rex",
  "species": "dog",
  "breed": "Vira-lata",
  "size": "medium",
  "birthDate": "2020-03-15",
  "medicalNotes": "Alergia a frango",
  "behavioralNotes": "Medo de fogos"
}
```

| Campo | Regra |
| --- | --- |
| `name` | Obrigatório, até 255 caracteres |
| `species` | Obrigatório: `dog` ou `cat` \[provisório\] |
| `size` | Opcional: `small`, `medium` ou `large` \[provisório\] |
| `breed` | Opcional, até 100 caracteres |
| `birthDate` | Opcional, `YYYY-MM-DD`, data real e não futura (a idade é calculada a partir dela) |
| `medicalNotes`, `behavioralNotes` | Opcionais, texto livre até 2000 caracteres |
| Outros campos (inclusive `tutorId`) | Recusados com `400` (`não faz parte do contrato`) |

**Respostas:**

| Rota | Status | `code` | Caso |
| --- | --- | --- | --- |
| `POST` | `201` | — | Pet criado; devolve o pet (sem o `tutorId`) |
| `POST` | `400` | `VALIDATION_ERROR` | Todos os campos inválidos ou fora do domínio, em `details`. Nenhum pet é criado |
| `GET` | `200` | — | `{ items, page, pageSize, total }` com os pets ativos do Tutor |
| `GET` | `400` | `VALIDATION_ERROR` | `page` menor que 1 ou `pageSize` fora de 1 a 50 |
| `PUT /{id}` | `200` | — | Pet atualizado; devolve o pet |
| `PUT /{id}` | `400` | `VALIDATION_ERROR` | Mesmas regras do `POST`, todos os campos inválidos em `details`. Nada é alterado |
| `PUT /{id}` e `DELETE /{id}` | `404` | `NOT_FOUND` | Id fora do formato UUID, pet inexistente, de outro Tutor ou já desativado (mesma resposta, para não revelar que existe) |
| `DELETE /{id}` | `204` | — | Pet desativado |
| Todas | `403` | `PROFILE_INCOMPLETE` | O usuário ainda não é Tutor |
| Todas | `401` / `404` | `TOKEN_INVALID` / `USER_NOT_FOUND` | Igual ao `/me` |

- A listagem filtra pelo Tutor do token e por `active`: nunca devolve pet de outro Tutor. Padrão `page=1` e `pageSize=20`.
- O `PUT` substitui o pet inteiro, com o mesmo body e as mesmas regras do `POST`: campo opcional omitido volta a ser `null`. Para manter um dado, o app reenvia o valor atual.
- O `DELETE` é exclusão lógica (`active = false`): o pet some da listagem, da busca de Hosts e não pode ser usado em nova solicitação, mas continua no banco para o histórico das reservas. Desativar de novo responde `404`.

**Pendências:**

- \[assunção\] O `DELETE` não confere reservas: um pet com solicitação `requested` ou reserva `awaiting_payment`, `accepted` ou `checked_in` pode ser desativado, e essas reservas continuam valendo. A alternativa é recusar com `409` enquanto houver reserva em andamento. Decisão a fechar na #371.

- \[provisório\] Listas de espécie e porte só na aplicação (`src/pets/pet-policy.js`): a #366, que fecharia os domínios, foi removida. Alinhar com as espécies e portes aceitos pelo Host (#110) e levar para `CHECK` no banco quando forem aprovadas.
- Vacinas, alergias e medicações em texto livre (`medicalNotes`); foto e documentos do pet fora desta entrega (#370 removida).

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

- \[provisório\] `src/contracts/` só existe enquanto `/service-requests` e `/checkout` não têm implementação real: responde `501` para quem passa pela guarda. As tasks de reserva e checkout trocam o handler pelo controller real, mantendo a guarda e chamando `assertCanContract` no service, como já faz o `/reservations` (#494).
- Body e resposta de sucesso dessas duas rotas: definidos por essas tasks.

## Solicitação de hospedagem: `POST /api/v1/reservations`

O Tutor solicita hospedagem de um pet num serviço de um Host (Task #494, HSP-PBI-039-TSK-01). Passa pela guarda de contratação acima: só conta ativa com perfil `complete`.

**Header obrigatório:** `Idempotency-Key`, gerado pelo app para cada intenção de solicitar (um UUID, por exemplo) e repetido em toda nova tentativa. Até 100 letras, números, `-` ou `_`.

**Body:**

```json
{
  "serviceId": "uuid",
  "petId": "uuid",
  "startDate": "2026-11-10",
  "endDate": "2026-11-13",
  "notes": "Toma remédio às 8h"
}
```

| Campo | Regra |
| --- | --- |
| `serviceId` | Serviço ativo de um Host elegível (`hotel`, `active` e `approved`, a mesma regra do `GET /hosts/{id}`). O Host vem do serviço |
| `petId` | Pet ativo do próprio Tutor. Pet de outro Tutor responde igual ao inexistente |
| `startDate` | `YYYY-MM-DD`, hoje ou depois (dia em UTC) |
| `endDate` | `YYYY-MM-DD`, depois de `startDate`. Noites = `endDate` - `startDate` |
| `notes` | Opcional, até 1000 caracteres |
| Outros campos (inclusive `tutorId`) | Recusados com `400` (`não faz parte do contrato`) |

**Respostas:**

| Status | `code` | Caso |
| --- | --- | --- |
| `201` | — | Solicitação criada no estado `requested` (pendente) |
| `200` | — | Reenvio com a mesma `Idempotency-Key` e o mesmo body: devolve a mesma solicitação, sem criar outra |
| `400` | `VALIDATION_ERROR` | Todos os campos inválidos em `details`, incluindo o header, serviço ou pet inexistentes e pet não aceito pelo Host |
| `403` | `ACCOUNT_RESTRICTED` / `PROFILE_INCOMPLETE` | Guarda de contratação (#263) |
| `409` | `PERIOD_UNAVAILABLE` | Algum dia do período está bloqueado na agenda do Host (o dia da saída não conta) |
| `409` | `NO_CAPACITY` | Algum dia do período já está com todas as vagas do Host ocupadas por reservas aguardando pagamento, aceitas ou em andamento (#488) |
| `409` | `PET_ALREADY_BOOKED` | O pet já tem hospedagem que ocupa algum dia do período, com este ou outro Host. Solicitação só pendente não conta (#488) |
| `409` | `IDEMPOTENCY_KEY_REUSED` | A mesma chave já foi usada para outra intenção (outro serviço, pet, período ou observação) |
| `401` / `404` | `TOKEN_INVALID` / `USER_NOT_FOUND` | Igual ao `/me` |

```json
{
  "id": "uuid",
  "status": "requested",
  "hostId": "uuid",
  "serviceId": "uuid",
  "petId": "uuid",
  "startDate": "2026-11-10",
  "endDate": "2026-11-13",
  "dailyPrice": 120.5,
  "totalValue": 361.5,
  "notes": "Toma remédio às 8h",
  "createdAt": "2026-10-30T12:00:00.000Z"
}
```

- **Snapshot:** `dailyPrice` e `totalValue` são copiados do serviço no momento da solicitação. Se o Host mudar o preço depois, a solicitação não muda.
- **Pet aceito:** espécie, porte e raça do pet precisam estar nas listas do Host (`accepted_species`, `accepted_sizes`, `accepted_breeds`). Lista vazia = o Host não restringe.
- **Idempotência:** a chave fica gravada com `UNIQUE (tutor_id, idempotency_key)`. Dois envios simultâneos com a mesma chave criam uma única solicitação.
- A regra de contratação também é conferida no service (`assertCanContract`), e a gravação acontece numa transação junto com a checagem da agenda.

**Pendências:**

- \[provisório\] Agenda conferida pela `provider_blocked_dates` atual (um dia por linha). Ajustar se a #482 trocar o modelo do bloqueio.
- Capacidade do Host: conferida no aceite (#491), não na solicitação.

## Solicitações recebidas pelo Host: `GET /api/v1/me/host/reservations`

Lista das solicitações pendentes que o Host recebeu, para decidir (Task #485, HSP-PBI-041-TSK-01). A decisão de aceitar ou recusar é a #491.

**Autenticação:** igual ao `/me`. O Host vem só do `sub` do JWT (USER → `providers`); quem não tem linha em `providers` recebe `403 HOST_REQUIRED`. Vale para qualquer situação do Host (pendente, inativo), para ele seguir vendo o que já recebeu.

**Parâmetros:** `status` (só `requested`, o padrão), `page` (a partir de 1, padrão 1) e `pageSize` (1 a 50, padrão 20).

| Status | `code` | Caso |
| --- | --- | --- |
| `200` | — | `{ items, page, pageSize, total }`, da solicitação mais antiga para a mais nova; lista vazia quando não há pendentes |
| `400` | `VALIDATION_ERROR` | `status`, `page` ou `pageSize` inválidos, todos em `details` |
| `403` | `HOST_REQUIRED` | O usuário não é Host |
| `401` / `404` | `TOKEN_INVALID` / `USER_NOT_FOUND` | Igual ao `/me` |

```json
{
  "items": [
    {
      "id": "uuid",
      "status": "requested",
      "serviceId": "uuid",
      "startDate": "2026-11-10",
      "endDate": "2026-11-13",
      "dailyPrice": 120.5,
      "totalValue": 361.5,
      "notes": "Toma remédio às 8h",
      "createdAt": "2026-10-30T12:00:00.000Z",
      "tutor": { "name": "Ana" },
      "pet": { "name": "Rex", "species": "dog", "size": "medium", "breed": "Vira-lata", "medicalNotes": null, "behavioralNotes": null }
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1
}
```

- **Isolamento:** o filtro é pelos serviços do próprio Host (`service.provider_id`), então um Host nunca vê solicitação de outro.
- **LGPD:** do Tutor sai só o nome de exibição; CPF, telefone, e-mail e endereço não saem.

## Decisão do Host: `POST /api/v1/me/host/reservations/{id}/accept` e `/reject`

Aceite e recusa de uma solicitação pendente pelo Host (Task #491, HSP-PBI-042-TSK-01). Autenticação e papel iguais à lista do Host: quem não é Host recebe `403 HOST_REQUIRED`.

- **Aceitar** (sem body): vai para `awaiting_payment` (aguardando o pagamento do Tutor, HSP-DEC-004) se ainda houver vaga no período.
- **Recusar** (body `{ "reason": "..." }`, obrigatório, até 500 caracteres): vai para `rejected` com o motivo e registra o evento `reservation_rejected` para o Tutor em `notifications`, na mesma transação. A entrega é da FT-026.

| Status | `code` | Caso |
| --- | --- | --- |
| `200` | — | `{ id, status, decidedAt, rejectionReason }` |
| `400` | `VALIDATION_ERROR` | Recusa sem `reason`, com mais de 500 caracteres ou com campo fora do contrato |
| `403` | `HOST_REQUIRED` | O usuário não é Host |
| `404` | `NOT_FOUND` | Solicitação inexistente ou de outro Host (mesma resposta, para não revelar que existe) |
| `409` | `RESERVATION_ALREADY_DECIDED` | Já aceita ou recusada, inclusive quando outra decisão chegou antes ao mesmo tempo |
| `409` | `NO_CAPACITY` | Aceite sem vaga em algum dia do período (a ocupação é contada dia a dia) |
| `409` | `PET_ALREADY_BOOKED` | O pet já foi aceito por outro Host num período que se cruza com este (#488) |
| `409` | `PERIOD_UNAVAILABLE` | Aceite com algum dia do período bloqueado na agenda, mesmo que o bloqueio seja posterior à solicitação (#482) |
| `401` / `404` | `TOKEN_INVALID` / `USER_NOT_FOUND` | Igual ao `/me` |

- **Decisão única:** o status só muda com `WHERE status = 'requested'`. Com duas decisões ao mesmo tempo, o banco deixa só uma alterar a linha; a outra recebe `409` e nada dela fica gravado (nem a notificação).
- **Capacidade:** ocupam vaga as reservas do Host em `awaiting_payment`, `accepted` ou `checked_in` que cruzam o período (o dia da saída não conta). O limite é `hotel_details.capacity`. A linha do Host fica travada (`SELECT ... FOR UPDATE`) durante o aceite, então dois aceites ao mesmo tempo andam em fila e o segundo já conta a vaga do primeiro.

**Pendências:**

- \[provisório\] Host sem capacidade cadastrada atende um pet por vez. Exigir a capacidade no cadastro do Host.
- Sem prazo de expiração da solicitação (TBD na HSP-PBI-042).

## Agenda do Host: `GET /api/v1/me/host/agenda` e bloqueios

Rotas do próprio Host para consultar e bloquear a agenda (Task #482, HSP-PBI-036-TSK-01). Exigem ser Host (`403 HOST_REQUIRED`); o Host vem só do JWT.

| Rota | O que faz |
| --- | --- |
| `GET /api/v1/me/host/agenda?startDate&endDate` | Estado de cada dia do período: `free`, `blocked` ou `occupied` |
| `POST /api/v1/me/host/agenda/blocks` | Bloqueia de `startDate` até o dia antes de `endDate`, uma linha por dia |
| `DELETE /api/v1/me/host/agenda/blocks/{id}` | Libera um dia bloqueado |

```http
GET /api/v1/me/host/agenda?startDate=2026-11-10&endDate=2026-11-13
```

```json
{
  "startDate": "2026-11-10",
  "endDate": "2026-11-13",
  "capacity": 1,
  "days": [
    { "date": "2026-11-10", "status": "free", "occupied": 0 },
    { "date": "2026-11-11", "status": "blocked", "occupied": 0, "block": { "id": "uuid", "reason": "Reforma" } },
    { "date": "2026-11-12", "status": "occupied", "occupied": 1 }
  ]
}
```

- **Período:** `endDate` não entra, como nas reservas e na busca. Sem datas, a agenda vai de hoje até 30 dias; até 90 dias por consulta, passado permitido.
- **Estados:** `blocked` vence `occupied`. O dia é `occupied` quando as reservas `awaiting_payment`, `accepted` ou `checked_in` chegam à capacidade (1 se não cadastrada), o mesmo critério da busca. `occupied` traz a contagem em todos os dias.
- **Bloqueio:** body `{ "startDate", "endDate", "reason"? }`, sem passado, até 365 dias. Dia já bloqueado fica como está (com o motivo antigo). Responde `201` com `{ items: [{ id, date, reason }] }`, todos os dias bloqueados do período.
- **Bloqueio sobre hospedagem:** se alguma reserva que ocupa cair no período, responde `409 PERIOD_OCCUPIED` e nenhum dia é bloqueado. Solicitação só pendente não impede; o aceite dela passa a responder `409 PERIOD_UNAVAILABLE`.
- **Concorrência:** o bloqueio trava a linha do Host (`FOR UPDATE`), a mesma trava do aceite. Bloqueio e aceite do mesmo Host andam em fila.
- **Efeito:** dia bloqueado some da busca (#476) e recusa a solicitação (#494) e o aceite (#491) com `409 PERIOD_UNAVAILABLE`.

| Status | `code` | Caso |
| --- | --- | --- |
| `200` / `201` / `204` | — | Consulta, bloqueio e remoção |
| `400` | `VALIDATION_ERROR` | Todos os campos inválidos em `details`: data fora do formato, fim antes do início, passado no bloqueio, período longo demais, `reason` com mais de 500 caracteres e campos fora do contrato |
| `403` | `HOST_REQUIRED` | O usuário não é Host |
| `404` | `NOT_FOUND` | Bloqueio inexistente, de outro Host ou `id` fora do formato UUID (mesma resposta) |
| `409` | `PERIOD_OCCUPIED` | Bloqueio sobre período com hospedagem que ocupa |
| `401` / `404` | `TOKEN_INVALID` / `USER_NOT_FOUND` | Igual ao `/me` |

**Pendências:**

- Sem migration: usa `provider_blocked_dates` (um dia por linha, `UNIQUE (provider_id, date)`). A busca repete a regra em SQL; mudar o modelo exige mudar os dois juntos.
- Sem recorrência ("toda segunda") nem horário de funcionamento (`provider_working_hours`).
- Desbloqueio é por dia; desbloqueio por intervalo fica para quando o app precisar.

## Cadastro do Host: `/api/v1/me/host`

Rotas usadas por quem quer ser Host (Task #325, HSP-PBI-008-TSK-05). Contrato completo em `docs/openapi.yaml`.

**Autenticação:** igual ao `/me`. O dono vem só do JWT, então um usuário nunca alcança o cadastro de outro.

**Fluxo:**

1. `PUT /api/v1/me/host` salva o rascunho (`validation_status = draft`). A primeira chamada cria o prestador. `providerType` e `name` são sempre exigidos; campo omitido fica como está.
2. `GET /api/v1/me/host` devolve o cadastro para o app retomar de onde parou. CPF ou CNPJ volta mascarado, e a chave dos documentos nunca sai.
3. `POST /api/v1/me/host/documents` (campos `type` e `file`) e `POST /api/v1/me/host/photos` (campo `file`), em `multipart/form-data`, enviam um arquivo por requisição. O app não fala com o bucket: o back-end valida e grava.
4. `GET /api/v1/me/host/documents/{id}` devolve o link temporário do documento, só para o titular.
5. `POST /api/v1/me/host/submit` confere o cadastro. Se faltar algo, devolve `400` com tudo o que falta e nada muda. Se estiver completo, o perfil fica `pending` e a primeira foto vira a principal.

**Regras:**

- Só `approved` aparece na busca e nos detalhes públicos. `draft` e `pending` ficam de fora.
- Depois de enviado, o cadastro não edita mais: `409 HOST_ALREADY_SUBMITTED`.
- O tipo do arquivo é conferido pelo conteúdo. Documentos: PDF, JPEG ou PNG, até 10 MB e 5 arquivos por tipo. Fotos: JPEG, PNG ou WebP, até 5 MB e 10 fotos.
- Se o banco falhar depois do upload, o arquivo é apagado do bucket.
- Quem só tem rascunho ainda não acessa as rotas de Host (`403 HOST_REQUIRED`). Quem já enviou acessa.

**Pendências:**

- Administrador ainda não acessa os documentos: depende do fluxo de validação.
- Não há rota para apagar um arquivo enviado errado.
- \[assunção\] Só `providerType = hotel` e documentos obrigatórios `identity` e `proof_of_address`, mais `cnpj_card` para CNPJ: a #321, que fecharia isso, foi removida. Validar com a PO.
- Serviços ainda não entram no cadastro. Sem um serviço ativo, o Host aprovado não aparece na busca.
- \[assunção\] A "estrutura" do HSP-PBI-008-AC-01 fica na `description`, porque não tem campo próprio. Validar com a PO.
- Reenvio de cadastro rejeitado depende do fluxo de aprovação.

## Decisão da validação: `POST /api/v1/admin/provider-validations/{providerId}/approve` e `/reject`

Aprovação e reprovação de um cadastro pendente pelo Administrador (Task #404, HSP-PBI-022-TSK-04). A fila e o detalhe (#398) estão no `docs/openapi.yaml`.

**Autenticação:** JWT do usuário e papel Administrador (`403 ADMIN_REQUIRED`, guarda da #313). O autor da decisão vem só do token.

**Regras:**

- Só `pending` é decidido, uma única vez. A troca usa `updateMany ... WHERE validation_status = 'pending'`: com duas decisões ao mesmo tempo, só uma altera a linha e a outra recebe `409`.
- A aprovação vai para `approved`. O prestador passa a aparecer na busca e nos detalhes públicos e a receber solicitações (`ELIGIBLE_HOST`).
- A reprovação exige `reason` (até 500 caracteres, sem espaços nas pontas) e vai para `rejected`. O motivo aparece para o prestador em `GET /api/v1/me/host` (`rejectionReason`). Quem decidiu não aparece.
- `validation_decided_by`, `validation_decided_at`, `rejection_reason` e o evento em `notifications` (`provider_validation_approved` ou `provider_validation_rejected`, entrega pela HSP-PBI-064) são gravados na mesma transação. A FK do autor é `RESTRICT`, então o Administrador não pode ser apagado enquanto houver decisão dele.

| Situação | Resposta |
| --- | --- |
| Decisão gravada | `200` `{ providerId, validationStatus, decidedAt, rejectionReason }` |
| `providerId` fora do formato UUID, `reason` inválido ou campo fora do contrato | `400 VALIDATION_ERROR` com todos os `details` |
| Sem token | `401` |
| Sem o papel Administrador | `403 ADMIN_REQUIRED` |
| Cadastro inexistente ou em rascunho | `404 NOT_FOUND` |
| Já aprovado ou reprovado | `409 PROVIDER_ALREADY_DECIDED` |

**Pendências:**

- `[assunção]` A auditoria fica nas colunas do próprio cadastro (última decisão). A trilha imutável das ações administrativas é da HSP-PBI-023-TSK-01 (#413).
- `[assunção]` O Administrador pode decidir o próprio cadastro de prestador. Validar com a PO se precisa bloquear.
- O reenvio do cadastro reprovado ainda não existe. Quando existir, precisa limpar o motivo e guardar o histórico das decisões anteriores (a #403, que modelaria o histórico, foi removida).

## Deploy (Railway)

O back-end roda no Railway (projeto `superb-recreation`, serviço `backend`, ambiente `production`): https://backend-production-7298.up.railway.app. URLs e contratos para o Mobile estão na wiki, em Index/Desenvolvimento/Back-end/APIs publicadas - URLs e contratos.

- **Publicação:** o `azure-pipelines.yml` roda o CI (lint, `npm test` e `npm run test:integration` com um Postgres descartável) em cada PR para a `develop` e para a `main`, e a cada push na `develop` publica com `railway up --service backend` (Task #500), como o Auth. Branches de trabalho saem da `develop` e voltam por PR (ADR-014). Deploy manual, se precisar: `railway up --service backend`, com a pasta ligada ao projeto (`railway link`).
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
│   ├── lib/            # prisma.js (instância única do Prisma Client), app-error.js, jwt.js, cpf.js, address.js, cnpj.js, storage.js e fake-storage.js (bucket de arquivos)
│   ├── contracts/      # controller e service provisórios das rotas de contratação (respondem 501)
│   ├── hosts/          # controller e service dos detalhes públicos do Host e regras do Host (host-policy.js); cadastro do Host (host-profile.*, host-files.*)
│   ├── middlewares/    # service-token.js (rota interna), user-token.js (JWT do usuário), can-contract.js (guarda de contratação), upload-file.js (arquivo em multipart)
│   ├── tutors/         # controller e service da conclusão do perfil do Tutor
│   ├── pets/           # controller, service e domínios (pet-policy.js) dos pets do Tutor
│   ├── reservations/   # controllers e services da solicitação de hospedagem, da lista e da decisão do Host
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
│       ├── host-details.test.js # Detalhes públicos do Host: elegível, 404 e dados privados
│       ├── ready.test.js
│       ├── pets.test.js # Pets: cadastro, domínio inválido, tutorId de outro, isolamento e paginação
│       ├── reservations.test.js # Solicitação de hospedagem: snapshot, idempotência, pet aceito e agenda
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
