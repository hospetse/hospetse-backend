// Testes de integração contra o PostgreSQL real (exigem DATABASE_URL).
// Escritas só na tabela coupons, com code único smoke-..., removidas pelo id.
// Permissão negada não é coberta: exigiria um usuário restrito no banco.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

try {
    process.loadEnvFile();
} catch {
    // sem .env: a verificação abaixo falha com mensagem clara
}
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL ausente: configure o .env para rodar os testes de integração');
}

const URL_INACESSIVEL = 'postgresql://x:x@127.0.0.1:1/x?connect_timeout=3';

const prisma = new PrismaClient();
after(() => prisma.$disconnect());

const novoCode = () => `smoke-${Date.now()}-${randomUUID()}`;

async function cicloCommitLimpeza() {
    const code = novoCode();
    let id = null;
    try {
        const criado = await prisma.$transaction(async (tx) => tx.coupon.create({
            data: { code, discountType: 'fixed', discountValue: 0, active: false },
            select: { id: true, code: true },
        }));
        id = criado.id;

        const lido = await prisma.coupon.findUnique({ where: { id }, select: { code: true } });
        assert.ok(lido, 'registro não encontrado após commit');
        assert.strictEqual(lido.code, code);

        await prisma.coupon.delete({ where: { id } });
        const removido = await prisma.coupon.findUnique({ where: { id } });
        assert.strictEqual(removido, null);
        id = null;
        return code;
    } finally {
        // só o registro criado por este ciclo, pelo id
        if (id != null) await prisma.coupon.delete({ where: { id } }).catch(() => {});
    }
}

test('SELECT 1', async () => {
    const linhas = await prisma.$queryRaw`SELECT 1 AS ok`;
    assert.strictEqual(linhas.length, 1);
});

test('leitura de coupons aceita tabela vazia', async () => {
    const primeiro = await prisma.coupon.findFirst({ select: { id: true, code: true } });
    assert.ok(primeiro === null || typeof primeiro.id === 'string');
});

test('escrita com commit, leitura fora da transação e remoção pelo id', async () => {
    await cicloCommitLimpeza();
});

test('escrita violando CHECK é rejeitada e não deixa resíduo', async () => {
    const code = novoCode();
    await assert.rejects(
        prisma.$transaction(async (tx) => tx.coupon.create({
            data: { code, discountType: 'fixed', discountValue: -1, active: false },
        })),
        (err) => /check constraint/i.test(err.message),
        'esperava violação de CHECK',
    );
    const residuo = await prisma.coupon.findUnique({ where: { code } });
    assert.strictEqual(residuo, null);
});

test('duas execuções seguidas sem conflito de code', async () => {
    const primeiro = await cicloCommitLimpeza();
    const segundo = await cicloCommitLimpeza();
    assert.notStrictEqual(primeiro, segundo);
});

test('schema inexistente gera P2021', async () => {
    const u = new URL(process.env.DATABASE_URL);
    u.searchParams.set('schema', 'schema_inexistente_smoke');
    const cliente = new PrismaClient({ datasources: { db: { url: u.toString() } } });
    try {
        await assert.rejects(cliente.coupon.findFirst(), (err) => err.code === 'P2021', 'esperava P2021');
    } finally {
        await cliente.$disconnect();
    }
});

test('URL inacessível gera P1001', async () => {
    const cliente = new PrismaClient({ datasources: { db: { url: URL_INACESSIVEL } } });
    try {
        await assert.rejects(cliente.$connect(), (err) => (err.errorCode ?? err.code) === 'P1001', 'esperava P1001');
    } finally {
        await cliente.$disconnect();
    }
});
