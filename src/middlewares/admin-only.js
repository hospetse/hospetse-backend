// Guarda das rotas administrativas (HSP-PBI-007-TSK-04 #313): roda depois do requireUser.
// O papel vem do USER no banco, não do JWT: o token só carrega o sub.
export function requireAdmin(req, res, next) {
    if (req.user.accountType !== 'admin') {
        return res.status(403).json({ code: 'ADMIN_REQUIRED', message: 'Apenas Administradores acessam esta rota.' });
    }
    next();
}
