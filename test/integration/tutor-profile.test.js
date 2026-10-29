// PUT /api/v1/me/tutor-profile e o /me em seguida, contra o PostgreSQL real. Exige DATABASE_URL.
// Cria USERs de teste (e-mail it-...@exemplo.com) e remove tudo o que criou no after.
// O JWT é assinado por um par de chaves gerado aqui: não depende do Auth.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { prisma } from '../../src/lib/prisma.js';
import { isValidCpf } from '../../src/lib/cpf.js';

try {
    process.loadEnvFile();
} catch {
    // sem .env: a verificação abaixo falha com mensagem clara
}
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL ausente: configure o .env para rodar os testes de integração');
}

const { publicKey, privateKey } = await generateKeyPair('RS256');
process.env.JWT_PUBLIC_KEY = await exportSPKI(publicKey);

const { default: app } = await import('../../src/app.js');
const server = app.listen(0);
await once(server, 'listening');
const http = axios.create({ baseURL: `http://localhost:${server.address().port}`, validateStatus: () => true });

const userIds = [];

after(async () => {
    server.close();
    const tutors = await prisma.tutor.findMany({ where: { userId: { in: userIds } }, select: { addressId: true } });
    await prisma.tutor.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.address.deleteMany({ where: { id: { in: tutors.map((t) => t.addressId).filter(Boolean) } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

// USER recém-provisionado (sem Tutor) e o token dele
async function newUser() {
    const authUserId = randomUUID();
    const user = await prisma.user.create({ data: { authUserId, email: `it-${authUserId}@exemplo.com`, name: 'Teste Integração' } });
    userIds.push(user.id);
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(authUserId)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setExpirationTime('5m')
        .sign(privateKey);
    return { user, auth: { headers: { Authorization: `Bearer ${token}` } } };
}

// CPF válido aleatório, para não colidir com dados do banco de desenvolvimento
function randomCpf() {
    const base = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    for (let suffix = 0; suffix < 100; suffix++) {
        const cpf = base + String(suffix).padStart(2, '0');
        if (isValidCpf(cpf)) return cpf;
    }
    return randomCpf(); // base com todos os dígitos iguais
}

const validBody = (cpf) => ({
    cpf: `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`,
    birthDate: '1990-05-10',
    phone: '11999999999',
    emergencyContact: { name: 'Maria', phone: '11988888888' },
    address: { zipCode: '01001-000', street: 'Rua A', number: '10', neighborhood: 'Centro', city: 'São Paulo', state: 'sp' },
});

test('sem token: 401', async () => {
    const res = await http.put('/api/v1/me/tutor-profile', validBody(randomCpf()));
    assert.strictEqual(res.status, 401);
});

test('payload inválido: 400 com todos os campos e nada gravado', async () => {
    const { user, auth } = await newUser();
    const res = await http.put('/api/v1/me/tutor-profile', {
        cpf: '111.111.111-11',
        birthDate: '2015-01-01',
        phone: '123',
        address: { zipCode: '1' },
    }, auth);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'VALIDATION_ERROR');
    const fields = res.data.details.map((d) => d.field);
    for (const field of ['cpf', 'birthDate', 'phone', 'emergencyContact', 'address.zipCode', 'address.street', 'address.state']) {
        assert.ok(fields.includes(field), `faltou ${field} em details`);
    }
    assert.ok(!JSON.stringify(res.data).includes('111.111.111-11'), 'o CPF recebido não pode voltar na resposta');

    assert.strictEqual(await prisma.tutor.findUnique({ where: { userId: user.id } }), null);
    const saved = await prisma.user.findUnique({ where: { id: user.id } });
    assert.strictEqual(saved.profileStatus, 'incomplete');
});

test('dados válidos: 204, perfil complete e /me libera a contratação', async () => {
    const { user, auth } = await newUser();
    const cpf = randomCpf();

    const before = await http.get('/api/v1/me', auth);
    assert.strictEqual(before.data.permissions.canContract, false);
    assert.strictEqual(before.data.profile.missingFields.length, 5);

    const res = await http.put('/api/v1/me/tutor-profile', validBody(cpf), auth);
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.data, '');

    const me = await http.get('/api/v1/me', auth);
    assert.strictEqual(me.data.profile.status, 'complete');
    assert.deepStrictEqual(me.data.profile.missingFields, []);
    assert.strictEqual(me.data.permissions.canContract, true);

    const tutor = await prisma.tutor.findUnique({ where: { userId: user.id }, include: { address: true, user: true } });
    assert.strictEqual(tutor.cpf, cpf); // só os 11 dígitos
    assert.strictEqual(tutor.name, 'Teste Integração'); // veio do USER
    assert.strictEqual(tutor.address.zipCode, '01001000');
    assert.strictEqual(tutor.address.state, 'SP');
    assert.ok(tutor.user.profileCompletedAt instanceof Date);
});

test('segundo PUT atualiza o mesmo endereço e mantém profileCompletedAt', async () => {
    const { user, auth } = await newUser();
    const cpf = randomCpf();
    await http.put('/api/v1/me/tutor-profile', validBody(cpf), auth);
    const first = await prisma.tutor.findUnique({ where: { userId: user.id }, include: { user: true } });

    const body = validBody(cpf); // o próprio CPF de novo não conta como duplicado
    body.address.street = 'Rua B';
    const res = await http.put('/api/v1/me/tutor-profile', body, auth);
    assert.strictEqual(res.status, 204);

    const second = await prisma.tutor.findUnique({ where: { userId: user.id }, include: { address: true, user: true } });
    assert.strictEqual(second.addressId, first.addressId);
    assert.strictEqual(second.address.street, 'Rua B');
    assert.deepStrictEqual(second.user.profileCompletedAt, first.user.profileCompletedAt);
});

test('CPF de outro usuário: 400 em cpf e o perfil do outro não muda', async () => {
    const owner = await newUser();
    const cpf = randomCpf();
    await http.put('/api/v1/me/tutor-profile', validBody(cpf), owner.auth);

    const other = await newUser();
    const res = await http.put('/api/v1/me/tutor-profile', validBody(cpf), other.auth);
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data.details, [{ field: 'cpf', message: 'CPF já cadastrado' }]);

    assert.strictEqual(await prisma.tutor.findUnique({ where: { userId: other.user.id } }), null);
    const ownerTutor = await prisma.tutor.findUnique({ where: { userId: owner.user.id } });
    assert.strictEqual(ownerTutor.cpf, cpf);
});

// Cenários isolados da TSK-07 (#278): um erro por vez, o resto do body válido.
async function expectOnlyError(body, field, message) {
    const { user, auth } = await newUser();
    const res = await http.put('/api/v1/me/tutor-profile', body, auth);
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data.details, [{ field, message }]);
    const saved = await prisma.user.findUnique({ where: { id: user.id } });
    assert.strictEqual(saved.profileStatus, 'incomplete');
}

test('CPF com dígito verificador errado: 400 só em cpf', async () => {
    const cpf = randomCpf();
    const wrongDigit = cpf.slice(0, 10) + ((Number(cpf[10]) + 1) % 10);
    await expectOnlyError({ ...validBody(cpf), cpf: wrongDigit }, 'cpf', 'CPF inválido');
});

test('menor de 18 anos: 400 só em birthDate', async () => {
    const today = new Date();
    const seventeen = `${today.getUTCFullYear() - 17}-01-01`;
    await expectOnlyError({ ...validBody(randomCpf()), birthDate: seventeen }, 'birthDate', 'idade mínima de 18 anos');
});

test('body vazio: 400 com todos os campos obrigatórios', async () => {
    const { auth } = await newUser();
    const res = await http.put('/api/v1/me/tutor-profile', {}, auth);
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data.details.map((d) => d.field), ['cpf', 'birthDate', 'phone', 'emergencyContact', 'address']);
});

