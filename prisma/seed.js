import 'dotenv/config';
import assert, { AssertionError } from 'node:assert/strict';
import { prisma } from '../src/lib/prisma.js';
import { isValidCpf } from '../src/lib/cpf.js';
import { isAdult, missingFields } from '../src/users/profile-policy.js';
import { PET_SPECIES, PET_SIZES } from '../src/pets/pet-policy.js';
import { recordPaymentEntry } from '../src/payments/financial-entries.service.js';
import { accounts } from './seed-accounts.js';
import { profile, address, pets, hosts } from './seed-data.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Agenda relativa ao dia em que o seed roda (meia-noite UTC, como as reservas): a demonstração sempre tem datas futuras
const today = Date.parse(new Date().toISOString().slice(0, 10));
const fromToday = (days) => new Date(today + days * DAY_MS);
const conflict = (what) => `${what}; nenhuma alteração foi salva.`;
const seedContracts = process.argv.includes('--contracts');

async function seedHotelContracts(tx, tutor, host) {
    assert(tutor, conflict('Contratações do seed sem o Tutor completo'));
    const { provider, service } = host;
    const scenarios = [
        ['01', 'requested', 4, 5],
        ['02', 'awaiting_payment', 2, 3],
        ['03', 'accepted', 0, 1],
        ['04', 'checked_in', -1, 2],
        ['05', 'completed', -4, -3],
    ];
    for (const [suffix, status, from, to] of scenarios) {
        const id = `57300000-0000-4000-8000-0000000000${suffix}`;
        const petId = pets[status === 'checked_in' ? 2 : 0].id;
        const existing = await tx.reservation.findUnique({ where: { id }, select: { tutorId: true, petId: true, serviceId: true } });
        assert(!existing || (existing.tutorId === tutor.id && existing.petId === petId && existing.serviceId === service.id),
            conflict('Contratação #573 pertence a outro cadastro'));

        const checkedIn = status === 'checked_in' || status === 'completed';
        const paid = status === 'accepted' || checkedIn;
        const totalValue = service.price * (to - from);
        const data = {
            tutorId: tutor.id, petId, serviceId: service.id, status,
            startDate: fromToday(from), endDate: fromToday(to),
            createdDate: fromToday(Math.min(-1, from - 2)),
            decidedAt: status === 'requested' ? null : fromToday(Math.min(0, from - 1)),
            checkedInAt: checkedIn ? new Date(fromToday(from).getTime() + 12 * 60 * 60 * 1000) : null,
            dailyPrice: service.price, totalValue,
        };
        await tx.reservation.upsert({ where: { id }, update: data, create: { id, ...data } });
        if (!paid) continue;

        const paymentId = `57300000-0000-4000-8000-0000000001${suffix}`;
        const transaction = await tx.paymentTransaction.upsert({
            where: { id: paymentId },
            update: {},
            create: { id: paymentId, reservationId: id, type: 'payment', status: 'approved', value: totalValue, createdDate: data.decidedAt },
        });
        assert(transaction.reservationId === id && transaction.type === 'payment'
            && transaction.status === 'approved' && transaction.value.equals(totalValue),
        conflict('Pagamento #573 diverge do cenário de demonstração'));
        await recordPaymentEntry(tx, { ...transaction, reservation: { tutorId: tutor.id, service: { providerId: provider.id } } });
    }
}

// Host do seed (#498): endereço, prestador, diária, capacidade, fotos e agenda, todos por id fixo.
// Fotos, bloqueios e a reserva de ocupação são recriados a cada execução: o total não cresce e as datas acompanham o dia.
async function seedHost(tx, user, current, host, seedTutor) {
    const { provider, service } = host;
    assert(!current?.provider || current.provider.id === provider.id, conflict('Conta de Host do seed possui outro prestador'));

    const existingProvider = await tx.provider.findUnique({ where: { id: provider.id }, select: { userId: true } });
    assert(!existingProvider || existingProvider.userId === user.id, conflict('Prestador do seed pertence a outro usuário'));
    const existingAddress = await tx.address.findUnique({ where: { id: host.address.id }, include: { tutor: true, provider: true } });
    assert(!existingAddress || (!existingAddress.tutor && (!existingAddress.provider || existingAddress.provider.id === provider.id)),
        conflict('Endereço do seed pertence a outro cadastro'));
    const existingService = await tx.service.findUnique({ where: { id: service.id }, select: { providerId: true } });
    assert(!existingService || existingService.providerId === provider.id, conflict('Serviço do seed pertence a outro prestador'));

    const { id: addressId, ...addressData } = host.address;
    await tx.address.upsert({ where: { id: addressId }, update: addressData, create: host.address });
    const { id: providerId, ...providerData } = provider;
    await tx.provider.upsert({
        where: { id: providerId },
        update: { ...providerData, addressId },
        create: { ...provider, userId: user.id, addressId },
    });
    const { id: serviceId, ...serviceData } = service;
    await tx.service.upsert({
        where: { id: serviceId },
        update: { ...serviceData, active: true },
        create: { ...service, providerId, active: true },
    });
    await tx.hotelDetail.upsert({ where: { providerId }, update: { capacity: host.capacity }, create: { providerId, capacity: host.capacity } });

    await tx.providerPhoto.deleteMany({ where: { providerId } });
    await tx.providerPhoto.createMany({ data: host.photos.map((url) => ({ providerId, url })) });

    await tx.providerBlockedDate.deleteMany({ where: { providerId } });
    const blockedDays = (host.blocked ?? []).flatMap(({ from, to, reason }) =>
        Array.from({ length: to - from }, (_, i) => ({ providerId, date: fromToday(from + i), reason })));
    if (blockedDays.length) await tx.providerBlockedDate.createMany({ data: blockedDays });

    if (host.occupied) {
        const { reservationId, petId, from, to } = host.occupied;
        assert(seedTutor, conflict('Ocupação do seed sem o Tutor completo'));
        const existing = await tx.reservation.findUnique({ where: { id: reservationId }, select: { tutorId: true } });
        assert(!existing || existing.tutorId === seedTutor.id, conflict('Reserva do seed pertence a outro Tutor'));
        const data = {
            tutorId: seedTutor.id, petId, serviceId, status: 'accepted',
            startDate: fromToday(from), endDate: fromToday(to), decidedAt: new Date(),
            dailyPrice: service.price, totalValue: service.price * (to - from),
        };
        await tx.reservation.upsert({ where: { id: reservationId }, update: data, create: { id: reservationId, ...data } });
    }
}

