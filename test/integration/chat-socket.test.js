// Canal WebSocket do chat (HSP-PBI-056, testes da #553) contra o PostgreSQL real, com clientes `ws` de verdade.
// Exige DATABASE_URL. Cria USERs (e-mail it-...@exemplo.com), Tutores, pets, Host, serviço, contratações, conversas e
// mensagens de teste, e remove tudo o que criou no after.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import WebSocket from 'ws';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { prisma } from '../../src/lib/prisma.js';
import { attachChat } from '../../src/conversations/chat-socket.js';

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
// Heartbeat curto só aqui, para o teste do túnel morto não esperar 30 s
attachChat(server, { heartbeatMs: 150 });
const port = server.address().port;
const http = axios.create({ baseURL: `http://localhost:${port}`, validateStatus: () => true });

const userIds = [];
const tutorIds = [];
const reservationIds = [];
const sockets = [];

after(async () => {
    for (const ws of sockets) ws.terminate();
    server.close();
    // mensagens saem em cascata com a conversa; notificações, com o USER
    await prisma.conversation.deleteMany({ where: { reservationId: { in: reservationIds } } });
    await prisma.reservation.deleteMany({ where: { id: { in: reservationIds } } });
    await prisma.pet.deleteMany({ where: { tutorId: { in: tutorIds } } });
    await prisma.tutor.deleteMany({ where: { id: { in: tutorIds } } });
    await prisma.service.deleteMany({ where: { providerId: provider.id } });
    await prisma.provider.deleteMany({ where: { id: provider.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

function sign(authUserId, expiresIn = '5m') {
    return new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(authUserId)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setExpirationTime(expiresIn)
        .sign(privateKey);
}

async function newUser(name) {
    const authUserId = randomUUID();
    const user = await prisma.user.create({ data: { authUserId, email: `it-${authUserId}@exemplo.com`, name } });
    userIds.push(user.id);
    return { user, authUserId, token: await sign(authUserId) };
}

async function newTutor(name) {
    const created = await newUser(name);
    const tutor = await prisma.tutor.create({ data: { userId: created.user.id, name } });
    tutorIds.push(tutor.id);
    const pet = await prisma.pet.create({ data: { tutorId: tutor.id, petName: 'Rex', petSpecies: 'dog' } });
    return { ...created, tutor, pet };
}

const host = await newUser('Dono do Hotel');
const provider = await prisma.provider.create({
    data: { userId: host.user.id, providerType: 'hotel', name: 'Hotel X', services: { create: [{ name: 'Diária', price: 100 }] } },
    include: { services: true },
});

// Contratação com a conversa já aberta (#548)
async function newConversation({ tutor, pet }, status = 'accepted') {
    const reservation = await prisma.reservation.create({
        data: { petId: pet.id, tutorId: tutor.id, serviceId: provider.services[0].id, status, startDate: new Date('2030-01-10'), endDate: new Date('2030-01-12'), totalValue: 200 },
    });
    reservationIds.push(reservation.id);
    const conversation = await prisma.conversation.create({
        data: { reservationId: reservation.id, tutorId: tutor.id, providerId: provider.id, status: 'human_handling' },
    });
    return { reservation, conversation };
}

// Cliente WebSocket com uma fila de eventos recebidos: next() devolve o próximo, na ordem
async function connect(token, options = {}) {
    const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, ...options });
    sockets.push(ws);
    const received = [];
    const waiting = [];
    ws.on('message', (data) => {
        const event = JSON.parse(data);
        const resolve = waiting.shift();
        if (resolve) resolve(event);
        else received.push(event);
    });
    ws.next = () => (received.length ? Promise.resolve(received.shift()) : new Promise((resolve) => waiting.push(resolve)));
    ws.ask = (request) => {
        ws.send(typeof request === 'string' ? request : JSON.stringify(request));
        return ws.next();
    };
    await once(ws, 'open');
    return ws;
}

// Handshake recusado: devolve o status HTTP da resposta, sem abrir o túnel
function rejectedStatus(path, headers = {}) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}${path}`, { headers });
        ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
        ws.on('error', () => resolve('connection closed'));
        ws.on('open', () => resolve('open'));
    });
}

test('conexão sem token, com token inválido, vencido ou de usuário inexistente é recusada com 401', async () => {
    const outsider = randomUUID();
    const cases = [
        {},
        { Authorization: 'Bearer nao-e-jwt' },
        { Authorization: 'Basic abc' },
        { Authorization: `Bearer ${await sign(host.authUserId, '-1m')}` },
        { Authorization: `Bearer ${await sign(outsider)}` },
    ];
    for (const headers of cases) assert.strictEqual(await rejectedStatus('/ws', headers), 401, JSON.stringify(headers));
    // Fora do caminho /ws, nem existe canal
    assert.strictEqual(await rejectedStatus('/outro', { Authorization: `Bearer ${host.token}` }), 'connection closed');
});

test('Tutor e Host trocam mensagens em tempo real; ficam salvas, no histórico e geram notificação', async () => {
    const ana = await newTutor('Ana');
    const { conversation } = await newConversation(ana);
    const anaWs = await connect(ana.token);
    const hostWs = await connect(host.token);

    assert.deepStrictEqual(await anaWs.ask({ type: 'join', conversationId: conversation.id }), { type: 'joined', conversationId: conversation.id, open: true });
    assert.strictEqual((await hostWs.ask({ type: 'join', conversationId: conversation.id })).type, 'joined');

    // A autoria vem do token: o campo "from" forjado é ignorado
    anaWs.send(JSON.stringify({ type: 'send', conversationId: conversation.id, text: '  oi, tudo bem?  ', clientId: 'tmp-1', from: 'Hotel X' }));
    const [toAna, toHost] = await Promise.all([anaWs.next(), hostWs.next()]);
    assert.deepStrictEqual(toHost, toAna);
    assert.strictEqual(toHost.type, 'message');
    assert.strictEqual(toHost.clientId, 'tmp-1');
    assert.deepStrictEqual(toHost.message.author, { role: 'tutor', name: 'Ana' });
    assert.strictEqual(toHost.message.text, 'oi, tudo bem?');
    assert.ok(toHost.message.id && toHost.message.sentAt);

    hostWs.send(JSON.stringify({ type: 'send', conversationId: conversation.id, text: 'tudo! o Rex está ótimo' }));
    const reply = await anaWs.next();
    assert.deepStrictEqual(reply.message.author, { role: 'host', name: 'Dono do Hotel' });
    await hostWs.next();

    // Salvas e no histórico, na ordem certa (PBI-056 AC-02)
    const history = await http.get(`/api/v1/conversations/${conversation.id}/messages`, { headers: { Authorization: `Bearer ${ana.token}` } });
    assert.deepStrictEqual(history.data.items.map((m) => m.text), ['oi, tudo bem?', 'tudo! o Rex está ótimo']);
    assert.strictEqual(history.data.items[0].id, toHost.message.id);

    // Cada mensagem avisa o outro participante (evento para o HSP-PBI-064), sem o texto
    const toHostNotifications = await prisma.notification.findMany({ where: { userId: host.user.id, type: 'new_message', content: { contains: conversation.id } } });
    const toAnaNotifications = await prisma.notification.findMany({ where: { userId: ana.user.id, type: 'new_message' } });
    assert.strictEqual(toHostNotifications.length, 1);
    assert.strictEqual(toAnaNotifications.length, 1);
    assert.ok(!toHostNotifications[0].content.includes('tudo bem'));
});

test('mensagem não vaza para outra conversa', async () => {
    const ana = await newTutor('Ana');
    const beto = await newTutor('Beto');
    const ofAna = (await newConversation(ana)).conversation;
    const ofBeto = (await newConversation(beto)).conversation;
    const anaWs = await connect(ana.token);
    const betoWs = await connect(beto.token);
    await anaWs.ask({ type: 'join', conversationId: ofAna.id });
    await betoWs.ask({ type: 'join', conversationId: ofBeto.id });

    betoWs.send(JSON.stringify({ type: 'send', conversationId: ofBeto.id, text: 'só para o hotel' }));
    await betoWs.next();
    // A Ana não recebeu nada: o próximo evento dela é a resposta deste join
    assert.strictEqual((await anaWs.ask({ type: 'join', conversationId: ofAna.id })).type, 'joined');
});

test('terceiro não entra na conversa nem envia, e não recebe nenhum dado dela', async () => {
    const ana = await newTutor('Ana');
    const beto = await newTutor('Beto');
    const { conversation } = await newConversation(ana);
    const betoWs = await connect(beto.token);

    const joined = await betoWs.ask({ type: 'join', conversationId: conversation.id });
    assert.strictEqual(joined.type, 'error');
    assert.strictEqual(joined.code, 'NOT_FOUND');
    assert.strictEqual(joined.conversationId, undefined);

    const sent = await betoWs.ask({ type: 'send', conversationId: conversation.id, text: 'oi' });
    assert.strictEqual(sent.code, 'NOT_JOINED');
    for (const id of [randomUUID(), 'abc', undefined]) {
        assert.strictEqual((await betoWs.ask({ type: 'join', conversationId: id })).code, 'NOT_FOUND', String(id));
    }
    assert.strictEqual(await prisma.message.count({ where: { conversationId: conversation.id } }), 0);
});

test('envio em contratação concluída, recusada ou cancelada é bloqueado com CONVERSATION_CLOSED', async () => {
    const ana = await newTutor('Ana');
    for (const status of ['completed', 'rejected', 'cancelled']) {
        const { conversation } = await newConversation(ana, status);
        const anaWs = await connect(ana.token);
        assert.deepStrictEqual(await anaWs.ask({ type: 'join', conversationId: conversation.id }), { type: 'joined', conversationId: conversation.id, open: false });
        const sent = await anaWs.ask({ type: 'send', conversationId: conversation.id, text: 'ainda dá?' });
        assert.strictEqual(sent.code, 'CONVERSATION_CLOSED', status);
        assert.strictEqual(await prisma.message.count({ where: { conversationId: conversation.id } }), 0);
    }
});

test('contratação encerrada depois do join: o próximo envio já é bloqueado', async () => {
    const ana = await newTutor('Ana');
    const { reservation, conversation } = await newConversation(ana);
    const anaWs = await connect(ana.token);
    await anaWs.ask({ type: 'join', conversationId: conversation.id });
    await prisma.reservation.update({ where: { id: reservation.id }, data: { status: 'cancelled' } });
    assert.strictEqual((await anaWs.ask({ type: 'send', conversationId: conversation.id, text: 'oi' })).code, 'CONVERSATION_CLOSED');
});

test('pedido inválido recebe erro e o túnel continua aberto', async () => {
    const ana = await newTutor('Ana');
    const { conversation } = await newConversation(ana);
    const anaWs = await connect(ana.token);
    await anaWs.ask({ type: 'join', conversationId: conversation.id });

    assert.strictEqual((await anaWs.ask('não é json')).code, 'INVALID_MESSAGE');
    assert.strictEqual((await anaWs.ask({ type: 'apagar' })).code, 'UNKNOWN_TYPE');
    for (const text of ['', '   ', 'x'.repeat(2001), 42, undefined]) {
        const res = await anaWs.ask({ type: 'send', conversationId: conversation.id, text });
        assert.strictEqual(res.code, 'VALIDATION_ERROR', String(text));
        assert.deepStrictEqual(res.details, [{ field: 'text', message: 'texto de 1 a 2000 caracteres' }]);
    }
    assert.strictEqual(anaWs.readyState, WebSocket.OPEN);
    assert.strictEqual(await prisma.message.count({ where: { conversationId: conversation.id } }), 0);
});

test('o túnel fecha com 4001 quando o token vence', async () => {
    const ana = await newTutor('Ana');
    const anaWs = await connect(await sign(ana.authUserId, '2s'));
    const [code, reason] = await once(anaWs, 'close');
    assert.strictEqual(code, 4001);
    assert.strictEqual(reason.toString(), 'token expirado');
});

test('heartbeat: túnel que não responde o PING é desconectado; o que responde continua', async () => {
    const ana = await newTutor('Ana');
    const alive = await connect(ana.token);
    // autoPong false simula um celular que caiu sem avisar: não responde o PING do servidor
    const dead = await connect(ana.token, { autoPong: false });
    await once(dead, 'close');
    assert.strictEqual(alive.readyState, WebSocket.OPEN);
});
