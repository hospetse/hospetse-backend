import { contractDenial } from '../users/profile-policy.js';

// Guarda da contratação (TSK-05 #263): roda depois do requireUser e barra antes de chegar ao controller.
export function requireCanContract(req, res, next) {
    const denial = contractDenial(req.user);
    if (denial) {
        return res.status(denial.statusCode).json({ code: denial.code, message: denial.message });
    }
    next();
}
