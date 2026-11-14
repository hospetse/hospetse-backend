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

export function createPetService(tutorId, data) {
    return prisma.pet.create({ data: { ...data, tutorId }, select: PET_FIELDS });
}

// Só os pets ativos do próprio Tutor.
export async function listPetsService(tutorId, { page, pageSize }) {
    const where = { tutorId, active: true };
    const [items, total] = await prisma.$transaction([
        prisma.pet.findMany({ where, select: PET_FIELDS, orderBy: { id: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
        prisma.pet.count({ where }),
    ]);
    return { items, page, pageSize, total };
}

// Atualiza apenas um pet ativo do Tutor autenticado. O tutorId vem do JWT.
export async function updatePetService(tutorId, id, data) {
    const pet = await prisma.pet.findFirst({ where: { id, tutorId, active: true }, select: { id: true } });
    if (!pet) return null;
    return prisma.pet.update({ where: { id: pet.id }, data, select: PET_FIELDS });
}

// Exclusão lógica: preserva o pet para o histórico das reservas.
export async function deletePetService(tutorId, id) {
    const result = await prisma.pet.updateMany({
        where: { id, tutorId, active: true },
        data: { active: false },
    });
    return result.count > 0;
}
