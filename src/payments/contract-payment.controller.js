import { AppError } from '../lib/app-error.js';
import { requireTutor } from '../pets/pet-policy.js';
import { parseContractPayment } from './contract-payment-policy.js';
import { getContractPaymentService, payContractService } from './contract-payment.service.js';

// POST /api/v1/contracts/:id/payment (HSP-PBI-067-TSK-01 #530).
// Ordem no app.js: JWT do usuário → conta e perfil aptos → JSON → este controller. O Tutor vem só do JWT (req.user).
// 202: a tentativa foi registrada; approved/rejected quando o gateway já respondeu, pending quando ainda falta (3D Secure, timeout).
export async function payContractController(req, res) {
    try {
        const tutor = requireTutor(req.user);
        const { details, payment } = parseContractPayment(req.headers, req.body);
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details });
        }

        const result = await payContractService(tutor, req.params.id, payment);
        return res.status(202).json(toResponse(result));
    } catch (error) {
        return sendError(res, error);
    }
}

// GET /api/v1/contracts/:id/payment (#530): comprovante da tentativa mais recente. Consultar não exige perfil apto, só o JWT.
export async function getContractPaymentController(req, res) {
    try {
        const tutor = requireTutor(req.user);
        const result = await getContractPaymentService(tutor, req.params.id);
        return res.status(200).json(toResponse(result));
    } catch (error) {
        return sendError(res, error);
    }
}

// Nunca traz dado do cartão nem o token
function toResponse({ transaction, reservationStatus }) {
    return {
        transactionId: transaction.id,
        status: transaction.status,
        amount: Number(transaction.value),
        failureCode: transaction.failureCode,
        createdAt: transaction.createdDate,
        reservationStatus,
    };
}

function sendError(res, error) {
    if (error instanceof AppError) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
    }
    // Só o nome do erro: o body pode ter dados que o Tutor não devia ter mandado
    console.log(`pagamento da contratação: erro ${error.name}`);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
}
