// Massa de dados do teste de carga (HSP-PBI-083-TSK-02 #577), só no banco local de carga.
//   npm run load:generate -- --tutors=10000 --hosts=1000 --reservations=20000 --conversations=2000
//   npm run load:generate -- --clean-only
// Apaga tudo do banco de carga e gera de novo: rodar outra vez dá o mesmo volume. Falhou no meio? Rode de novo.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fakerPT_BR as faker } from '@faker-js/faker';
import { PrismaClient } from '@prisma/client';
import { PET_SIZES, PET_SPECIES } from '../../src/pets/pet-policy.js';
import { cpfFromIndex, loadDatabaseUrl, parseLoadArgs } from './load-policy.js';

const BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const today = Date.parse(new Date().toISOString().slice(0, 10));
const fromToday = (days) => new Date(today + days * DAY_MS);
const OUTPUT = new URL('./output/', import.meta.url);

// Poucas cidades, para a busca por cidade do teste de carga achar Hosts
const CITIES = [
    ['São Paulo', 'SP'], ['Campinas', 'SP'], ['Rio de Janeiro', 'RJ'], ['Belo Horizonte', 'MG'], ['Curitiba', 'PR'],
    ['Maringá', 'PR'], ['Porto Alegre', 'RS'], ['Florianópolis', 'SC'], ['Salvador', 'BA'], ['Recife', 'PE'],
];
const NEIGHBORHOODS = ['Centro', 'Jardim América', 'Vila Nova', 'Zona 7', 'Boa Vista', 'Santa Cruz', 'Bela Vista', 'Alto da Glória'];
// Status com o peso de cada um. Só os que ocupam vaga passam pela conferência de capacidade
const STATUSES = ['requested', 'requested', 'awaiting_payment', 'accepted', 'accepted', 'rejected', 'checked_in', 'completed', 'completed'];
const OCCUPYING = ['awaiting_payment', 'accepted', 'checked_in'];
const CONVERSATION_STATUSES = ['ai_handling', 'escalated', 'human_handling', 'closed'];

