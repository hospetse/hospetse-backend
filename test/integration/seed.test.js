import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { accounts } from '../../prisma/seed-accounts.js';
import { pets } from '../../prisma/seed-data.js';

test('seed #497: criação, idempotência, HTTP e rollback', { skip: !process.env.SEED_TEST_DATABASE_URL }, async t => {
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
    t.after(async () => {
        await prisma.pet.deleteMany({ where: { id: { in: pets.map(pet => pet.id) } } });
        const tutors = await prisma.tutor.findMany({ where: { user: { authUserId: { in: accounts.map(a => a.id) } } } });
        await prisma.tutor.deleteMany({ where: { id: { in: tutors.map(tutor => tutor.id) } } });
        await prisma.address.deleteMany({ where: { id: { in: tutors.map(tutor => tutor.addressId).filter(Boolean) } } });
        await prisma.user.deleteMany({ where: { authUserId: { in: accounts.map(a => a.id) } } });
        await prisma.$disconnect();
    });
    assert.equal(seed().status, 0, 'Primeira execução falhou.');
    const first = await snapshot();
    assert.equal(seed().status, 0, 'Segunda execução falhou.');
    const second = await snapshot();
    for (const table of ['users', 'tutors', 'addresses', 'pets']) {
        assert.deepEqual(second[table].map(row => row.id), first[table].map(row => row.id));
    }
    assert.equal(second.users.length, 3);
    assert.equal(second.tutors.length, 1);
    assert.equal(second.addresses.length, 1);
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
    }
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
