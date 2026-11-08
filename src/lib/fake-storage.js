// Implementação para TESTES: guarda os objetos em memória, sem rede. Mesmos métodos do S3Storage.
export class FakeStorage {
    constructor() {
        this.objects = new Map();
    }

    async upload(key, buffer, contentType) {
        this.objects.set(key, { buffer, contentType });
    }

    async signedUrl(key) {
        return `https://fake-storage.test/${key}?signed=1`;
    }

    async remove(key) {
        this.objects.delete(key);
    }
}
