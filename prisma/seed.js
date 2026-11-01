import 'dotenv/config';
import assert, { AssertionError } from 'node:assert/strict';
import { prisma } from '../src/lib/prisma.js';
import { isValidCpf } from '../src/lib/cpf.js';
import { isAdult, missingFields } from '../src/users/profile-policy.js';
import { PET_SPECIES, PET_SIZES } from '../src/pets/pet-policy.js';
import { accounts } from './seed-accounts.js';
import { profile, address, pets } from './seed-data.js';

try {
    assert(process.env.DATABASE_URL, 'DATABASE_URL ausente.');
    assert(isValidCpf(profile.cpf), 'CPF do seed inválido.');
    assert(isAdult(profile.birthDate.toISOString().slice(0, 10)), 'Tutor do seed deve ser adulto.');
    assert(missingFields({ tutor: { ...profile, address } }).length === 0, 'Perfil do seed incompleto.');
    assert(pets.every(pet => PET_SPECIES.includes(pet.petSpecies) && PET_SIZES.includes(pet.petSize)), 'Espécie ou porte do seed inválido.');

    await prisma.$transaction(async tx => {
        for (const account of accounts) {
            const matches = await tx.user.findMany({
                where: { OR: [{ authUserId: account.id }, { email: account.email }] },
                include: { tutor: true, provider: true },
            });
            const current = matches[0];
            assert(matches.length <= 1 && (!current || (
                current.authUserId === account.id && current.email === account.email && current.accountType === account.accountType
            )), 'Conflito de identidade no seed; nenhuma alteração foi salva.');
            assert(!current?.provider && (account.profileStatus === 'complete' || !current?.tutor),
                'Conta do seed possui papel incompatível; nenhuma alteração foi salva.');
            const data = {
                email: account.email, name: account.name, accountType: account.accountType,
                status: 'active', profileStatus: account.profileStatus,
                profileCompletedAt: account.profileStatus === 'complete' ? (current?.profileCompletedAt ?? new Date()) : null,
            };
            const user = current
                ? await tx.user.update({ where: { id: current.id }, data })
                : await tx.user.create({ data: { authUserId: account.id, ...data } });
            if (account.profileStatus !== 'complete') continue;

            const savedAddress = current?.tutor?.addressId
                ? await tx.address.update({ where: { id: current.tutor.addressId }, data: address })
                : await tx.address.create({ data: address });
            const tutorData = { ...profile, name: account.name, addressId: savedAddress.id };
            const tutor = await tx.tutor.upsert({
                where: { userId: user.id }, update: tutorData, create: { userId: user.id, ...tutorData },
            });
            for (const pet of pets) {
                const existing = await tx.pet.findUnique({ where: { id: pet.id } });
                assert(!existing || existing.tutorId === tutor.id, 'Pet do seed pertence a outro Tutor; nenhuma alteração foi salva.');
                await tx.pet.upsert({ where: { id: pet.id }, update: pet, create: { ...pet, tutorId: tutor.id } });
            }
        }
    // O seed faz várias consultas sequenciais ao banco remoto; 5 s não cobrem a latência do Railway.
    }, { timeout: 30000 });
    console.log('Seed concluído: 3 contas e 3 pets.');
} catch (error) {
    const code = /^P\d{4}$/.test(error.code) ? ` (${error.code})` : '';
    console.error(error instanceof AssertionError ? error.message : `Falha no seed${code}; transação revertida. Verifique a conexão e conflitos nos dados reservados.`);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
