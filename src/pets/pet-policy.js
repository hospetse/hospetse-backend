import { AppError } from '../lib/app-error.js';

// Domínios do pet (#369). A TSK-01 (#366), que fecharia as listas, foi removida.
// shortcut: listas fechadas só na aplicação; alinhar com as espécies e portes aceitos pelo Host (#110) e levar para CHECK no banco quando forem aprovadas.
export const PET_SPECIES = ['dog', 'cat'];
export const PET_SIZES = ['small', 'medium', 'large'];

// Só Tutor tem pet: o pet aponta para tutors.id, e o TUTOR nasce na conclusão do perfil (PUT /api/v1/me/tutor-profile).
export function requireTutor(user) {
    if (!user.tutor) {
        throw new AppError('Complete seu perfil antes de cadastrar um pet.', 403, 'PROFILE_INCOMPLETE');
    }
    return user.tutor;
}
