import { prisma } from '../lib/prisma.js';

// Campos que saem nas respostas: o tutorId não sai, porque o pet é sempre do próprio Tutor.
const PET_FIELDS = {
    id: true,
    petName: true,
    petSpecies: true,
    petBreed: true,
    petSize: true,
    petBirthDate: true,
    medicalNotes: true,
    behavioralNotes: true,
};

// Regra de negócio dos pets (TSK-04 #369). Não conhece HTTP; o Tutor vem só do req.user (sub do JWT).
export function createPetService(tutorId, data) {
    return prisma.pet.create({ data: { ...data, tutorId }, select: PET_FIELDS });
}

// Só os pets ativos do próprio Tutor.
// shortcut: ordem estável pelo id (pets não tem created_at); ordenar por data de cadastro quando a coluna existir.
export async function listPetsService(tutorId, { page, pageSize }) {
    const where = { tutorId, active: true };
    const [items, total] = await prisma.$transaction([
        prisma.pet.findMany({ where, select: PET_FIELDS, orderBy: { id: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
        prisma.pet.count({ where }),
    ]);
    return { items, page, pageSize, total };
}
