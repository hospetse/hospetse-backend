import { canContract, missingFields } from './profile-policy.js';

// GET /api/v1/me (TSK-04 #262). Campos escolhidos um a um: nada além disso sai na resposta.
export function meController(req, res) {
    const user = req.user;
    res.status(200).json({
        user: { id: user.id, authUserId: user.authUserId, email: user.email, name: user.name },
        profile: { status: user.profileStatus, missingFields: missingFields(user) },
        permissions: { canSearch: true, canContract: canContract(user) },
    });
}