try {
    assert(process.env.DATABASE_URL, 'DATABASE_URL ausente.');
    if (seedContracts) {
        const { hostname, protocol } = new URL(process.env.DATABASE_URL);
        assert(['postgres:', 'postgresql:'].includes(protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
            && process.env.NODE_ENV !== 'production', 'O seed de contratações #573 exige PostgreSQL local fora de produção.');
    }
    assert(isValidCpf(profile.cpf), 'CPF do seed inválido.');
    assert(isAdult(profile.birthDate.toISOString().slice(0, 10)), 'Tutor do seed deve ser adulto.');
    assert(missingFields({ tutor: { ...profile, address } }).length === 0, 'Perfil do seed incompleto.');
    assert(pets.every(pet => PET_SPECIES.includes(pet.petSpecies) && PET_SIZES.includes(pet.petSize)), 'Espécie ou porte do seed inválido.');
    const hostByAccount = new Map(hosts.map((host) => [host.accountId, host]));
    assert(accounts.filter((a) => a.role === 'host').every((a) => hostByAccount.has(a.id)), 'Conta de Host do seed sem dados de Host.');
    assert(hosts.every((host) => host.provider.acceptedSpecies.every((s) => PET_SPECIES.includes(s))
        && host.provider.acceptedSizes.every((s) => PET_SIZES.includes(s))
        && host.service.price > 0 && host.capacity >= 1 && host.address.city), 'Dados de Host do seed inválidos.');

    await prisma.$transaction(async tx => {
        let seedTutor = null;
        for (const account of accounts) {
            const isHost = account.role === 'host';
            const matches = await tx.user.findMany({
                where: { OR: [{ authUserId: account.id }, { email: account.email }] },
                include: { tutor: true, provider: true },
            });
            const current = matches[0];
            assert(matches.length <= 1 && (!current || (
                current.authUserId === account.id && current.email === account.email && current.accountType === account.accountType
            )), 'Conflito de identidade no seed; nenhuma alteração foi salva.');
            // Host não vira Tutor; Admin e Tutores não viram prestador
            assert(isHost ? !current?.tutor : !current?.provider && (account.profileStatus === 'complete' || !current?.tutor),
                'Conta do seed possui papel incompatível; nenhuma alteração foi salva.');
            const data = {
                email: account.email, name: account.name, accountType: account.accountType,
                status: 'active', profileStatus: account.profileStatus,
                profileCompletedAt: account.profileStatus === 'complete' ? (current?.profileCompletedAt ?? new Date()) : null,
            };
            const user = current
                ? await tx.user.update({ where: { id: current.id }, data })
                : await tx.user.create({ data: { authUserId: account.id, ...data } });
            if (isHost) {
                await seedHost(tx, user, current, hostByAccount.get(account.id), seedTutor);
                continue;
            }
            if (account.profileStatus !== 'complete') continue;

            const savedAddress = current?.tutor?.addressId
                ? await tx.address.update({ where: { id: current.tutor.addressId }, data: address })
                : await tx.address.create({ data: address });
            const tutorData = { ...profile, name: account.name, addressId: savedAddress.id };
            const tutor = await tx.tutor.upsert({
                where: { userId: user.id }, update: tutorData, create: { userId: user.id, ...tutorData },
            });
            seedTutor = tutor;
            for (const pet of pets) {
                const existing = await tx.pet.findUnique({ where: { id: pet.id } });
                assert(!existing || existing.tutorId === tutor.id, 'Pet do seed pertence a outro Tutor; nenhuma alteração foi salva.');
                await tx.pet.upsert({ where: { id: pet.id }, update: pet, create: { ...pet, tutorId: tutor.id } });
            }
        }
        if (seedContracts) await seedHotelContracts(tx, seedTutor, hosts.find(({ key }) => key === 'aberto'));
    // O seed faz dezenas de consultas sequenciais ao banco remoto; os Hosts (#498) dobraram a conta, então 60 s.
    }, { timeout: 60000 });
    console.log(`Seed concluído: ${accounts.length} contas, ${pets.length} pets e ${hosts.length} Hosts.`);
    if (seedContracts) console.log('Seed #573 concluído: cinco contratações de hospedagem.');
} catch (error) {
    const code = /^P\d{4}$/.test(error.code) ? ` (${error.code})` : '';
    console.error(error instanceof AssertionError ? error.message : `Falha no seed${code}; transação revertida. Verifique a conexão e conflitos nos dados reservados.`);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
