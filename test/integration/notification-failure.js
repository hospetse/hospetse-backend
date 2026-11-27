// Falha no meio do processo, para os testes das notificações (#557): um gatilho no banco faz o INSERT em notifications
// falhar só para o USER informado. Os arquivos de integração rodam em paralelo no mesmo banco, então o gatilho nunca
// pega notificação de outro teste. Devolve a função que remove o gatilho (chamar no finally).
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/lib/prisma.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function failNotificationsFor(userId) {
    // O id entra no SQL do gatilho: só UUID, para não montar SQL com texto qualquer
    if (!UUID.test(userId)) throw new Error('userId precisa ser UUID');
    const name = `it_fail_notification_${randomUUID().replaceAll('-', '')}`;
    await prisma.$executeRawUnsafe(`
        CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW.user_id = '${userId}'::uuid THEN RAISE EXCEPTION 'falha simulada na notificação'; END IF;
            RETURN NEW;
        END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    return async () => {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON notifications`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
    };
}
