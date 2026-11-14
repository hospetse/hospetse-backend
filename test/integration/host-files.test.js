// Arquivos do cadastro do Host (HSP-PBI-008-TSK-05 #325) contra o PostgreSQL real. Exige DATABASE_URL.
// Cria USERs (e-mail it-arquivos-...@exemplo.com) e prestadores de teste, e remove tudo o que criou no after.
// O bucket é o FakeStorage, sem rede. O JWT é assinado por um par de chaves gerado aqui: não depende do Auth.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { FakeStorage } from '../../src/lib/fake-storage.js';
import { prisma } from '../../src/lib/prisma.js';
import { useStorage } from '../../src/lib/storage.js';

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

const storage = new FakeStorage();
useStorage(storage);

const { default: app } = await import('../../src/app.js');
const server = app.listen(0);
await once(server, 'listening');
const baseUrl = `http://localhost:${server.address().port}`;

const userIds = [];

after(async () => {
    server.close();
    // documentos e fotos saem em cascata com o prestador
    const providers = await prisma.provider.findMany({ where: { userId: { in: userIds } }, select: { addressId: true } });
    await prisma.provider.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.address.deleteMany({ where: { id: { in: providers.map((provider) => provider.addressId).filter(Boolean) } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

const MB = 1024 * 1024;
const PDF = Buffer.from('%PDF-1.7 conteúdo');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const withSize = (header, size) => Buffer.concat([header, Buffer.alloc(size - header.length)]);

async function request(method, path, headers, body) {
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body });
    return { status: res.status, data: await res.json().catch(() => null) };
}

// O nome e o tipo informados pelo cliente são falsos de propósito: quem decide é o conteúdo
function form(buffer, fields = {}, fileField = 'file') {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.append(name, value);
    if (buffer) data.append(fileField, new Blob([buffer], { type: 'text/plain' }), 'qualquer.exe');
    return data;
}

const sendDocument = (headers, buffer = PDF, type = 'identity') => request('POST', '/api/v1/me/host/documents', headers, form(buffer, { type }));
const sendPhoto = (headers, buffer = JPEG) => request('POST', '/api/v1/me/host/photos', headers, form(buffer));
const documentLink = (headers, id) => request('GET', `/api/v1/me/host/documents/${id}`, headers);
const fields = (res) => res.data.details.map((detail) => detail.field);

async function newUser() {
    const authUserId = randomUUID();
    const user = await prisma.user.create({ data: { authUserId, email: `it-arquivos-${authUserId}@exemplo.com`, name: 'Teste Arquivos' } });
    userIds.push(user.id);
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(authUserId)
        .setIssuer('hospetse-auth-service')
        .setAudience('hospetse-backend')
        .setExpirationTime('5m')
        .sign(privateKey);
    return { Authorization: `Bearer ${token}` };
}

// overrides completam o rascunho para o teste que chega até a submissão
async function newDraft(overrides = {}) {
    const headers = await newUser();
    const res = await fetch(`${baseUrl}/api/v1/me/host`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerType: 'hotel', name: 'Hotelzinho', ...overrides }),
    });
    return { headers, id: (await res.json()).id };
}

test('sem token: 401 nas três rotas', async () => {
    assert.strictEqual((await sendDocument({})).status, 401);
    assert.strictEqual((await sendPhoto({})).status, 401);
    assert.strictEqual((await documentLink({}, randomUUID())).status, 401);
});

test('sem cadastro de Host: 404', async () => {
    const headers = await newUser();
    assert.strictEqual((await sendDocument(headers)).status, 404);
    assert.strictEqual((await sendPhoto(headers)).status, 404);
});

test('documento válido: 201, sem a chave na resposta, gravado com o tipo vindo do conteúdo', async () => {
    const { headers, id } = await newDraft();

    const res = await sendDocument(headers);

    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(res.data, { id: res.data.id, type: 'identity' });
    const { storageKey } = await prisma.providerDocument.findUnique({ where: { id: res.data.id } });
    assert.match(storageKey, new RegExp(`^documents/${id}/`));
    assert.strictEqual(storage.objects.get(storageKey).contentType, 'application/pdf');
});

test('foto válida: 201 com link assinado, e o banco guarda só a chave', async () => {
    const { headers, id } = await newDraft();

    const res = await sendPhoto(headers);

    assert.strictEqual(res.status, 201);
    assert.match(res.data.url, /signed=1/);
    const { url } = await prisma.providerPhoto.findUnique({ where: { id: res.data.id } });
    assert.match(url, new RegExp(`^photos/${id}/`));
    assert.strictEqual(storage.objects.get(url).contentType, 'image/jpeg');
});

test('tipo de documento inválido e arquivo ausente saem juntos', async () => {
    const { headers } = await newDraft();
    const res = await request('POST', '/api/v1/me/host/documents', headers, form(null, { type: 'contrato' }));

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.data.code, 'VALIDATION_ERROR');
    assert.deepStrictEqual(fields(res), ['type', 'file']);
});

