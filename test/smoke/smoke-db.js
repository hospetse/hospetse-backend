// Smoke check do banco (Prisma + PostgreSQL), estratégia commit_e_limpeza na tabela coupons.
//
// Códigos confirmados empiricamente com Prisma 6.19.0:
// - violação de CHECK (discountValue -1): PrismaClientUnknownRequestError, sem code;
//   a mensagem contém "check constraint" -> classificado como violacao_constraint.
// - schema inexistente (?schema=...): PrismaClientKnownRequestError, code P2021.
// - host inacessível (127.0.0.1:1): PrismaClientInitializationError, errorCode P1001.
//
// O relatório nunca inclui URL, host, usuário, senha nem a mensagem bruta do driver.
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

try {
    process.loadEnvFile();
} catch {
    // sem .env: segue; a etapa configuracao decide
}

const falhaEscrita = process.argv.includes('--falha-escrita');
const url = process.env.SMOKE_DATABASE_URL ?? process.env.DATABASE_URL;

const CATEGORIAS_POR_CODIGO = {
    P1000: 'falha_autenticacao',
    P1001: 'banco_inacessivel',
    P1002: 'timeout',
    P1008: 'timeout',
    P1003: 'banco_inexistente',
    P2021: 'tabela_ausente',
    P2022: 'coluna_ausente',
    CONFIG_AUSENTE: 'configuracao_ausente',
};

function classificar(err) {
    const codigo = err?.code ?? err?.errorCode ?? null;
    if (err?.categoria) return { categoria: err.categoria, codigo };
    if (codigo && CATEGORIAS_POR_CODIGO[codigo]) return { categoria: CATEGORIAS_POR_CODIGO[codigo], codigo };
    const mensagem = typeof err?.message === 'string' ? err.message : '';
    if (/check constraint/i.test(mensagem)) return { categoria: 'violacao_constraint', codigo };
    if (/permission denied/i.test(mensagem)) return { categoria: 'permissao_negada', codigo };
    return { categoria: 'erro_desconhecido', codigo };
}

function erroCom(campos) {
    return Object.assign(new Error(campos.categoria ?? campos.code ?? 'erro'), campos);
}

const etapas = [];

async function etapa(nome, fn, { pular = false } = {}) {
    if (pular) {
        etapas.push({ nome, estado: 'nao_executada', duracaoMs: 0 });
        return { ok: false };
    }
    const inicio = performance.now();
    try {
        const valor = await fn();
        etapas.push({ nome, estado: 'aprovada', duracaoMs: Math.round(performance.now() - inicio) });
        return { ok: true, valor };
    } catch (err) {
        etapas.push({ nome, estado: 'reprovada', duracaoMs: Math.round(performance.now() - inicio), ...classificar(err) });
        return { ok: false };
    }
}

function lerCommit() {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
    } catch {
        return null;
    }
}

function lerVersoesPrisma() {
    try {
        const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
        return { prisma: pkg.devDependencies?.prisma ?? null, prismaClient: pkg.dependencies?.['@prisma/client'] ?? null };
    } catch {
        return { prisma: null, prismaClient: null };
    }
}

async function main() {
    const versoes = { node: process.version, ...lerVersoesPrisma(), postgres: null };
    let prisma;
    let idCriado = null;
    let code = null;
    let residuoAposFalha = false;
    let resultadoLimpeza = 'nao_necessaria';

    try {
        const configuracao = await etapa('configuracao', () => {
            if (!url) throw erroCom({ code: 'CONFIG_AUSENTE' });
            prisma = new PrismaClient({ datasources: { db: { url } } });
        });

        const conexao = await etapa('conexao', () => prisma.$connect(), { pular: !configuracao.ok });

        const select1 = await etapa('select_1', () => prisma.$queryRaw`SELECT 1`, { pular: !conexao.ok });
        if (select1.ok) {
            try {
                const [linha] = await prisma.$queryRaw`SELECT version() AS version`;
                versoes.postgres = linha?.version ?? null;
            } catch {
                versoes.postgres = null;
                versoes.postgresConsulta = 'reprovada';
            }
        }

        const leitura = await etapa('leitura_coupons',
            () => prisma.coupon.findFirst({ select: { id: true, code: true } }),
            { pular: !select1.ok });

        const escrita = await etapa('escrita_commit', async () => {
            code = `smoke-${Date.now()}-${randomUUID()}`;
            const criado = await prisma.$transaction(async (tx) => tx.coupon.create({
                data: { code, discountType: 'fixed', discountValue: falhaEscrita ? -1 : 0, active: false },
                select: { id: true, code: true },
            }));
            idCriado = criado.id;
        }, { pular: !leitura.ok });

        await etapa('leitura_pos_commit', async () => {
            const lido = await prisma.coupon.findUnique({ where: { id: idCriado }, select: { id: true, code: true } });
            if (!lido || lido.code !== code) throw erroCom({ categoria: 'leitura_divergente' });
        }, { pular: !escrita.ok });
    } finally {
        // Escrita rejeitada: confirma que nada ficou gravado com o code tentado.
        if (idCriado == null && code != null && prisma) {
            try {
                const residuo = await prisma.coupon.findUnique({ where: { code }, select: { id: true } });
                if (residuo) {
                    idCriado = residuo.id;
                    residuoAposFalha = true;
                }
            } catch {
                // a etapa limpeza abaixo não roda; resíduo não confirmado
            }
        }

        await etapa('limpeza', async () => {
            try {
                await prisma.coupon.delete({ where: { id: idCriado } });
            } catch (err) {
                resultadoLimpeza = 'falha';
                throw erroCom({ categoria: 'falha_limpeza', code: err?.code ?? err?.errorCode ?? null });
            }
            const aindaExiste = await prisma.coupon.findUnique({ where: { id: idCriado }, select: { id: true } })
                .catch(() => {
                    resultadoLimpeza = 'falha';
                    throw erroCom({ categoria: 'falha_limpeza' });
                });
            if (aindaExiste) {
                resultadoLimpeza = 'falha';
                throw erroCom({ categoria: 'residuo' });
            }
            if (residuoAposFalha) {
                // a escrita foi rejeitada mas deixou registro: removido, porém reprova
                resultadoLimpeza = 'residuo_removido';
                throw erroCom({ categoria: 'residuo' });
            }
            resultadoLimpeza = 'removido';
        }, { pular: idCriado == null });

        if (prisma) await prisma.$disconnect().catch(() => {});
    }

    const codigoSaida = etapas.some((e) => e.estado === 'reprovada') ? 1 : 0;
    const relatorio = {
        dataHora: new Date().toISOString(),
        ambiente: process.env.NODE_ENV ?? 'development',
        commit: lerCommit(),
        versoes,
        estrategia: 'commit_e_limpeza',
        modo: falhaEscrita ? 'falha_escrita' : 'normal',
        etapas,
        resultadoLimpeza,
        codigoSaida,
    };
    console.log(JSON.stringify(relatorio, null, 2));
    process.exitCode = codigoSaida;
}

main().catch(() => {
    console.log(JSON.stringify({ erro: 'erro_desconhecido', codigoSaida: 1 }));
    process.exitCode = 1;
});
