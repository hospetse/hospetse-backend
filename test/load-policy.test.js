// Trava de ambiente, flags e CPF do gerador de massa de carga (#577), sem banco.
import { test } from 'node:test';
import assert from 'node:assert';
import { cpfFromIndex, loadDatabaseUrl, parseLoadArgs, VOLUMES } from '../prisma/load/load-policy.js';
import { isValidCpf } from '../src/lib/cpf.js';

const local = 'postgresql://u:p@localhost:5432/hospetse_load?schema=public';

test('trava: aceita só banco local terminado em _load', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        const url = `postgresql://u:p@${host}:5432/hospetse_load`;
        assert.strictEqual(loadDatabaseUrl({ LOAD_DATABASE_URL: url }), url);
    }
});

test('trava: recusa Railway, banco sem _load, URL ausente ou inválida e produção', () => {
    const refused = [
        {},
        { DATABASE_URL: local },
        { LOAD_DATABASE_URL: 'postgresql://u:p@altaria.proxy.rlwy.net:16188/railway' },
        { LOAD_DATABASE_URL: 'postgresql://u:p@altaria.proxy.rlwy.net:16188/hospetse_load' },
        { LOAD_DATABASE_URL: 'postgresql://u:p@localhost:5432/hospetse' },
        { LOAD_DATABASE_URL: 'mysql://u:p@localhost:3306/hospetse_load' },
        { LOAD_DATABASE_URL: 'não é url' },
        { LOAD_DATABASE_URL: local, NODE_ENV: 'production' },
    ];
    for (const env of refused) assert.throws(() => loadDatabaseUrl(env), /^Error: Recusado/, JSON.stringify(env));
});

test('trava: a mensagem de erro não mostra a URL nem a senha', () => {
    assert.throws(() => loadDatabaseUrl({ LOAD_DATABASE_URL: 'postgresql://u:segredo@exemplo.com/hospetse_load' }),
        (error) => !error.message.includes('segredo') && !error.message.includes('exemplo.com/'));
});

test('flags: padrões, valores válidos e --clean-only', () => {
    assert.deepStrictEqual(parseLoadArgs([]), {
        errors: [],
        options: { cleanOnly: false, tutors: 10000, hosts: 1000, reservations: 20000, conversations: 2000 },
    });
    const { errors, options } = parseLoadArgs(['--tutors=50', '--reservations=0', '--clean-only']);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual([options.tutors, options.reservations, options.cleanOnly], [50, 0, true]);
});

test('flags: devolve todos os erros de uma vez', () => {
    const { errors } = parseLoadArgs(['--tutors=0', '--hosts=1.5', `--reservations=${VOLUMES.reservations.max + 1}`, '--pets=3', 'x']);
    assert.deepStrictEqual(errors, [
        '--tutors: inteiro de 1 a 1000000',
        '--hosts: inteiro de 1 a 100000',
        '--reservations: inteiro de 0 a 5000000',
        '--pets=3: flag desconhecida',
        'x: flag desconhecida',
    ]);
});

test('cpfFromIndex: válido e sem repetição em todo o intervalo usado', () => {
    const seen = new Set();
    for (const index of [0, 1, 9, 10, 99999, VOLUMES.tutors.max]) {
        const cpf = cpfFromIndex(index);
        assert.ok(isValidCpf(cpf), cpf);
        assert.ok(!seen.has(cpf));
        seen.add(cpf);
    }
});
