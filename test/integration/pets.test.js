// Cadastro e listagem de pets do Tutor (TSK-04 #369), contra o PostgreSQL real. Exige DATABASE_URL.
// Cria USERs de teste (e-mail it-pet-...@exemplo.com); o Tutor nasce pelo PUT /api/v1/me/tutor-profile real.
// Remove pets, Tutores, endereços e USERs criados no after. O JWT é assinado por um par de chaves gerado aqui.
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
    const tutors = await prisma.tutor.findMany({ where: { userId: { in: userIds } }, select: { id: true, addressId: true } });
    await prisma.pet.deleteMany({ where: { tutorId: { in: tutors.map((t) => t.id) } } });
    await prisma.tutor.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.address.deleteMany({ where: { id: { in: tutors.map((t) => t.addressId).filter(Boolean) } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

// CPF válido aleatório, para não colidir com dados do banco de desenvolvimento
function randomCpf() {
    const base = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    for (let suffix = 0; suffix < 100; suffix++) {
        const cpf = base + String(suffix).padStart(2, '0');
        if (isValidCpf(cpf)) return cpf;
    }
    return randomCpf();
}

// USER recém-provisionado e o token dele; com tutor: true, conclui o perfil e vira Tutor
async function newUser({ tutor = true } = {}) {
    const authUserId = randomUUID();
    const user = await prisma.user.create({ data: { authUserId, email: `it-pet-${authUserId}@exemplo.com`, name: 'Teste Pets' } });
    userIds.push(user.id);
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(authUserId)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setExpirationTime('5m')
        .sign(privateKey);
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    if (tutor) {
        const res = await http.put('/api/v1/me/tutor-profile', {
            cpf: randomCpf(),
            birthDate: '1990-05-10',
            phone: '11999999999',
            emergencyContact: { name: 'Maria', phone: '11988888888' },
            address: { zipCode: '01001-000', street: 'Rua A', number: '10', neighborhood: 'Centro', city: 'São Paulo', state: 'SP' },
        }, auth);
        assert.strictEqual(res.status, 204, 'o Tutor de teste precisa concluir o perfil');
    }
    return { user, auth };
}

const validPet = { name: 'Rex', species: 'dog', breed: 'Vira-lata', size: 'medium', birthDate: '2020-03-15' };

test('Tutor cadastra pet: 201 com os dados e o pet fica vinculado a ele', async () => {
    const { user, auth } = await newUser();
    const res = await http.post('/api/v1/me/pets', { ...validPet, medicalNotes: 'Alergia a frango' }, auth);

    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(res.data, {
        id: res.data.id,
        name: 'Rex',
        species: 'dog',
        breed: 'Vira-lata',
        size: 'medium',
        birthDate: '2020-03-15',
        medicalNotes: 'Alergia a frango',
        behavioralNotes: null,
    });

    const saved = await prisma.pet.findUnique({ where: { id: res.data.id }, include: { tutor: true } });
    assert.strictEqual(saved.tutor.userId, user.id);
});

test('só os obrigatórios: nome e espécie bastam, o resto fica nulo', async () => {
    const { auth } = await newUser();
    const res = await http.post('/api/v1/me/pets', { name: 'Mia', species: 'cat' }, auth);

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.data.breed, null);
    assert.strictEqual(res.data.size, null);
    assert.strictEqual(res.data.birthDate, null);
});

test('tutorId de outro Tutor no body: 400, nenhum pet criado para nenhum dos dois', async () => {
    const owner = await newUser();
    const other = await newUser();
    const otherTutor = await prisma.tutor.findUnique({ where: { userId: other.user.id } });

    const res = await http.post('/api/v1/me/pets', { ...validPet, tutorId: otherTutor.id }, owner.auth);

    assert.strictEqual(res.status, 400);
    assert.ok(res.data.details.some((d) => d.field === 'tutorId'));
    const ownerTutor = await prisma.tutor.findUnique({ where: { userId: owner.user.id } });
    assert.strictEqual(await prisma.pet.count({ where: { tutorId: { in: [ownerTutor.id, otherTutor.id] } } }), 0);
});

test('campos ausentes: 400 com todos os obrigatórios e nada criado', async () => {
    const { user, auth } = await newUser();
    const res = await http.post('/api/v1/me/pets', {}, auth);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'VALIDATION_ERROR');
    assert.deepStrictEqual(res.data.details.map((d) => d.field), ['name', 'species']);
    const tutor = await prisma.tutor.findUnique({ where: { userId: user.id } });
    assert.strictEqual(await prisma.pet.count({ where: { tutorId: tutor.id } }), 0);
});

test('valores fora do domínio: 400 com cada campo identificado e nada criado', async () => {
    const { user, auth } = await newUser();
    const res = await http.post('/api/v1/me/pets', {
        name: 'Piu',
        species: 'bird',
        size: 'giant',
        birthDate: '2999-01-01',
    }, auth);

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data.details.map((d) => d.field), ['species', 'size', 'birthDate']);
    const tutor = await prisma.tutor.findUnique({ where: { userId: user.id } });
    assert.strictEqual(await prisma.pet.count({ where: { tutorId: tutor.id } }), 0);
});

test('perfil incompleto (sem Tutor): 403 PROFILE_INCOMPLETE para cadastrar e listar', async () => {
    const { auth } = await newUser({ tutor: false });
    const create = await http.post('/api/v1/me/pets', validPet, auth);
    const list = await http.get('/api/v1/me/pets', auth);

    for (const res of [create, list]) {
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.data.code, 'PROFILE_INCOMPLETE');
    }
});

test('isolamento: a listagem nunca devolve pet de outro Tutor', async () => {
    const ana = await newUser();
    const bruno = await newUser();
    await http.post('/api/v1/me/pets', { name: 'Pet da Ana', species: 'dog' }, ana.auth);
    await http.post('/api/v1/me/pets', { name: 'Pet do Bruno', species: 'cat' }, bruno.auth);

    const res = await http.get('/api/v1/me/pets', ana.auth);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.total, 1);
    assert.deepStrictEqual(res.data.items.map((p) => p.name), ['Pet da Ana']);
});

test('listagem paginada e só com pets ativos', async () => {
    const { user, auth } = await newUser();
    for (const name of ['A', 'B', 'C']) {
        await http.post('/api/v1/me/pets', { name, species: 'dog' }, auth);
    }
    const tutor = await prisma.tutor.findUnique({ where: { userId: user.id } });
    await prisma.pet.updateMany({ where: { tutorId: tutor.id, petName: 'C' }, data: { active: false } });

    const first = await http.get('/api/v1/me/pets?page=1&pageSize=1', auth);
    const second = await http.get('/api/v1/me/pets?page=2&pageSize=1', auth);

    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.data.total, 2);
    assert.strictEqual(first.data.items.length, 1);
    assert.strictEqual(second.data.items.length, 1);
    assert.notStrictEqual(first.data.items[0].id, second.data.items[0].id);
    assert.ok(![...first.data.items, ...second.data.items].some((p) => p.name === 'C'));
});

test('paginação inválida: 400 em page e pageSize', async () => {
    const { auth } = await newUser();
    const res = await http.get('/api/v1/me/pets?page=0&pageSize=500', auth);

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data.details.map((d) => d.field), ['page', 'pageSize']);
});
