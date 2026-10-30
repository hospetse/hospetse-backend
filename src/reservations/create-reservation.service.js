import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';
import { assertCanContract } from '../users/profile-policy.js';
import { ELIGIBLE_HOST } from '../hosts/host-policy.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const RESERVATION_FIELDS = {
    id: true,
    status: true,
    serviceId: true,
    petId: true,
    startDate: true,
    endDate: true,
    dailyPrice: true,
    totalValue: true,
    notes: true,
    createdDate: true,
    service: { select: { providerId: true } },
};

// Lista vazia = o Host não restringe (os Hosts anteriores à #479 estão com as listas vazias)
const accepts = (list, value) => list.length === 0 || list.some((item) => item.toLowerCase() === value?.toLowerCase());

// Mesma intenção = mesmo serviço, pet, período e observações
const sameIntent = (saved, data) => saved.serviceId === data.serviceId && saved.petId === data.petId
    && saved.startDate.getTime() === data.startDate.getTime() && saved.endDate.getTime() === data.endDate.getTime()
    && (saved.notes ?? null) === data.notes;

// Reenvio com a mesma Idempotency-Key: devolve a solicitação já criada, ou 409 se a chave veio com outra intenção.
async function replay(tutorId, data) {
    const saved = await prisma.reservation.findUnique({
        where: { tutorId_idempotencyKey: { tutorId, idempotencyKey: data.idempotencyKey } },
        select: RESERVATION_FIELDS,
    });
    if (!saved) return null;
    if (!sameIntent(saved, data)) {
        throw new AppError('Idempotency-Key já usada em outra solicitação', 409, 'IDEMPOTENCY_KEY_REUSED');
    }
    return saved;
}

// Regra de negócio da solicitação de hospedagem (POST /api/v1/reservations, #494). Não conhece HTTP: recebe dados já
// no formato certo. O Tutor vem do req.user (sub do JWT). Devolve { reservation, created }: created false no reenvio.
export async function createReservationService(user, tutor, data) {
    assertCanContract(user); // vale mesmo se a rota perder a guarda (#263)

    const existing = await replay(tutor.id, data);
    if (existing) return { reservation: existing, created: false };

    const [service, pet] = await Promise.all([
        prisma.service.findFirst({
            where: { id: data.serviceId, active: true, provider: ELIGIBLE_HOST },
            select: { id: true, price: true, provider: { select: { id: true, acceptedSpecies: true, acceptedSizes: true, acceptedBreeds: true } } },
        }),
        // Só pet ativo do próprio Tutor: o de outro Tutor responde igual ao inexistente
        prisma.pet.findFirst({
            where: { id: data.petId, tutorId: tutor.id, active: true },
            select: { petSpecies: true, petSize: true, petBreed: true },
        }),
    ]);

    const details = [];
    if (!service) details.push({ field: 'serviceId', message: 'serviço não encontrado ou indisponível' });
    if (!pet) details.push({ field: 'petId', message: 'pet não encontrado' });
    if (service && pet) {
        const host = service.provider;
        if (!accepts(host.acceptedSpecies, pet.petSpecies)) details.push({ field: 'petId', message: 'espécie não aceita pelo Host' });
        if (!accepts(host.acceptedSizes, pet.petSize)) details.push({ field: 'petId', message: 'porte não aceito pelo Host' });
        if (!accepts(host.acceptedBreeds, pet.petBreed)) details.push({ field: 'petId', message: 'raça não aceita pelo Host' });
    }
    if (details.length) throw new AppError('Payload inválido', 400, 'VALIDATION_ERROR', details);

    const nights = Math.round((data.endDate - data.startDate) / DAY_MS);

    try {
        return await prisma.$transaction(async (tx) => {
            // shortcut: agenda pela provider_blocked_dates atual (um dia por linha); ajustar se a #482 trocar o modelo do bloqueio.
            const blocked = await tx.providerBlockedDate.count({
                where: { providerId: service.provider.id, date: { gte: data.startDate, lt: data.endDate } },
            });
            if (blocked) throw new AppError('O Host não atende nesse período', 409, 'PERIOD_UNAVAILABLE');

            const reservation = await tx.reservation.create({
                data: {
                    tutorId: tutor.id,
                    petId: data.petId,
                    serviceId: service.id,
                    startDate: data.startDate,
                    endDate: data.endDate,
                    // Snapshot: o preço do serviço pode mudar depois, a solicitação não
                    dailyPrice: service.price,
                    totalValue: service.price.mul(nights),
                    notes: data.notes,
                    idempotencyKey: data.idempotencyKey,
                },
                select: RESERVATION_FIELDS,
            });
            return { reservation, created: true };
        });
    } catch (error) {
        // P2002 = outro envio com a mesma chave gravou entre o replay e o commit; o UNIQUE é a garantia final
        if (error.code === 'P2002') {
            return { reservation: await replay(tutor.id, data), created: false };
        }
        throw error;
    }
}
