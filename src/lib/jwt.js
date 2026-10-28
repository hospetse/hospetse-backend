import { importSPKI, jwtVerify } from 'jose';

// Importada só no primeiro uso: assim o app.js continua importável nos testes sem JWT_PUBLIC_KEY.
let publicKey;

// Valida o access token emitido pelo Auth (#254) e devolve os claims. iss e aud iguais aos do src/lib/jwt.js do Auth.
export async function verifyAccessToken(token) {
    publicKey ??= await importSPKI(process.env.JWT_PUBLIC_KEY, 'RS256');
    const { payload } = await jwtVerify(token, publicKey, {
        issuer: 'hospetse-auth-service',
        audience: 'hospetse-backend',
        algorithms: ['RS256'],
    });
    return payload;
}
