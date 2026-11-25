import { AppError } from '../lib/app-error.js';
import { prisma } from '../lib/prisma.js';
import { publicFileUrl } from '../lib/storage.js';
import { CONTRACT_TYPES } from './contract-status.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Acompanhamento da contratação (HSP-PBI-052-TSK-01 #542): a linha do tempo do que aconteceu com o pet, só para o Tutor dela.
// Id inválido, inexistente ou de outro Tutor: a mesma resposta, para não revelar que a contratação existe (como no pagamento, #530)
export async function getContractTimelineService(tutor, contractId) {
    const reservation = UUID.test(contractId)
        ? await prisma.reservation.findFirst({
            where: { id: contractId, tutorId: tutor.id },
            select: {
                id: true,
                status: true,
                checkedInAt: true,
                service: { select: { provider: { select: { providerType: true } } } },
                activityLogs: { select: { id: true, activityType: true, description: true, photoUrl: true, registeredAt: true } },
            },
        })
        : null;
    if (!reservation) throw new AppError('Contratação não encontrada', 404, 'NOT_FOUND');

    const events = collectTimelineEvents(reservation).sort(byTime);
    const items = await Promise.all(events.map(async ({ kind, at, description, photoUrl }) => (
        { kind, at: at.toISOString(), description, photoUrl: await publicFileUrl(photoUrl) }
    )));
    return {
        contractId: reservation.id,
        type: CONTRACT_TYPES[reservation.service.provider.providerType],
        status: reservation.status,
        items,
    };
}

// Ponto de extensão único da linha do tempo: check-out (#545) e início/fim de visita ou passeio (#570) entram aqui
// quando essas tasks criarem os campos, sem mudar o contrato.
function collectTimelineEvents(reservation) {
    const events = reservation.activityLogs.map((log) => ({
        id: log.id,
        kind: activityKind(log.activityType),
        at: log.registeredAt,
        description: log.description,
        photoUrl: log.photoUrl,
    }));
    if (reservation.checkedInAt) {
        events.push({ id: reservation.id, kind: 'check_in', at: reservation.checkedInAt, description: null, photoUrl: null });
    }
    return events;
}

// shortcut: [assunção] só 'medication' é medicação, o resto é rotina; confirmar os valores de activity_type com a #539
const activityKind = (activityType) => (activityType === 'medication' ? 'medication' : 'routine');

// Ordem cronológica crescente, com desempate por id. Os eventos vêm de fontes diferentes, então o orderBy do banco não basta
function byTime(a, b) {
    return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
