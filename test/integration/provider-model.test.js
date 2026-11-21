// #341: a mesma conta mantém Tutor e Pet Walker; os novos valores são limitados pelo banco.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

try {
    process.loadEnvFile();
} catch {
    // Os testes de integração exigem DATABASE_URL no ambiente ou no .env local.
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente: configure um banco local de teste');

const { prisma } = await import('../../src/lib/prisma.js');
after(() => prisma.$disconnect());

test('prestador Pet Walker também é Tutor e respeita os novos CHECKs', async () => {
    const user = await prisma.user.create({
        data: { authUserId: randomUUID(), email: `it-provider-model-${randomUUID()}@hospetse.test`, name: 'Teste' },
    });
    try {
        const tutor = await prisma.tutor.create({ data: { userId: user.id, name: 'Teste' } });
        const provider = await prisma.provider.create({
            data: {
                userId: user.id, providerType: 'pet_walker', name: 'Passeador de teste',
                personType: 'pf', administersMedication: false, experienceRange: '1_3',
                petWalkerDetail: { create: { kilometerRadius: 5 } },
                documents: { create: { type: 'qualification', storageKey: 'test/qualification.pdf' } },
            },
            include: { petWalkerDetail: true, documents: true },
        });
        assert.equal(tutor.userId, provider.userId);
        assert.equal(provider.personType, 'pf');
        assert.equal(provider.administersMedication, false);
        assert.equal(provider.petWalkerDetail.kilometerRadius.toNumber(), 5);
        assert.equal(provider.documents[0].type, 'qualification');
        await assert.rejects(prisma.provider.update({ where: { id: provider.id }, data: { personType: 'xx' } }));
        await assert.rejects(prisma.provider.update({ where: { id: provider.id }, data: { experienceRange: 'invalid' } }));
        await assert.rejects(prisma.petWalkerDetail.update({ where: { providerId: provider.id }, data: { kilometerRadius: -1 } }));
        await assert.rejects(prisma.providerDocument.create({ data: { providerId: provider.id, type: 'invalid', storageKey: 'test/invalid.pdf' } }));
    } finally {
        await prisma.provider.deleteMany({ where: { userId: user.id } });
        await prisma.tutor.deleteMany({ where: { userId: user.id } });
        await prisma.user.delete({ where: { id: user.id } });
    }
});