test('arquivo recusado explica o motivo e não chega ao bucket', async () => {
    const { headers, id } = await newDraft();
    const cases = [
        [await sendPhoto(headers, PDF), /JPEG, PNG ou WebP/],
        [await sendDocument(headers, Buffer.from('MZ executável')), /PDF, JPEG ou PNG/],
        [await sendPhoto(headers, withSize(JPEG, 5 * MB + 1)), /5 MB/],
        [await sendDocument(headers, withSize(PDF, 10 * MB + 1)), /10 MB/],
    ];

    for (const [res, reason] of cases) {
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(fields(res), ['file']);
        assert.match(res.data.details[0].message, reason);
    }
    assert.ok(![...storage.objects.keys()].some((key) => key.includes(id)));
});

test('arquivos no tamanho exato do limite passam', async () => {
    const { headers } = await newDraft();
    assert.strictEqual((await sendPhoto(headers, withSize(JPEG, 5 * MB))).status, 201);
    assert.strictEqual((await sendDocument(headers, withSize(PDF, 10 * MB))).status, 201);
});

test('campo de arquivo errado ou corpo que não é multipart: 400', async () => {
    const { headers } = await newDraft();
    const wrongField = await request('POST', '/api/v1/me/host/photos', headers, form(JPEG, {}, 'foto'));
    assert.strictEqual(wrongField.status, 400);
    assert.deepStrictEqual(fields(wrongField), ['file']);

    const json = await request('POST', '/api/v1/me/host/photos', { ...headers, 'Content-Type': 'application/json' }, '{}');
    assert.strictEqual(json.status, 400);
    assert.deepStrictEqual(fields(json), ['file']);
});

test('limites: 5 arquivos por tipo de documento e 10 fotos', async () => {
    const { headers } = await newDraft();
    for (let i = 0; i < 5; i++) assert.strictEqual((await sendDocument(headers)).status, 201);
    for (let i = 0; i < 10; i++) assert.strictEqual((await sendPhoto(headers)).status, 201);

    for (const res of [await sendDocument(headers), await sendPhoto(headers)]) {
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.data.code, 'FILE_LIMIT_REACHED');
    }
    // outro tipo de documento tem o próprio limite
    assert.strictEqual((await sendDocument(headers, PDF, 'proof_of_address')).status, 201);
});

test('link do documento: só o titular recebe', async () => {
    const owner = await newDraft();
    const other = await newDraft();
    const document = await sendDocument(owner.headers);

    const res = await documentLink(owner.headers, document.data.id);
    assert.strictEqual(res.status, 200);
    assert.match(res.data.url, /signed=1/);

    const denied = await documentLink(other.headers, document.data.id);
    const missing = await documentLink(owner.headers, randomUUID());
    assert.strictEqual(denied.status, 404);
    // mesma resposta do inexistente, para não revelar que o documento existe
    assert.deepStrictEqual(denied.data, missing.data);
});

test('id de documento fora do formato: 404, sem erro no banco', async () => {
    const { headers } = await newDraft();
    assert.strictEqual((await documentLink(headers, 'abc')).status, 404);
});

test('se o banco falhar, o arquivo é apagado do bucket', async (t) => {
    t.mock.method(console, 'log', () => {});
    const { headers, id } = await newDraft();
    const create = prisma.providerPhoto.create;
    prisma.providerPhoto.create = async () => {
        throw new Error('banco fora do ar');
    };
    t.after(() => {
        prisma.providerPhoto.create = create;
    });

    const res = await sendPhoto(headers);

    assert.strictEqual(res.status, 500);
    assert.ok(![...storage.objects.keys()].some((key) => key.includes(id)));
});

test('do rascunho ao envio pelas rotas; depois disso, não aceita arquivo e o titular ainda abre o documento', async () => {
    const { headers } = await newDraft({
        description: 'Casa com quintal',
        cpfCnpj: '52998224725',
        address: { zipCode: '01001000', street: 'Rua Teste', number: '1', neighborhood: 'Centro', city: `it-arquivos-${randomUUID()}`, state: 'SP' },
        capacity: 5,
        acceptedSpecies: ['dog'],
        acceptedSizes: ['small'],
    });
    const submit = () => request('POST', '/api/v1/me/host/submit', headers);

    const incomplete = await submit();
    assert.strictEqual(incomplete.status, 400);
    assert.deepStrictEqual(fields(incomplete), ['photos', 'documents.identity', 'documents.proof_of_address']);

    const identity = await sendDocument(headers);
    await sendDocument(headers, JPEG, 'proof_of_address');
    const photo = await sendPhoto(headers);

    const sent = await submit();
    assert.strictEqual(sent.status, 200);
    assert.strictEqual(sent.data.validationStatus, 'pending');

    const provider = await prisma.provider.findUnique({ where: { id: sent.data.id } });
    const { url } = await prisma.providerPhoto.findUnique({ where: { id: photo.data.id } });
    assert.strictEqual(provider.urlPicture, url);

    const late = await sendPhoto(headers);
    assert.strictEqual(late.status, 409);
    assert.strictEqual(late.data.code, 'HOST_ALREADY_SUBMITTED');
    assert.strictEqual((await documentLink(headers, identity.data.id)).status, 200);
});
