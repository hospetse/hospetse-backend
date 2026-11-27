// Notificações da jornada (HSP-PBI-064, testes da #557) contra o PostgreSQL real: geração única pelos produtores (#554),
// reprocessamento, falha no meio do processo e a lista do usuário (#555). Pagamento e mensagem ficam nos arquivos deles
// (payment-webhook.test.js e chat-socket.test.js), que já montam o webhook e o WebSocket.
// Exige DATABASE_URL. Cria USERs (e-mail it-...@exemplo.com), Tutores, pets, Hosts, serviços, solicitações e notificações
// de teste, e remove tudo o que criou no after. O JWT é assinado por um par de chaves gerado aqui: não depende do Auth.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { prisma } from '../../src/lib/prisma.js';
import { failNotificationsFor } from './notification-failure.js';

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

after(async () => {
    server.close();
    // notificações saem em cascata com o USER; o resto, na ordem das chaves estrangeiras
    await prisma.reservation.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.pet.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.tutor.deleteMany({ where: { id: { in: tutorIds } } });
    await prisma.service.deleteMany({ where: { providerId: { in: providerIds } } });
    await prisma.provider.deleteMany({ where: { id: { in: providerIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

function sign(authUserId, { expiresIn = '5m', issuer = 'hospetse-auth-service' } = {}) {
    return new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(authUserId)
        .setIssuer(issuer)
        .setAudience('hospetse-backend')
        .setExpirationTime(expiresIn)
        .sign(privateKey);
}

async function newUser(data = {}) {
    const authUserId = randomUUID();
    const user = await prisma.user.create({
        data: { authUserId, email: `it-${authUserId}@exemplo.com`, name: 'Pessoa Secreta', ...data },
    });
    userIds.push(user.id);
    return { user, authUserId, token: await sign(authUserId) };
}

// Tutor com perfil completo e um pet (pode solicitar hospedagem)
async function newTutor() {
    const created = await newUser({ status: 'active', profileStatus: 'complete' });
    const tutor = await prisma.tutor.create({ data: { userId: created.user.id, name: created.user.name } });
    tutorIds.push(tutor.id);
    const pet = await prisma.pet.create({
        data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog', petSize: 'medium', petBreed: 'Vira-lata' },
    });
    return { ...created, tutor, pet };
}

// Host aprovado e ativo, com uma diária; validationStatus muda para os testes da validação do cadastro
async function newHost(validationStatus = 'approved') {
    const created = await newUser();
    const provider = await prisma.provider.create({
        data: {
            userId: created.user.id,
            providerType: 'hotel',
            name: 'Hotelzinho de Teste',
            status: 'active',
            validationStatus,
            submittedAt: new Date(),
            services: { create: [{ name: 'Diária', price: 100 }] },
        },
        include: { services: true },
    });
    providerIds.push(provider.id);
    return { ...created, provider, service: provider.services[0] };
}

// Dia em UTC a partir de hoje (0 = hoje)
const day = (offset) => new Date(new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10));

// Solicitação gravada direto no banco: o que se testa é a decisão e a notificação dela
function newReservation(tutor, host, { status = 'requested', start = 10 } = {}) {
    return prisma.reservation.create({
        data: {
            tutorId: tutor.tutor.id,
            petId: tutor.pet.id,
            serviceId: host.service.id,
            status,
            startDate: day(start),
            endDate: day(start + 2),
            dailyPrice: 100,
            totalValue: 200,
        },
    });
}

const auth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
const requestStay = (tutor, host, key) => http.post(
    '/api/v1/reservations',
    { serviceId: host.service.id, petId: tutor.pet.id, startDate: day(10).toISOString().slice(0, 10), endDate: day(13).toISOString().slice(0, 10) },
    { headers: { ...auth(tutor.token).headers, 'Idempotency-Key': key } },
);
const accept = (host, id) => http.post(`/api/v1/me/host/reservations/${id}/accept`, null, auth(host.token));
const reject = (host, id, reason = 'Lotado no feriado') => http.post(`/api/v1/me/host/reservations/${id}/reject`, { reason }, auth(host.token));
const checkIn = (host, id) => http.patch(`/api/v1/reservations/${id}/check-in`, undefined, auth(host.token));
const list = (token, query = '') => http.get(`/api/v1/me/notifications${query}`, token ? auth(token) : {});
const notificationsOf = ({ user }, type) => prisma.notification.findMany({ where: { userId: user.id, ...(type ? { type } : {}) } });

// O que o produtor gravou: tipo, chave e a referência que o App usa para abrir a tela
function assertOne(rows, { type, eventKey, referenceType, referenceId }) {
    assert.strictEqual(rows.length, 1, `esperava 1 notificação ${type}, veio ${rows.length}`);
    const [row] = rows;
    assert.deepStrictEqual(
        { type: row.type, eventKey: row.eventKey, referenceType: row.referenceType, referenceId: row.referenceId },
        { type, eventKey, referenceType, referenceId },
    );
}

// AC-01 e AC-02: cada evento cria uma notificação por destinatário, e reprocessar não duplica

test('solicitação avisa o Host; o reenvio do App com a mesma Idempotency-Key não duplica', async () => {
    const tutor = await newTutor();
    const host = await newHost();
    const key = randomUUID();

    const first = await requestStay(tutor, host, key);
    assert.strictEqual(first.status, 201);
    const retry = await requestStay(tutor, host, key);
    assert.strictEqual(retry.status, 200);
    assert.strictEqual(retry.data.id, first.data.id);

    assertOne(await notificationsOf(host), {
        type: 'reservation_requested', eventKey: `reservation_requested:${first.data.id}`, referenceType: 'contract', referenceId: first.data.id,
    });
    // Quem solicitou não é avisado da própria solicitação
    assert.strictEqual((await notificationsOf(tutor)).length, 0);
});

test('aceite avisa o Tutor uma vez, mesmo com dois cliques ao mesmo tempo e um terceiro depois', async () => {
    const tutor = await newTutor();
    const host = await newHost();
    const reservation = await newReservation(tutor, host);

    const statuses = (await Promise.all([accept(host, reservation.id), accept(host, reservation.id)])).map((res) => res.status);
    assert.deepStrictEqual(statuses.sort(), [200, 409]);
    assert.strictEqual((await accept(host, reservation.id)).data.code, 'RESERVATION_ALREADY_DECIDED');

    assertOne(await notificationsOf(tutor), {
        type: 'reservation_accepted', eventKey: `reservation_accepted:${reservation.id}`, referenceType: 'contract', referenceId: reservation.id,
    });
    assert.strictEqual((await notificationsOf(host)).length, 0);
});

test('recusa avisa o Tutor uma vez; recusar de novo ou aceitar depois dá 409 sem outra notificação', async () => {
    const tutor = await newTutor();
    const host = await newHost();
    const reservation = await newReservation(tutor, host);

    assert.strictEqual((await reject(host, reservation.id)).status, 200);
    assert.strictEqual((await reject(host, reservation.id)).status, 409);
    assert.strictEqual((await accept(host, reservation.id)).status, 409);

    assertOne(await notificationsOf(tutor), {
        type: 'reservation_rejected', eventKey: `reservation_rejected:${reservation.id}`, referenceType: 'contract', referenceId: reservation.id,
    });
});

test('check-in avisa o Tutor uma vez; o segundo check-in dá 409 sem outra notificação', async () => {
    const tutor = await newTutor();
    const host = await newHost();
    const reservation = await newReservation(tutor, host, { status: 'accepted', start: 0 });

    const statuses = (await Promise.all([checkIn(host, reservation.id), checkIn(host, reservation.id)])).map((res) => res.status);
    assert.deepStrictEqual(statuses.sort(), [200, 409]);

    assertOne(await notificationsOf(tutor), {
        type: 'reservation_checked_in', eventKey: `reservation_checked_in:${reservation.id}`, referenceType: 'contract', referenceId: reservation.id,
    });
});

test('validação do cadastro avisa o prestador; decidir de novo dá 409; nova decisão depois de reenviar é outro evento', async () => {
    const admin = await newUser({ accountType: 'admin' });
    const approved = await newHost('pending');
    const rejected = await newHost('pending');
    const approve = (host) => http.post(`/api/v1/admin/provider-validations/${host.provider.id}/approve`, null, auth(admin.token));
    const refuse = (host) => http.post(`/api/v1/admin/provider-validations/${host.provider.id}/reject`, { reason: 'Documento ilegível' }, auth(admin.token));

    const statuses = (await Promise.all([approve(approved), approve(approved)])).map((res) => res.status);
    assert.deepStrictEqual(statuses.sort(), [200, 409]);
    const [approval, ...others] = await notificationsOf(approved);
    assert.strictEqual(others.length, 0);
    assert.strictEqual(approval.type, 'provider_validation_approved');
    assert.deepStrictEqual([approval.referenceType, approval.referenceId], ['provider_validation', approved.provider.id]);

    // Reprovado, corrige e reenvia: a segunda reprovação é outro evento e gera outra notificação
    const first = await refuse(rejected);
    assert.strictEqual(first.status, 200);
    assert.strictEqual((await refuse(rejected)).data.code, 'PROVIDER_ALREADY_DECIDED');
    await prisma.provider.update({ where: { id: rejected.provider.id }, data: { validationStatus: 'pending', submittedAt: new Date() } });
    const second = await refuse(rejected);
    assert.strictEqual(second.status, 200);

    const rejections = await notificationsOf(rejected, 'provider_validation_rejected');
    assert.deepStrictEqual(
        rejections.map((row) => row.eventKey).sort(),
        [first.data.decidedAt, second.data.decidedAt].map((at) => `provider_validation_rejected:${rejected.provider.id}:${at}`).sort(),
    );
    assert.strictEqual((await notificationsOf(admin)).length, 0);
});

// Falha no meio do processo: o evento e a notificação existem juntos ou nenhum. O servidor cair antes do COMMIT tem o
// mesmo efeito (a transação não termina), e o App tenta de novo

test('falha ao gravar a notificação desfaz a solicitação; o App tenta de novo com a mesma chave e cria uma só', async () => {
    const tutor = await newTutor();
    const host = await newHost();
    const key = randomUUID();

    const restore = await failNotificationsFor(host.user.id);
    try {
        const failed = await requestStay(tutor, host, key);
        assert.strictEqual(failed.status, 500);
        // Sem detalhe do banco na resposta
        assert.deepStrictEqual(failed.data, { code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
        assert.strictEqual(await prisma.reservation.count({ where: { tutorId: tutor.tutor.id } }), 0);
    } finally {
        await restore();
    }

    const retry = await requestStay(tutor, host, key);
    assert.strictEqual(retry.status, 201);
    assert.strictEqual(await prisma.reservation.count({ where: { tutorId: tutor.tutor.id } }), 1);
    assert.strictEqual((await notificationsOf(host, 'reservation_requested')).length, 1);
});

test('falha ao gravar a notificação desfaz o aceite e o check-in; tentar de novo funciona', async () => {
    const tutor = await newTutor();
    const host = await newHost();
    const toAccept = await newReservation(tutor, host);
    const toCheckIn = await newReservation(tutor, host, { status: 'accepted', start: 0 });

    const restore = await failNotificationsFor(tutor.user.id);
    try {
        assert.strictEqual((await accept(host, toAccept.id)).status, 500);
        assert.strictEqual((await checkIn(host, toCheckIn.id)).status, 500);
        const accepted = await prisma.reservation.findUnique({ where: { id: toAccept.id } });
        assert.deepStrictEqual([accepted.status, accepted.decidedAt], ['requested', null]);
        const checkedIn = await prisma.reservation.findUnique({ where: { id: toCheckIn.id } });
        assert.deepStrictEqual([checkedIn.status, checkedIn.checkedInAt], ['accepted', null]);
    } finally {
        await restore();
    }

    assert.strictEqual((await accept(host, toAccept.id)).status, 200);
    assert.strictEqual((await checkIn(host, toCheckIn.id)).status, 200);
    assert.strictEqual((await notificationsOf(tutor)).length, 2);
});

test('falha ao gravar a notificação desfaz a decisão do cadastro', async () => {
    const admin = await newUser({ accountType: 'admin' });
    const host = await newHost('pending');

    const restore = await failNotificationsFor(host.user.id);
    try {
        const res = await http.post(`/api/v1/admin/provider-validations/${host.provider.id}/approve`, null, auth(admin.token));
        assert.strictEqual(res.status, 500);
        const saved = await prisma.provider.findUnique({ where: { id: host.provider.id } });
        assert.deepStrictEqual([saved.validationStatus, saved.validationDecidedAt], ['pending', null]);
    } finally {
        await restore();
    }
    assert.strictEqual((await notificationsOf(host)).length, 0);
});

test('notificação com a mesma chave já gravada não aborta o evento', async () => {
    const tutor = await newTutor();
    const host = await newHost();
    const reservation = await newReservation(tutor, host);
    // Como se um processamento anterior tivesse gravado a notificação e caído antes de mudar o status
    await prisma.notification.create({
        data: { userId: tutor.user.id, type: 'reservation_accepted', eventKey: `reservation_accepted:${reservation.id}`, content: '{}' },
    });

    assert.strictEqual((await accept(host, reservation.id)).status, 200);
    assert.strictEqual((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, 'awaiting_payment');
    assert.strictEqual((await notificationsOf(tutor)).length, 1);
});

// AC-03: a lista do usuário (#555)

// Notificação gravada direto, com o instante escolhido, para testar ordem e paginação
function seed({ user }, createdAt, data = {}) {
    return prisma.notification.create({
        data: {
            userId: user.id,
            type: 'reservation_accepted',
            referenceType: 'contract',
            referenceId: randomUUID(),
            content: '{}',
            createdAt,
            ...data,
        },
    });
}
const at = (minute) => new Date(Date.UTC(2020, 0, 1, 0, minute));

test('cada usuário vê só as próprias, da mais recente para a mais antiga, com a referência para a tela', async () => {
    const ana = await newUser();
    const beto = await newUser();
    const old = await seed(ana, at(1));
    const recent = await seed(ana, at(3), { type: 'new_message', referenceType: 'conversation', read: true });
    const middle = await seed(ana, at(2));
    await seed(beto, at(4));

    const res = await list(ana.token);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.data.items.map((item) => item.id), [recent.id, middle.id, old.id]);
    assert.deepStrictEqual(res.data.items[0], {
        id: recent.id,
        type: 'new_message',
        reference: { type: 'conversation', id: recent.referenceId },
        read: true,
        createdAt: at(3).toISOString(),
    });
    assert.deepStrictEqual([res.data.page, res.data.pageSize, res.data.total], [1, 20, 3]);
    assert.strictEqual((await list(beto.token)).data.total, 1);
});

test('usuário sem notificação recebe lista vazia, mesmo tentando ler as de outro pela URL', async () => {
    const ana = await newUser();
    const beto = await newUser();
    await seed(beto, at(1));

    assert.deepStrictEqual((await list(ana.token)).data, { items: [], page: 1, pageSize: 20, total: 0 });
    // O usuário vem só do JWT: userId na URL é campo fora do contrato
    const forged = await list(ana.token, `?userId=${beto.user.id}`);
    assert.strictEqual(forged.status, 400);
    assert.deepStrictEqual(forged.data.details, [{ field: 'userId', message: 'não faz parte do contrato' }]);
});

test('Tutor, Host e Administrador leem a própria lista', async () => {
    const tutor = await newTutor();
    const host = await newHost();
    const admin = await newUser({ accountType: 'admin' });
    for (const who of [tutor, host, admin]) {
        const mine = await seed(who, at(1));
        const res = await list(who.token);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.data.items.map((item) => item.id), [mine.id]);
    }
});

test('a resposta não traz content, eventKey nem dado pessoal; o content gravado não traz nome nem e-mail', async () => {
    const tutor = await newTutor();
    const host = await newHost();
    const reservation = await newReservation(tutor, host);
    assert.strictEqual((await reject(host, reservation.id, 'Motivo que fica só no banco')).status, 200);

    const res = await list(tutor.token);
    const [item] = res.data.items;
    assert.deepStrictEqual(Object.keys(item).sort(), ['createdAt', 'id', 'read', 'reference', 'type']);
    const body = JSON.stringify(res.data);
    for (const secret of ['Motivo que fica só no banco', 'Pessoa Secreta', tutor.user.email, host.user.email, 'reservation_rejected:']) {
        assert.ok(!body.includes(secret), secret);
    }
    // O que fica no banco: só ids e o motivo da recusa, nunca nome ou e-mail de ninguém
    const [saved] = await notificationsOf(tutor);
    assert.deepStrictEqual(Object.keys(JSON.parse(saved.content)).sort(), ['reason', 'reservationId']);
    for (const secret of ['Pessoa Secreta', tutor.user.email, host.user.email]) assert.ok(!saved.content.includes(secret), secret);
});

test('mesmo instante: o desempate pelo id deixa a ordem igual em toda chamada', async () => {
    const ana = await newUser();
    const tied = [];
    for (let i = 0; i < 4; i++) tied.push(await seed(ana, at(5)));
    const expected = tied.map((row) => row.id).sort().reverse();

    const first = await list(ana.token);
    const second = await list(ana.token);
    assert.deepStrictEqual(first.data.items.map((item) => item.id), expected);
    assert.deepStrictEqual(second.data.items.map((item) => item.id), expected);
    // Página a página, sem repetir nem pular ninguém no empate
    const pages = [];
    for (const page of [1, 2, 3, 4]) pages.push(...(await list(ana.token, `?page=${page}&pageSize=1`)).data.items.map((item) => item.id));
    assert.deepStrictEqual(pages, expected);
});

test('paginação nas fronteiras: pageSize 1 e 50, e página além do fim vazia com o total certo', async () => {
    const ana = await newUser();
    for (const minute of [1, 2, 3]) await seed(ana, at(minute));

    assert.strictEqual((await list(ana.token, '?pageSize=1')).data.items.length, 1);
    assert.strictEqual((await list(ana.token, '?pageSize=50')).data.items.length, 3);
    const last = await list(ana.token, '?page=2&pageSize=2');
    assert.strictEqual(last.data.items.length, 1);
    assert.deepStrictEqual((await list(ana.token, '?page=99&pageSize=2')).data, { items: [], page: 99, pageSize: 2, total: 3 });
});

test('parâmetros inválidos: 400 com todos os campos', async () => {
    const ana = await newUser();
    const cases = [
        ['?page=0&pageSize=51&userId=x', ['userId', 'page', 'pageSize']],
        ['?page=-1', ['page']],
        ['?page=1.5', ['page']],
        ['?page=abc', ['page']],
        ['?pageSize=0', ['pageSize']],
        ['?pageSize=', ['pageSize']],
        ['?page=1&page=2', ['page']],
    ];
    for (const [query, fields] of cases) {
        const res = await list(ana.token, query);
        assert.strictEqual(res.status, 400, query);
        assert.strictEqual(res.data.code, 'VALIDATION_ERROR', query);
        assert.deepStrictEqual(res.data.details.map((detail) => detail.field), fields, query);
    }
});

test('notificação antiga sem referência aparece com reference null', async () => {
    const ana = await newUser();
    await seed(ana, at(1), { type: 'service_started', referenceType: null, referenceId: null });
    assert.strictEqual((await list(ana.token)).data.items[0].reference, null);
});

test('sem token, com token inválido, vencido ou de outro emissor: 401; usuário inexistente: 404', async () => {
    const ana = await newUser();
    await seed(ana, at(1));
    const tokens = [
        undefined,
        'nao-e-jwt',
        await sign(ana.authUserId, { expiresIn: '-1m' }),
        await sign(ana.authUserId, { issuer: 'outro-emissor' }),
    ];
    for (const token of tokens) {
        const res = await list(token);
        assert.strictEqual(res.status, 401, String(token));
        assert.ok(!JSON.stringify(res.data).includes('items'));
    }
    assert.strictEqual((await list(await sign(randomUUID()))).status, 404);
});

// Eventos sem produtor ainda (#554): entram quando a task de cada um existir
test.todo('check-out da hospedagem avisa o Tutor uma vez (#545)');
test.todo('início e fim de visita e passeio avisam o Tutor uma vez (#570)');
