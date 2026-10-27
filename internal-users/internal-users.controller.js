import { AppError } from '../lib/app-error.js';
import { provisionUserService } from './internal-users.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Camada HTTP: valida o payload (contrato da TSK-01 #259), chama o service e traduz o resultado em status.
export async function provisionUserController(req, res) {
    const { authUserId } = req.params;
    const { email, name, ...extra } = req.body ?? {};

    // Lista todos os campos inválidos de uma vez
    const details = [];
    if (!UUID.test(authUserId)) details.push({ field: 'authUserId', message: 'deve ser UUID' });
    if (typeof email !== 'string' || email.trim().length > 255 || !EMAIL.test(email.trim())) details.push({ field: 'email', message: 'e-mail inválido' });
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 255) details.push({ field: 'name', message: 'obrigatório, até 255 caracteres' });
    for (const field of Object.keys(extra)) details.push({ field, message: 'não faz parte do contrato' }); // barra "password"
    if (details.length) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details });
    }

    try {
        const { user, created } = await provisionUserService({
            authUserId,
            email: email.trim().toLowerCase(), // mesma normalização do Auth
            name: name.trim()
        });
        return res.status(created ? 201 : 200).json({ userId: user.id, authUserId });
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ code: error.code, message: error.message });
        }
        console.log(error.message); // só a mensagem: nada de e-mail, nome ou token no log
        return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
    }
}
