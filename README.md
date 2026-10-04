# Hospetse — Back-end

API do back-end do Hospetse (plataforma de hospedagem e cuidado de pets), construída em Node.js + Express.

As decisões de arquitetura do projeto (por que Express, ES Modules, estratégia de testes, etc.) estão documentadas na [wiki do projeto](https://dev.azure.com/escola-ti/Hospetse/_wiki/wikis/Hospetse.wiki/55/Arquitetura) (ADR-001 a ADR-010).

## Pré-requisitos

- **Node.js 20.6 ou superior** (o projeto usa `process.loadEnvFile`, recurso nativo do Node introduzido nessa versão — ver ADR-009/ADR-010 na wiki).
- npm (instalado junto com o Node).

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
| `DATABASE_URL` | String de conexão do PostgreSQL usada pelo Prisma | `postgresql://postgres:senha@localhost:5432/hospetse?schema=public` |

> O arquivo `.env` nunca deve ser commitado (já está no `.gitignore`). Segredos e configuração de ambiente ficam só localmente ou no painel da plataforma de deploy.

## Rodando o projeto

```bash
npm run dev     # desenvolvimento, com reload automático a cada alteração (nodemon)
npm start       # produção, sem reload automático
```

Depois de subir, confirme que está no ar:

```bash
curl http://localhost:3000/health
```

## Scripts disponíveis

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Sobe o servidor em modo desenvolvimento (reload automático) |
| `npm start` | Sobe o servidor em modo produção |
| `npm run lint` | Roda o ESLint sobre o projeto, apontando problemas de código |
| `npm test` | Roda a suíte de testes automatizados (test runner nativo do Node) |

## Estrutura do projeto

```text
.
├── app.js              # Define o Express e as rotas (sem subir servidor)
├── index.js            # Importa o app e chama .listen() — ponto de entrada real
├── eslint.config.js    # Configuração do linter
├── prisma.config.ts    # Configuração do Prisma CLI (schema, migrações e DATABASE_URL)
├── tsconfig.json       # Só para o editor resolver os tipos do prisma.config.ts
├── prisma/
│   ├── schema.prisma   # Modelo de dados (fonte da verdade do banco)
│   └── migrations/     # Histórico de migrações SQL versionadas
├── test/
│   └── app.test.js     # Testes automatizados (node:test)
├── .env.example        # Modelo das variáveis de ambiente necessárias
└── package.json
```

`app.js` e `index.js` são propositalmente separados: isso permite que os testes importem o `app` sem disparar o efeito colateral de abrir uma porta de rede real (ver ADR-010 na wiki para detalhes).

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

```bash
# 1. Primeira vez: aplica todas as migrações no banco local e gera o Prisma Client
npx prisma migrate dev

# 2. Alterou o schema.prisma? Gere uma nova migração com nome descritivo
npx prisma migrate dev --name adiciona-campo-x

# 3. Ambientes compartilhados (homologação/produção): só aplica as migrações pendentes
npx prisma migrate deploy

# Utilitários
npx prisma validate          # valida o schema.prisma
npx prisma generate          # regera o Prisma Client
npx prisma migrate status    # mostra quais migrações estão pendentes no banco
npx prisma migrate reset     # APAGA o banco local e reaplica tudo (só em desenvolvimento)
```

> `migrate dev` e `migrate reset` são só para desenvolvimento local: eles podem pedir para recriar o banco. Em ambientes com dados reais use sempre `migrate deploy`.

Sempre revise o `migration.sql` gerado antes de commitar. Se o Prisma gerar comandos que você não esperava (por exemplo `DROP`), o `schema.prisma` provavelmente está divergente do que as migrações anteriores criaram.

## Testes

```bash
npm test
```

Os testes usam o test runner nativo do Node (`node:test` + `node:assert`), sem framework externo — decisão registrada na ADR-010. Cada teste sobe o `app` numa porta efêmera (evitando conflito com o servidor de desenvolvimento ou outros testes rodando em paralelo).
