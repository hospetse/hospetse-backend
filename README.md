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
├── test/
│   └── app.test.js     # Testes automatizados (node:test)
├── .env.example        # Modelo das variáveis de ambiente necessárias
└── package.json
```

`app.js` e `index.js` são propositalmente separados: isso permite que os testes importem o `app` sem disparar o efeito colateral de abrir uma porta de rede real (ver ADR-010 na wiki para detalhes).

## Persistência de dados

> ⚠️ **Pendente de alinhamento com o time.** Hoje o projeto ainda não tem camada de persistência implementada. A decisão de usar **Prisma + PostgreSQL** já está registrada (ADR-002 e ADR-003 na wiki), e a integração está prevista junto com a HSP-PBI-028 (#130). Falta alinhar com o Raul Jorge (revisor técnico) como essa integração encaixa na estrutura atual do back-end antes de implementar.

## Testes

```bash
npm test
```

Os testes usam o test runner nativo do Node (`node:test` + `node:assert`), sem framework externo — decisão registrada na ADR-010. Cada teste sobe o `app` numa porta efêmera (evitando conflito com o servidor de desenvolvimento ou outros testes rodando em paralelo).
