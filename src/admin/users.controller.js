import { AppError } from '../lib/app-error.js';
import { maskDocument, maskEmail, maskPhone } from '../lib/mask.js';
import { parseUserListQuery, userRoles } from './users-policy.js';
import { findUserService, listUsersService } from './users.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(res, error) {
    if (error instanceof AppError) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
    }
    console.log(error.message); // só a mensagem: nada de e-mail, CPF ou telefone no log
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
}

// GET /api/v1/admin/users?q=&role=&status=&page=1&pageSize=20 (#580).
// Ordem no app.js: JWT do usuário → papel Administrador → este controller.
export async function listUsersController(req, res) {
    try {
        const { details, filters } = parseUserListQuery(req.query);
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Parâmetros inválidos', details });
        }
        const result = await listUsersService(filters);
        return res.status(200).json({ ...result, items: result.items.map(toListItem) });
    } catch (error) {
        return sendError(res, error);
    }
}

// GET /api/v1/admin/users/:id (#580).
// [assunção] As ocorrências ficam fora da resposta até a #413 modelar os estados da conta, as ocorrências e as penalidades.
export async function getUserController(req, res) {
    try {
        if (!UUID.test(req.params.id)) {
            throw new AppError('Parâmetros inválidos', 400, 'VALIDATION_ERROR', [{ field: 'id', message: 'UUID obrigatório' }]);
        }
        return res.status(200).json(toDetail(await findUserService(req.params.id)));
    } catch (error) {
        return sendError(res, error);
    }
}

// Campos escolhidos um a um, nas duas respostas: e-mail, CPF, CNPJ e telefone só saem mascarados (LGPD).
function toListItem(user) {
    return {
        id: user.id,
        name: user.name,
        emailMasked: maskEmail(user.email),
        accountType: user.accountType,
        roles: userRoles(user),
        status: user.status,
        createdAt: user.createdAt,
    };
}

function toDetail(user) {
    const { tutor, provider } = user;
    return {
        id: user.id,
        name: user.name,
        emailMasked: maskEmail(user.email),
        accountType: user.accountType,
        status: user.status,
        profileStatus: user.profileStatus,
        roles: userRoles(user),
        createdAt: user.createdAt,
        tutor: tutor && { cpfMasked: maskDocument(tutor.cpf), phoneMasked: maskPhone(tutor.phone) },
        provider: provider && {
            id: provider.id,
            providerType: provider.providerType,
            validationStatus: provider.validationStatus,
            cpfCnpjMasked: maskDocument(provider.cpfCnpj),
        },
        contracts: user.contracts.map((reservation) => ({
            id: reservation.id,
            // Quem pediu é o Tutor; senão, a solicitação chegou em um serviço do usuário
            as: reservation.tutorId === tutor?.id ? 'tutor' : 'provider',
            status: reservation.status,
            startDate: reservation.startDate.toISOString().slice(0, 10),
            totalValue: Number(reservation.totalValue),
        })),
        penalties: user.penalties,
    };
}
