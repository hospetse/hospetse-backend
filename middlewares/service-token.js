import crypto from 'node:crypto';

// Comparação em tempo constante: não vaza pelo tempo de resposta quantos caracteres do token conferem.
// shortcut: segredo compartilhado (INTERNAL_SERVICE_TOKEN), trocar pelo token de serviço RS256 quando a #254 do Auth entrar.
function isServiceTokenValid(header) {
    const expected = process.env.INTERNAL_SERVICE_TOKEN;
    if (!expected || !header?.startsWith('Bearer ')) return false;
    const received = Buffer.from(header.slice('Bearer '.length));
    const target = Buffer.from(expected);
    return received.length === target.length && crypto.timingSafeEqual(received, target);
}

// Camada de autenticação: roda antes do controller. Sem token válido, a requisição para aqui.
export function requireServiceToken(req, res, next) {
    if (!isServiceTokenValid(req.headers.authorization)) {
        return res.status(401).json({ code: 'SERVICE_TOKEN_INVALID', message: 'Token de serviço ausente ou inválido' });
    }
    next();
}
