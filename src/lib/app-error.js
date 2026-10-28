// Erro de regra de negócio: o service lança, o controller traduz para HTTP (mesmo padrão do Auth, com o code do contrato).
export class AppError extends Error {
    constructor(message, statusCode, code) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.code = code;
    }
}
