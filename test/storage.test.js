import { test } from 'node:test';
import assert from 'node:assert';
import { AppError } from '../src/lib/app-error.js';
import { FakeStorage } from '../src/lib/fake-storage.js';
import { S3Storage, detectFileType, fileProblem } from '../src/lib/storage.js';

const PDF = Buffer.from('%PDF-1.7 conteúdo');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const MB = 1024 * 1024;

// Arquivo do tipo informado com exatamente `size` bytes
const withSize = (header, size) => Buffer.concat([header, Buffer.alloc(size - header.length)]);

const ENV = {
    S3_BUCKET: 'bucket-teste',
    S3_ENDPOINT: 'https://storage.invalid',
    S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'id-teste',
    S3_SECRET_ACCESS_KEY: 'segredo-teste',
};

test('detecta o tipo pelo conteúdo', () => {
    assert.strictEqual(detectFileType(PDF), 'application/pdf');
    assert.strictEqual(detectFileType(JPEG), 'image/jpeg');
    assert.strictEqual(detectFileType(PNG), 'image/png');
    assert.strictEqual(detectFileType(WEBP), 'image/webp');
});

test('conteúdo desconhecido ou vazio não tem tipo', () => {
    assert.strictEqual(detectFileType(Buffer.from('<script>alert(1)</script>')), null);
    assert.strictEqual(detectFileType(Buffer.alloc(0)), null);
});

test('documento aceita PDF, JPEG e PNG', () => {
    for (const file of [PDF, JPEG, PNG]) assert.strictEqual(fileProblem('document', file), null);
});

test('documento recusa outro tipo com o motivo', () => {
    assert.match(fileProblem('document', WEBP), /PDF, JPEG ou PNG/);
});

test('foto aceita JPEG, PNG e WebP', () => {
    for (const file of [JPEG, PNG, WEBP]) assert.strictEqual(fileProblem('photo', file), null);
});

test('foto recusa PDF com o motivo', () => {
    assert.match(fileProblem('photo', PDF), /JPEG, PNG ou WebP/);
});

test('arquivo vazio é recusado', () => {
    assert.ok(fileProblem('document', Buffer.alloc(0)));
});

test('documento vai até 10 MB', () => {
    assert.strictEqual(fileProblem('document', withSize(PDF, 10 * MB)), null);
    assert.match(fileProblem('document', withSize(PDF, 10 * MB + 1)), /10 MB/);
});

test('foto vai até 5 MB', () => {
    assert.strictEqual(fileProblem('photo', withSize(JPEG, 5 * MB)), null);
    assert.match(fileProblem('photo', withSize(JPEG, 5 * MB + 1)), /5 MB/);
});

test('link temporário é assinado, expira no prazo padrão e não expõe o segredo', async () => {
    const url = await new S3Storage(ENV).signedUrl('documentos/a.pdf');
    assert.match(url, /X-Amz-Signature=/);
    assert.match(url, /X-Amz-Expires=300/);
    assert.ok(!url.includes('segredo-teste'));
});

test('prazo do link vem da configuração', async () => {
    const url = await new S3Storage({ ...ENV, STORAGE_SIGNED_URL_SECONDS: '60' }).signedUrl('a.pdf');
    assert.match(url, /X-Amz-Expires=60/);
});

test('falha no provedor vira 503 sem vazar o erro original', async (t) => {
    t.mock.method(console, 'log', () => {});
    const storage = new S3Storage(ENV);
    storage.client.send = async () => {
        throw new Error('detalhe interno do provedor');
    };
    await assert.rejects(storage.upload('a.pdf', PDF, 'application/pdf'), (error) => {
        assert.ok(error instanceof AppError);
        assert.strictEqual(error.statusCode, 503);
        assert.strictEqual(error.code, 'STORAGE_UNAVAILABLE');
        assert.ok(!error.message.includes('detalhe interno'));
        return true;
    });
});

test('fake guarda, assina e remove em memória', async () => {
    const storage = new FakeStorage();
    await storage.upload('a.pdf', PDF, 'application/pdf');
    assert.strictEqual(storage.objects.get('a.pdf').contentType, 'application/pdf');
    assert.match(await storage.signedUrl('a.pdf'), /signed=1/);
    await storage.remove('a.pdf');
    assert.strictEqual(storage.objects.size, 0);
});
