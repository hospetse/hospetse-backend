// Erro de regra de negócio: o service lança, o controller traduz para HTTP (mesmo padrão do Auth, com o code do contrato).
// details é opcional: lista de { field, message } quando o erro é de validação.
export class AppError extends Error {
    constructor(message, statusCode, code, details) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
    }
}
