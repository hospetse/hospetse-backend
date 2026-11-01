// GET /api/v1/hosts/search (HSP-PBI-030-TSK-01 #476) contra o PostgreSQL real. Exige DATABASE_URL.
// Cada teste cria os Hosts numa cidade só dele (it-busca-<uuid>): o banco é compartilhado e tem Hosts de outras pessoas.
// O JWT é assinado por um par de chaves gerado aqui: não depende do Auth. Remove tudo o que criou no after.
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
const tutorIds = [];
const providerIds = [];
const addressIds = [];

after(async () => {
    server.close();
    // bloqueios e hotel_details saem em cascata com o prestador; o resto, na ordem das chaves estrangeiras
    await prisma.reservation.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.pet.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.tutor.deleteMany({ where: { id: { in: tutorIds } } });
    await prisma.service.deleteMany({ where: { providerId: { in: providerIds } } });
    await prisma.provider.deleteMany({ where: { id: { in: providerIds } } });
    await prisma.address.deleteMany({ where: { id: { in: addressIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

const day = (offset) => new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const newCity = () => `it-busca-${randomUUID()}`;

async function newUser(data = {}) {
    const authUserId = randomUUID();
    const user = await prisma.user.create({ data: { authUserId, email: `it-busca-${authUserId}@exemplo.com`, name: 'Teste Busca', ...data } });
    userIds.push(user.id);
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(authUserId)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setExpirationTime('5m')
        .sign(privateKey);
    return { user, token };
}

// Tutor com perfil completo e um pet ativo (cachorro médio vira-lata)
async function newTutor(pet = {}) {
    const { user, token } = await newUser({ status: 'active', profileStatus: 'complete' });
    const tutor = await prisma.tutor.create({ data: { userId: user.id, name: user.name } });
    tutorIds.push(tutor.id);
    const created = await prisma.pet.create({
        data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog', petSize: 'medium', petBreed: 'Vira-lata', ...pet },
    });
    return { tutor, pet: created, token };
}

// Host elegível na cidade dada, com uma diária; overrides mudam o Host, service muda o serviço
async function newHost(city, overrides = {}, service = {}) {
    const { user } = await newUser();
    const address = await prisma.address.create({
        data: { zipCode: '01001000', street: 'Rua Teste', number: '1', neighborhood: 'Centro', city, state: 'SP' },
    });
    addressIds.push(address.id);
    const provider = await prisma.provider.create({
        data: {
            userId: user.id,
            providerType: 'hotel',
            name: 'Hotelzinho de Teste',
            status: 'active',
            validationStatus: 'approved',
            addressId: address.id,
            services: { create: [{ name: 'Diária', price: 100, ...service }] },
            ...overrides,
        },
        include: { services: true },
    });
    providerIds.push(provider.id);
    return { provider, service: provider.services[0] };
}

// Reserva gravada direto no banco, para ocupar a agenda do Host
function booked(service, { tutor, pet }, start, end, status = 'accepted') {
    return prisma.reservation.create({
        data: {
            tutorId: tutor.id, petId: pet.id, serviceId: service.id, status,
            startDate: new Date(day(start)), endDate: new Date(day(end)), dailyPrice: 100, totalValue: 100 * (end - start),
        },
    });
}

const search = (params, token) => http.get('/api/v1/hosts/search', {
    params, headers: token ? { Authorization: `Bearer ${token}` } : {},
});
const serviceIds = (res) => res.data.items.map((item) => item.serviceId);

test('sem token: 401', async () => {
    const res = await search({});
    assert.strictEqual(res.status, 401);
});

test('só Host elegível com serviço ativo; o item traz só dados públicos', async () => {
    const city = newCity();
    const { token } = await newUser();
    const eligible = await newHost(city, { cpfCnpj: String(Date.now()).slice(-11) });
    await newHost(city, { validationStatus: 'pending' });
    await newHost(city, { status: 'inactive' });
    await newHost(city, { providerType: 'pet_sitter' });
    await newHost(city, {}, { active: false });

    const res = await search({ city: city.toUpperCase() }, token);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(serviceIds(res), [eligible.service.id]);
    assert.deepStrictEqual(res.data.items[0], {
        hostId: eligible.provider.id,
        serviceId: eligible.service.id,
        name: 'Hotelzinho de Teste',
        serviceName: 'Diária',
        dailyPrice: 100,
        pictureUrl: null,
        location: { city, neighborhood: 'Centro' },
        reputation: { rating: null, reviewCount: 0 },
    });
    assert.strictEqual(res.data.total, 1);
});

test('faixa de preço: só as diárias dentro dela', async () => {
    const city = newCity();
    const { token } = await newUser();
    await newHost(city, {}, { price: 50 });
    const inside = await newHost(city, {}, { price: 100 });
    await newHost(city, {}, { price: 150 });

    const res = await search({ city, minPrice: 80, maxPrice: 120 }, token);

    assert.deepStrictEqual(serviceIds(res), [inside.service.id]);
});

test('com petId: usa espécie, porte e raça do pet; lista vazia aceita tudo', async () => {
    const city = newCity();
    const { pet, token } = await newTutor();
    const open = await newHost(city);
    const accepting = await newHost(city, { acceptedSpecies: ['DOG'], acceptedSizes: ['medium'], acceptedBreeds: ['vira-lata'] });
    await newHost(city, { acceptedSpecies: ['cat'] });
    await newHost(city, { acceptedSizes: ['small'] });
    await newHost(city, { acceptedBreeds: ['Labrador'] });

    const res = await search({ city, petId: pet.id }, token);

    assert.deepStrictEqual(serviceIds(res).sort(), [open.service.id, accepting.service.id].sort());
});

test('pet sem raça: Host que restringe raça não aparece', async () => {
    const city = newCity();
    const { pet, token } = await newTutor({ petBreed: null });
    const open = await newHost(city);
    await newHost(city, { acceptedBreeds: ['Vira-lata'] });

    const res = await search({ city, petId: pet.id }, token);

    assert.deepStrictEqual(serviceIds(res), [open.service.id]);
});

test('sem pet: espécie, porte e raça informados à mão; filtro não informado não restringe', async () => {
    const city = newCity();
    const { token } = await newUser();
    const smallPoodle = await newHost(city, { acceptedSizes: ['small'], acceptedBreeds: ['Poodle'] });
    await newHost(city, { acceptedSizes: ['large'] });
    await newHost(city, { acceptedBreeds: ['Labrador'] });
    const onlyCats = await newHost(city, { acceptedSpecies: ['cat'] });

    const manual = await search({ city, size: 'small', breed: 'poodle' }, token);
    const withSpecies = await search({ city, species: 'dog', size: 'small', breed: 'Poodle' }, token);

    assert.deepStrictEqual(serviceIds(manual).sort(), [smallPoodle.service.id, onlyCats.service.id].sort());
    assert.deepStrictEqual(serviceIds(withSpecies), [smallPoodle.service.id]);
});

test('pet de outro Tutor, inativo ou usuário sem Tutor: 400 em petId', async () => {
    const { token } = await newTutor();
    const other = await newTutor();
    const inactive = await newTutor({ active: false });
    const noTutor = await newUser();

    for (const [petId, auth] of [[other.pet.id, token], [inactive.pet.id, inactive.token], [other.pet.id, noTutor.token]]) {
        const res = await search({ petId }, auth);
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.data.details, [{ field: 'petId', message: 'pet não encontrado' }]);
    }
});

test('período: dia bloqueado ou sem vaga some; o dia da saída não conta', async () => {
    const city = newCity();
    const { token } = await newUser();
    const occupant = await newTutor();
    const free = await newHost(city);
    const blocked = await newHost(city);
    await prisma.providerBlockedDate.create({ data: { providerId: blocked.provider.id, date: new Date(day(11)) } });
    const full = await newHost(city);
    await booked(full.service, occupant, 10, 12);
    const twoPlaces = await newHost(city);
    await prisma.hotelDetail.create({ data: { providerId: twoPlaces.provider.id, capacity: 2 } });
    await booked(twoPlaces.service, occupant, 10, 12);
    const pendingOnly = await newHost(city);
    await booked(pendingOnly.service, occupant, 10, 12, 'requested');

    const period = await search({ city, startDate: day(10), endDate: day(13) }, token);
    const afterCheckout = await search({ city, startDate: day(12), endDate: day(14) }, token);

    assert.deepStrictEqual(serviceIds(period).sort(), [free.service.id, twoPlaces.service.id, pendingOnly.service.id].sort());
    assert.ok(serviceIds(afterCheckout).includes(full.service.id), 'a reserva sai no dia 12: o Host volta a ter vaga');
    assert.ok(serviceIds(afterCheckout).includes(blocked.service.id), 'o bloqueio do dia 11 fica fora de 12 a 14');
});

test('menor diária primeiro, desempate pelo serviceId, e páginas sem duplicar nem omitir', async () => {
    const city = newCity();
    const { token } = await newUser();
    const hosts = [];
    for (const price of [150, 80, 80, 120, 200]) hosts.push(await newHost(city, {}, { price }));
    const expected = hosts
        .map((host) => host.service)
        .sort((a, b) => Number(a.price) - Number(b.price) || a.id.localeCompare(b.id))
        .map((service) => service.id);

    const pages = [];
    for (const page of [1, 2, 3]) pages.push(await search({ city, page, pageSize: 2 }, token));

    assert.deepStrictEqual(pages.flatMap(serviceIds), expected);
    assert.deepStrictEqual(pages.map((res) => res.data.items.length), [2, 2, 1]);
    assert.ok(pages.every((res) => res.data.total === 5));
});

test('parâmetros inválidos: 400 com todos os campos, incluindo os fora do contrato', async () => {
    const { token } = await newUser();

    const res = await search({ sort: 'rating', minPrice: -1, startDate: day(1), size: 'giant', pageSize: 51 }, token);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'VALIDATION_ERROR');
    assert.deepStrictEqual(res.data.details.map((detail) => detail.field), ['sort', 'minPrice', 'endDate', 'size', 'pageSize']);
});

test('o que a busca mostra, a solicitação aceita: mesmo pet e período respondem 201', async () => {
    const city = newCity();
    const { pet, token } = await newTutor();
    await newHost(city, { acceptedSpecies: ['dog'] });

    const res = await search({ city, petId: pet.id, startDate: day(10), endDate: day(13) }, token);
    const [offer] = res.data.items;
    const created = await http.post('/api/v1/reservations',
        { serviceId: offer.serviceId, petId: pet.id, startDate: day(10), endDate: day(13) },
        { headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() } });

    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.data.hostId, offer.hostId);
});
