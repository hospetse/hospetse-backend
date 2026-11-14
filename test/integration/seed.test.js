import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { accounts } from '../../prisma/seed-accounts.js';
import { pets, hosts } from '../../prisma/seed-data.js';

const day = (offset) => new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const hostId = Object.fromEntries(hosts.map((host) => [host.key, host.provider.id]));

test('seed #497/#498: criação, idempotência, HTTP, busca, agenda e rollback', { skip: !process.env.SEED_TEST_DATABASE_URL }, async t => {
    const url = new URL(process.env.SEED_TEST_DATABASE_URL);
    assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname.endsWith('_seed_test'), 'Use banco local descartável terminado em _seed_test.');
    process.env.DATABASE_URL = url.href;
    const { prisma } = await import('../../src/lib/prisma.js');
    assert.equal(await prisma.user.count(), 0, 'O teste exige banco vazio.');
    const seed = () => spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'seed'], { env: process.env, encoding: 'utf8' });
    const snapshot = async () => ({
        users: await prisma.user.findMany({ orderBy: { authUserId: 'asc' } }),
        tutors: await prisma.tutor.findMany(), addresses: await prisma.address.findMany(),
        pets: await prisma.pet.findMany({ orderBy: { id: 'asc' } }),
    });
    // Contagens dos dados de Host (#498): a segunda execução não pode aumentar nenhuma
    const hostCounts = async () => ({
        providers: await prisma.provider.count(), services: await prisma.service.count(), details: await prisma.hotelDetail.count(),
        photos: await prisma.providerPhoto.count(), blocked: await prisma.providerBlockedDate.count(), reservations: await prisma.reservation.count(),
    });
    t.after(async () => {
        // reservas antes dos pets e dos serviços; fotos, bloqueios e hotel_details saem em cascata com o prestador
        const providerIds = hosts.map((host) => host.provider.id);
        await prisma.reservation.deleteMany({ where: { id: { in: hosts.flatMap((host) => host.occupied?.reservationId ?? []) } } });
        await prisma.service.deleteMany({ where: { providerId: { in: providerIds } } });
        await prisma.provider.deleteMany({ where: { id: { in: providerIds } } });
        await prisma.address.deleteMany({ where: { id: { in: hosts.map((host) => host.address.id) } } });
        await prisma.pet.deleteMany({ where: { id: { in: pets.map(pet => pet.id) } } });
        const tutors = await prisma.tutor.findMany({ where: { user: { authUserId: { in: accounts.map(a => a.id) } } } });
        await prisma.tutor.deleteMany({ where: { id: { in: tutors.map(tutor => tutor.id) } } });
        await prisma.address.deleteMany({ where: { id: { in: tutors.map(tutor => tutor.addressId).filter(Boolean) } } });
        await prisma.user.deleteMany({ where: { authUserId: { in: accounts.map(a => a.id) } } });
        await prisma.$disconnect();
    });
    const initial = seed();
    assert.equal(initial.status, 0, `Primeira execução falhou: ${initial.stderr}`);
    const first = await snapshot();
    const firstHostCounts = await hostCounts();
    assert.equal(seed().status, 0, 'Segunda execução falhou.');
    const second = await snapshot();
    for (const table of ['users', 'tutors', 'addresses', 'pets']) {
        assert.deepEqual(second[table].map(row => row.id), first[table].map(row => row.id));
    }
    assert.deepEqual(await hostCounts(), firstHostCounts, 'Reexecutar não pode duplicar dados de Host.');
    assert.deepEqual(firstHostCounts, {
        providers: hosts.length, services: hosts.length, details: hosts.length,
        photos: hosts.reduce((sum, host) => sum + host.photos.length, 0), blocked: 3, reservations: 1,
    });
    // #398: o pendente do seed tem data de envio, para entrar na fila de validação com posição definida
    assert.ok((await prisma.provider.findUnique({ where: { id: hostId.pendente } })).submittedAt, 'Host pendente sem submittedAt.');
    assert.equal(second.users.length, accounts.length);
    assert.equal(second.tutors.length, 1);
    assert.equal(second.addresses.length, 1 + hosts.length);
    assert.equal(second.pets.length, 3);
    assert(second.pets.every(pet => pet.active));
    assert.equal(new Set(second.pets.map(pet => pet.petSpecies)).size, 2);
    assert.equal(new Set(second.pets.map(pet => pet.petSize)).size, 3);
    assert.equal(second.users[0].accountType, 'admin');
    assert.equal(second.users[1].profileCompletedAt.getTime(), first.users[1].profileCompletedAt.getTime());

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    process.env.JWT_PUBLIC_KEY = await exportSPKI(publicKey);
    const { default: app } = await import('../../src/app.js');
    const server = app.listen(0);
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    for (const account of accounts) {
        const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject(account.id)
            .setIssuer('hospetse-auth-service').setAudience('hospetse-backend').setExpirationTime('5m').sign(privateKey);
        const headers = { Authorization: `Bearer ${token}` };
        const response = await fetch(`http://localhost:${server.address().port}/api/v1/me`, { headers });
        assert.equal(response.status, 200);
        const me = await response.json();
        assert.equal(me.user.authUserId, account.id);
        assert.equal(me.profile.status, account.profileStatus);
        assert.equal(me.permissions.canContract, account.profileStatus === 'complete');
        if (account.profileStatus === 'complete') {
            assert.deepEqual(me.profile.missingFields, []);
            const response = await fetch(`http://localhost:${server.address().port}/api/v1/me/pets`, { headers });
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.items.length, 3);
        }
        // #314: o Administrador do seed acessa a rota administrativa
        if (account.accountType === 'admin') {
            const adminRes = await fetch(`http://localhost:${server.address().port}/api/v1/admin/me`, { headers });
            assert.equal(adminRes.status, 200);
            assert.deepEqual(await adminRes.json(), { id: me.user.id, accountType: 'admin' });
        }
    }
    // #498: os Hosts do seed cobrem os filtros da busca, e pendente e inativo nunca aparecem
    const tokenFor = (sub) => new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setSubject(sub)
        .setIssuer('hospetse-auth-service').setAudience('hospetse-backend').setExpirationTime('5m').sign(privateKey);
    const get = async (path, sub) => {
        const response = await fetch(`http://localhost:${server.address().port}${path}`, { headers: { Authorization: `Bearer ${await tokenFor(sub)}` } });
        assert.equal(response.status, 200, path);
        return response.json();
    };
    const tutorSub = accounts[1].id;
    const found = async (query) => (await get(`/api/v1/hosts/search?${new URLSearchParams(query)}`, tutorSub)).items.map((i) => i.hostId).sort();
    const expect = (...keys) => keys.map((key) => hostId[key]).sort();
    assert.deepEqual(await found({}), expect('aberto', 'caes', 'gatos', 'racas'));
    assert.deepEqual(await found({ petId: pets[0].id }), expect('aberto', 'caes'), 'Rex: cão médio vira-lata');
    assert.deepEqual(await found({ petId: pets[1].id }), expect('aberto', 'gatos'), 'Mia: gata');
    assert.deepEqual(await found({ petId: pets[2].id }), expect('aberto', 'racas'), 'Thor: cão grande Labrador');
    assert.deepEqual(await found({ city: 'Campinas' }), expect('gatos'));
    assert.deepEqual(await found({ minPrice: 100, maxPrice: 160 }), expect('caes', 'gatos'));
    assert.deepEqual(await found({ startDate: day(7), endDate: day(10) }), expect('aberto', 'gatos', 'racas'), 'Só Cães bloqueado');
    assert.deepEqual(await found({ startDate: day(14), endDate: day(17) }), expect('aberto', 'caes', 'racas'), 'Gatos ocupado');

    const agenda = async (key, from, to) => (await get(`/api/v1/me/host/agenda?startDate=${day(from)}&endDate=${day(to)}`,
        hosts.find((host) => host.key === key).accountId)).days.map((d) => d.status);
    assert.deepEqual(await agenda('caes', 6, 11), ['free', 'blocked', 'blocked', 'blocked', 'free']);
    assert.deepEqual(await agenda('gatos', 13, 18), ['free', 'occupied', 'occupied', 'occupied', 'free']);

    await prisma.user.update({ where: { authUserId: accounts[2].id }, data: { email: 'conflito-seed@example.com' } });
    const beforeConflict = await snapshot();
    assert.equal(seed().status, 1);
    assert.deepEqual(await snapshot(), beforeConflict, 'Conflito deve reverter também as contas anteriores.');
    await prisma.user.update({ where: { authUserId: accounts[2].id }, data: { email: accounts[2].email } });
    await prisma.user.update({ where: { authUserId: accounts[0].id }, data: { accountType: 'user' } });
    const beforeRole = await snapshot();
    assert.equal(seed().status, 1);
    assert.deepEqual(await snapshot(), beforeRole, 'Não pode promover conta com papel diferente.');
    await prisma.user.update({ where: { authUserId: accounts[0].id }, data: { accountType: 'admin' } });
    const otherTutor = await prisma.tutor.create({ data: { userId: second.users[2].id, name: 'Outro Tutor' } });
    await prisma.pet.update({ where: { id: pets[0].id }, data: { tutorId: otherTutor.id } });
    const beforePet = await snapshot();
    assert.equal(seed().status, 1);
    assert.deepEqual(await snapshot(), beforePet, 'Não pode transferir pet de outro Tutor.');
});