const { errors, options } = parseLoadArgs(process.argv.slice(2));
if (errors.length) {
    console.error(`Flags inválidas:\n- ${errors.join('\n- ')}`);
    process.exit(1);
}
let url;
try {
    url = loadDatabaseUrl();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
const prisma = new PrismaClient({ datasourceUrl: url });

async function insert(model, rows) {
    for (let i = 0; i < rows.length; i += BATCH) await prisma[model].createMany({ data: rows.slice(i, i + BATCH) });
}

function address() {
    const [city, state] = faker.helpers.arrayElement(CITIES);
    return {
        id: randomUUID(),
        zipCode: faker.string.numeric(8),
        street: faker.location.street(),
        number: faker.location.buildingNumber(),
        neighborhood: faker.helpers.arrayElement(NEIGHBORHOODS),
        city,
        state,
    };
}

function user(role, index) {
    return {
        id: randomUUID(),
        authUserId: randomUUID(),
        // .test é reservado: nenhum e-mail sai de verdade
        email: `load-${role}-${index}@hospetse.test`,
        name: faker.person.fullName(),
        status: 'active',
        profileStatus: 'complete',
        profileCompletedAt: new Date(),
    };
}

// TRUNCATE em vez de DELETE: o registro financeiro (#528) recusa DELETE por trigger, e TRUNCATE não dispara trigger de linha
async function clean() {
    const tables = await prisma.$queryRaw`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    if (!tables.length) return;
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map(({ tablename }) => `"${tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

// Tutores com perfil completo (CPF válido, 18 anos ou mais) e 1 a 3 pets ativos cada
async function generateTutors(total) {
    const tutors = [];
    for (let start = 0; start < total; start += BATCH) {
        const users = [], addresses = [], rows = [], pets = [];
        for (let i = start; i < Math.min(start + BATCH, total); i++) {
            const tutorUser = user('tutor', i);
            const tutorAddress = address();
            const tutor = {
                id: randomUUID(),
                userId: tutorUser.id,
                name: tutorUser.name,
                phone: `119${faker.string.numeric(8)}`,
                cpf: cpfFromIndex(i),
                birthDate: faker.date.birthdate({ mode: 'age', min: 18, max: 80 }),
                emergencyContactName: faker.person.fullName(),
                emergencyContactPhone: `119${faker.string.numeric(8)}`,
                addressId: tutorAddress.id,
            };
            const tutorPets = Array.from({ length: faker.number.int({ min: 1, max: 3 }) }, () => {
                const petSpecies = faker.helpers.arrayElement(PET_SPECIES);
                return {
                    id: randomUUID(),
                    tutorId: tutor.id,
                    petName: faker.person.firstName(),
                    petSpecies,
                    petBreed: petSpecies === 'dog' ? faker.animal.dog() : faker.animal.cat(),
                    petSize: faker.helpers.arrayElement(PET_SIZES),
                    petBirthDate: faker.date.past({ years: 15 }),
                };
            });
            users.push(tutorUser);
            addresses.push(tutorAddress);
            rows.push(tutor);
            pets.push(...tutorPets);
            tutors.push({ authUserId: tutorUser.authUserId, tutorId: tutor.id, pets: tutorPets.map(({ id, petSpecies, petSize }) => ({ id, petSpecies, petSize })) });
        }
        await insert('user', users);
        await insert('address', addresses);
        await insert('tutor', rows);
        await insert('pet', pets);
    }
    return tutors;
}

// Hosts aprovados e ativos (elegíveis na busca), com capacidade, uma diária e alguns dias bloqueados
async function generateHosts(total) {
    const hosts = [];
    for (let start = 0; start < total; start += BATCH) {
        const users = [], addresses = [], providers = [], details = [], services = [], blocked = [];
        for (let i = start; i < Math.min(start + BATCH, total); i++) {
            const hostUser = user('host', i);
            const hostAddress = address();
            const provider = {
                id: randomUUID(),
                userId: hostUser.id,
                providerType: 'hotel',
                name: `Hotel ${faker.company.name()}`.slice(0, 255),
                addressId: hostAddress.id,
                status: 'active',
                validationStatus: 'approved',
                description: faker.lorem.paragraph().slice(0, 2000),
                submittedAt: fromToday(-faker.number.int({ min: 10, max: 120 })),
                acceptedSpecies: faker.helpers.arrayElements(PET_SPECIES, { min: 1, max: PET_SPECIES.length }),
                acceptedSizes: faker.helpers.arrayElements(PET_SIZES, { min: 1, max: PET_SIZES.length }),
            };
            const capacity = faker.number.int({ min: 1, max: 10 });
            const service = { id: randomUUID(), providerId: provider.id, name: 'Hospedagem', price: faker.number.int({ min: 40, max: 250 }), active: true };
            // Dias distintos nos próximos 90: o UNIQUE (provider_id, date) não aceita repetição
            for (const day of faker.helpers.arrayElements(Array.from({ length: 90 }, (_, d) => d + 1), { min: 0, max: 5 })) {
                blocked.push({ providerId: provider.id, date: fromToday(day), reason: 'Indisponível' });
            }
            users.push(hostUser);
            addresses.push(hostAddress);
            providers.push(provider);
            details.push({ providerId: provider.id, capacity });
            services.push(service);
            hosts.push({ authUserId: hostUser.authUserId, providerId: provider.id, serviceId: service.id, price: service.price, capacity, ...provider });
        }
        await insert('user', users);
        await insert('address', addresses);
        await insert('provider', providers);
        await insert('hotelDetail', details);
        await insert('service', services);
        await insert('providerBlockedDate', blocked);
    }
    return hosts;
}

// Datas coerentes com o status: concluída no passado, em andamento hoje, as demais no futuro
function periodFor(status) {
    const nights = faker.number.int({ min: 1, max: 7 });
    const start = status === 'completed' ? -faker.number.int({ min: nights + 1, max: 90 })
        : status === 'checked_in' ? -faker.number.int({ min: 0, max: nights - 1 })
            : faker.number.int({ min: 1, max: 90 });
    return { start, nights };
}

// Reservas compatíveis com o Host (espécie e porte). As que ocupam vaga respeitam a capacidade do Host e não
// põem o mesmo pet em dois lugares no mesmo dia; quando não cabem, viram solicitação pendente.
async function generateReservations(total, tutors, hosts) {
    const occupancy = new Map();
    const petDays = new Set();
    let rows = [];
    let created = 0;
    let attempts = 0;
    while (created < total && attempts < total * 20) {
        attempts += 1;
        const tutor = faker.helpers.arrayElement(tutors);
        const pet = faker.helpers.arrayElement(tutor.pets);
        const host = faker.helpers.arrayElement(hosts);
        if (!host.acceptedSpecies.includes(pet.petSpecies) || !host.acceptedSizes.includes(pet.petSize)) continue;

        let status = faker.helpers.arrayElement(STATUSES);
        const { start, nights } = periodFor(status);
        const days = Array.from({ length: nights }, (_, d) => start + d);
        if (OCCUPYING.includes(status)) {
            const fits = days.every((day) => (occupancy.get(`${host.providerId}:${day}`) ?? 0) < host.capacity && !petDays.has(`${pet.id}:${day}`));
            if (fits) {
                for (const day of days) {
                    occupancy.set(`${host.providerId}:${day}`, (occupancy.get(`${host.providerId}:${day}`) ?? 0) + 1);
                    petDays.add(`${pet.id}:${day}`);
                }
            } else {
                // shortcut: o pendente pode cair em data passada se o sorteado era em andamento; não ocupa vaga, aceitável para carga
                status = 'requested';
            }
        }
        rows.push({
            id: randomUUID(),
            petId: pet.id,
            tutorId: tutor.tutorId,
            serviceId: host.serviceId,
            status,
            rejectionReason: status === 'rejected' ? 'Sem vaga no período' : null,
            decidedAt: status === 'requested' ? null : fromToday(Math.min(start, 0) - 1),
            startDate: fromToday(start),
            endDate: fromToday(start + nights),
            createdDate: fromToday(Math.min(start, 0) - 2),
            dailyPrice: host.price,
            totalValue: host.price * nights,
        });
        created += 1;
        if (rows.length === BATCH) {
            await insert('reservation', rows);
            rows = [];
        }
    }
    await insert('reservation', rows);
    return created;
}

// Conversas entre Tutor e Host com 2 a 10 mensagens alternando os lados
async function generateConversations(total, tutors, hosts) {
    for (let start = 0; start < total; start += BATCH) {
        const conversations = [], messages = [];
        for (let i = start; i < Math.min(start + BATCH, total); i++) {
            const conversation = {
                id: randomUUID(),
                tutorId: faker.helpers.arrayElement(tutors).tutorId,
                providerId: faker.helpers.arrayElement(hosts).providerId,
                status: faker.helpers.arrayElement(CONVERSATION_STATUSES),
                createdAt: fromToday(-faker.number.int({ min: 1, max: 60 })),
            };
            const count = faker.number.int({ min: 2, max: 10 });
            for (let m = 0; m < count; m++) {
                messages.push({
                    conversationId: conversation.id,
                    senderType: m % 2 === 0 ? 'tutor' : faker.helpers.arrayElement(['host', 'ai']),
                    content: faker.lorem.sentence(),
                    sentAt: new Date(conversation.createdAt.getTime() + m * 60000),
                });
            }
            conversations.push(conversation);
        }
        await insert('conversation', conversations);
        await insert('message', messages);
    }
}

const TABLES = ['users', 'addresses', 'tutors', 'pets', 'providers', 'hotel_details', 'services', 'provider_blocked_dates',
    'reservations', 'conversations', 'messages'];

try {
    const startedAt = Date.now();
    await clean();
    console.log('Banco de carga limpo.');
    if (!options.cleanOnly) {
        const tutors = await generateTutors(options.tutors);
        console.log(`Tutores e pets: ok (${options.tutors})`);
        const hosts = await generateHosts(options.hosts);
        console.log(`Hosts: ok (${options.hosts})`);
        const reservations = await generateReservations(options.reservations, tutors, hosts);
        if (reservations < options.reservations) console.log(`Aviso: só ${reservations} reservas compatíveis geradas.`);
        await generateConversations(options.conversations, tutors, hosts);

        // Para o script do k6 (#578) assinar os tokens pelo sub e montar as requisições. Fora do git (.gitignore)
        mkdirSync(OUTPUT, { recursive: true });
        writeFileSync(new URL('users.json', OUTPUT), JSON.stringify({
            tutors: tutors.map(({ authUserId, pets }) => ({ authUserId, petIds: pets.map((pet) => pet.id) })),
            hosts: hosts.map(({ authUserId, providerId, serviceId }) => ({ authUserId, providerId, serviceId })),
        }));
        console.log('Usuários gerados em prisma/load/output/users.json');
    }

    console.log('\nLinhas por tabela:');
    for (const table of TABLES) {
        const [{ count }] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM "${table}"`);
        console.log(`  ${table.padEnd(24)} ${count}`);
    }
    console.log(`\nTempo total: ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
} catch (error) {
    // Só a mensagem: o erro do Prisma pode trazer dados da linha
    console.error(`Falha na geração: ${error.message.split('\n').slice(-1)[0]}`);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
