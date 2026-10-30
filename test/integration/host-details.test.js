// GET /api/v1/hosts/:id (HSP-PBI-031-TSK-01 #479) contra o PostgreSQL real. Exige DATABASE_URL.
// Cria USERs (e-mail it-...@exemplo.com) e prestadores de teste, e remove tudo o que criou no after.
// O JWT é assinado por um par de chaves gerado aqui: não depende do Auth.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { prisma } from '../../src/lib/prisma.js';

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
const providerIds = [];
const addressIds = [];

after(async () => {
    server.close();
    // fotos e detalhes saem em cascata com o prestador; serviços não
    await prisma.service.deleteMany({ where: { providerId: { in: providerIds } } });
    await prisma.provider.deleteMany({ where: { id: { in: providerIds } } });
    await prisma.address.deleteMany({ where: { id: { in: addressIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

async function newUser() {
    const authUserId = randomUUID();
    const user = await prisma.user.create({ data: { authUserId, email: `it-${authUserId}@exemplo.com`, name: 'Teste Integração' } });
    userIds.push(user.id);
    return user;
}

// Tutor que consulta: só precisa de um USER e do token dele
const viewer = await newUser();
const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(viewer.authUserId)
    .setIssuer('hospetse-auth-service')
    .setAudience('hospetse-backend')
    .setExpirationTime('5m')
    .sign(privateKey);
const auth = { headers: { Authorization: `Bearer ${token}` } };

// Host com endereço completo, documento, fotos e serviços; o que muda entre os casos vem em overrides
async function newHost(overrides = {}) {
    const owner = await newUser();
    const address = await prisma.address.create({
        data: { zipCode: '05422000', street: 'Rua Privada', number: '123', neighborhood: 'Pinheiros', city: 'São Paulo', state: 'SP' },
    });
    addressIds.push(address.id);
    const provider = await prisma.provider.create({
        data: {
            userId: owner.id,
            providerType: 'hotel',
            name: 'Hotelzinho de Teste',
            cpfCnpj: String(Date.now()).slice(-11) + String(providerIds.length),
            addressId: address.id,
            rating: 4.5,
            urlPicture: 'https://exemplo.com/perfil.jpg',
            status: 'active',
            validationStatus: 'approved',
            description: 'Casa com quintal',
            acceptedSpecies: ['dog', 'cat'],
            acceptedSizes: ['small', 'medium'],
            acceptedBreeds: [],
            photos: { create: [{ url: 'https://exemplo.com/1.jpg' }] },
            services: {
                create: [
                    { name: 'Diária premium', price: 200 },
                    { name: 'Diária', price: 120.5 },
                    { name: 'Serviço desativado', price: 10, active: false },
                ],
            },
            ...overrides,
        },
    });
    providerIds.push(provider.id);
    return { provider, owner, address };
}

test('sem token: 401', async () => {
    const { provider } = await newHost();
    const res = await http.get(`/api/v1/hosts/${provider.id}`);
    assert.strictEqual(res.status, 401);
});

test('Host elegível: 200 com os dados públicos e só os serviços ativos, do mais barato ao mais caro', async () => {
    const { provider } = await newHost();
    const res = await http.get(`/api/v1/hosts/${provider.id}`, auth);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, {
        id: provider.id,
        name: 'Hotelzinho de Teste',
        description: 'Casa com quintal',
        pictureUrl: 'https://exemplo.com/perfil.jpg',
        location: { city: 'São Paulo', neighborhood: 'Pinheiros' },
        photos: ['https://exemplo.com/1.jpg'],
        accepts: { species: ['dog', 'cat'], sizes: ['small', 'medium'], breeds: [] },
        services: [
            { id: res.data.services[0].id, name: 'Diária', price: 120.5 },
            { id: res.data.services[1].id, name: 'Diária premium', price: 200 },
        ],
        reputation: { rating: 4.5, reviewCount: 0 },
    });
});

test('nenhum dado privado na resposta: documento, e-mail, endereço completo e ids internos', async () => {
    const { provider, owner, address } = await newHost();
    const res = await http.get(`/api/v1/hosts/${provider.id}`, auth);
    const body = JSON.stringify(res.data);

    assert.strictEqual(res.status, 200);
    for (const value of [provider.cpfCnpj, owner.email, owner.id, address.id, address.street, address.zipCode]) {
        assert.ok(!body.includes(value), `a resposta trouxe ${value}`);
    }
});

// HSP-PBI-031-TSK-03 (#481): Host recém-aprovado, sem avaliações e só com o obrigatório
test('Host sem avaliações e sem dados opcionais: 200 com nulos e listas vazias', async () => {
    const { provider } = await newHost({
        rating: null,
        description: null,
        urlPicture: null,
        addressId: null,
        acceptedSpecies: [],
        acceptedSizes: [],
        photos: undefined,
        services: undefined,
    });
    const res = await http.get(`/api/v1/hosts/${provider.id}`, auth);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data, {
        id: provider.id,
        name: 'Hotelzinho de Teste',
        description: null,
        pictureUrl: null,
        location: { city: null, neighborhood: null },
        photos: [],
        accepts: { species: [], sizes: [], breeds: [] },
        services: [],
        reputation: { rating: null, reviewCount: 0 },
    });
});

test('Host não elegível ou inexistente: o mesmo 404', async () => {
    const pending = await newHost({ validationStatus: 'pending' });
    const rejected = await newHost({ validationStatus: 'rejected' });
    const inactive = await newHost({ status: 'inactive' });
    const sitter = await newHost({ providerType: 'pet_sitter' });

    const ids = [pending, rejected, inactive, sitter].map(({ provider }) => provider.id);
    for (const id of [...ids, randomUUID(), 'nao-e-uuid']) {
        const res = await http.get(`/api/v1/hosts/${id}`, auth);
        assert.strictEqual(res.status, 404, `${id} respondeu ${res.status}`);
        assert.deepStrictEqual(res.data, { code: 'NOT_FOUND', message: 'Host não encontrado' });
    }
});
