import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from './app-error.js';

const MB = 1024 * 1024;
export const FILE_RULES = {
    document: { maxBytes: 10 * MB, maxLabel: '10 MB', types: ['application/pdf', 'image/jpeg', 'image/png'], typesLabel: 'PDF, JPEG ou PNG' },
    photo: { maxBytes: 5 * MB, maxLabel: '5 MB', types: ['image/jpeg', 'image/png', 'image/webp'], typesLabel: 'JPEG, PNG ou WebP' },
};

const DEFAULT_SIGNED_URL_SECONDS = 300;
const PHOTO_URL_SECONDS = 60 * 60;

// O tipo vem dos primeiros bytes: nome e Content-Type são informados pelo cliente e podem ser falsos.
export function detectFileType(buffer) {
    if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
    if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
}

export const fileTooLargeMessage = (kind) => `O arquivo passa do limite de ${FILE_RULES[kind].maxLabel}`;

// Devolve o motivo da recusa ou null. Não lança, para a rota juntar os erros de todos os campos em VALIDATION_ERROR.
export function fileProblem(kind, buffer) {
    const rules = FILE_RULES[kind];
    if (buffer.length > rules.maxBytes) return fileTooLargeMessage(kind);
    if (!rules.types.includes(detectFileType(buffer))) return `Tipo de arquivo não permitido. Envie ${rules.typesLabel}`;
    return null;
}

// Railway Bucket pela API S3. O bucket é privado: objetos só saem por link temporário.
export class S3Storage {
    constructor(env = process.env) {
        this.bucket = env.S3_BUCKET;
        this.signedUrlSeconds = Number(env.STORAGE_SIGNED_URL_SECONDS) || DEFAULT_SIGNED_URL_SECONDS;
        this.client = new S3Client({
            endpoint: env.S3_ENDPOINT,
            region: env.S3_REGION,
            credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
        });
    }

    async upload(key, buffer, contentType) {
        await this.#send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buffer, ContentType: contentType }));
    }

    async signedUrl(key, expiresIn = this.signedUrlSeconds) {
        const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
        return getSignedUrl(this.client, command, { expiresIn });
    }

    async remove(key) {
        await this.#send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    }

    async #send(command) {
        try {
            await this.client.send(command);
        } catch (error) {
            // só o tipo do erro no log: a chave do objeto identifica o Host
            console.log(`Falha no armazenamento de arquivos: ${error.name}`);
            throw new AppError('Não foi possível processar o arquivo. Tente novamente', 503, 'STORAGE_UNAVAILABLE');
        }
    }
}

let storage;

// criado no primeiro uso: quem só tem URL externa não depende das variáveis S3_*
export function getStorage() {
    storage ??= new S3Storage();
    return storage;
}

// Os testes trocam pelo FakeStorage, para não usar a rede
export function useStorage(implementation) {
    storage = implementation;
}

// Colunas de foto do Host guardam a chave no bucket ou uma URL externa (seed). Só para fotos: documento não passa por aqui.
export async function publicFileUrl(value) {
    if (!value || /^https?:\/\//i.test(value)) return value;
    return getStorage().signedUrl(value, PHOTO_URL_SECONDS);
}
