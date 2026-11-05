import { prisma } from '../lib/prisma.js';
import { verifyAccessToken } from '../lib/jwt.js';

const invalidToken = { code: 'TOKEN_INVALID', message: 'Token ausente ou inválido' };

// Camada de autenticação do usuário: valida o JWT e carrega o USER (com o TUTOR, o endereço e o id do Host) em req.user.
export async function requireUser(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
        return res.status(401).json(invalidToken);
    }

    let sub;
    try {
        ({ sub } = await verifyAccessToken(header.slice('Bearer '.length)));
    } catch {
        // assinatura errada, expirado, iss/aud diferente: tudo vira o mesmo 401
        return res.status(401).json(invalidToken);
    }

    // sub = authUserId, gravado em users.auth_user_id pelo provisionamento (TSK-03); o address entra para o missingFields
    const user = await prisma.user.findUnique({
        where: { authUserId: sub },
        include: { tutor: { include: { address: true } }, provider: { select: { id: true, validationStatus: true } } },
    });
    if (!user) {
        return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'Usuário não encontrado' });
    }

    req.user = user;
    next();
}