test('titular diferente: cada um só altera o próprio perfil', async () => {
    const ana = await newUser();
    const bruno = await newUser();
    const anaCpf = randomCpf();
    await http.put('/api/v1/me/tutor-profile', validBody(anaCpf), ana.auth);

    const brunoBody = validBody(randomCpf());
    brunoBody.address.street = 'Rua do Bruno';
    const res = await http.put('/api/v1/me/tutor-profile', brunoBody, bruno.auth);
    assert.strictEqual(res.status, 204);

    const anaTutor = await prisma.tutor.findUnique({ where: { userId: ana.user.id }, include: { address: true } });
    assert.strictEqual(anaTutor.cpf, anaCpf);
    assert.strictEqual(anaTutor.address.street, 'Rua A');
    const brunoTutor = await prisma.tutor.findUnique({ where: { userId: bruno.user.id }, include: { address: true } });
    assert.notStrictEqual(brunoTutor.addressId, anaTutor.addressId);
});

// Guarda de contratação da #263 com USERs reais. As rotas ainda são provisórias: quem passa pela guarda recebe 501.
const CONTRACT_ROUTES = ['/api/v1/reservations', '/api/v1/service-requests', '/api/v1/checkout'];

test('perfil complete passa pela guarda da #263 e incompleto recebe 403 PROFILE_INCOMPLETE', async () => {
    const { auth } = await newUser();
    for (const route of CONTRACT_ROUTES) {
        const res = await http.post(route, null, auth);
        assert.strictEqual(res.status, 403, route);
        assert.deepStrictEqual(res.data, { code: 'PROFILE_INCOMPLETE', message: 'Complete seu perfil antes de contratar um serviço.' });
    }

    await http.put('/api/v1/me/tutor-profile', validBody(randomCpf()), auth);
    for (const route of CONTRACT_ROUTES) {
        const res = await http.post(route, null, auth);
        assert.strictEqual(res.status, 501, route);
        assert.strictEqual(res.data.code, 'NOT_IMPLEMENTED');
    }
});

test('conta suspensa com perfil complete: 403 ACCOUNT_RESTRICTED, diferente do perfil incompleto', async () => {
    const { user, auth } = await newUser();
    await http.put('/api/v1/me/tutor-profile', validBody(randomCpf()), auth);
    await prisma.user.update({ where: { id: user.id }, data: { status: 'suspended' } });

    for (const route of CONTRACT_ROUTES) {
        const res = await http.post(route, null, auth);
        assert.strictEqual(res.status, 403, route);
        assert.strictEqual(res.data.code, 'ACCOUNT_RESTRICTED');
    }
    const me = await http.get('/api/v1/me', auth);
    assert.strictEqual(me.status, 200); // navegação continua liberada
    assert.strictEqual(me.data.permissions.canContract, false);
});
