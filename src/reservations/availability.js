import { AppError } from '../lib/app-error.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Status que ocupam o período na agenda do Host e do pet (HSP-DEC-004). requested não ocupa: o Host ainda não decidiu.
// A ocupação vem das reservas; a agenda da #482 só guarda os dias bloqueados pelo Host
export const OCCUPYING = ['awaiting_payment', 'accepted', 'checked_in'];

// Períodos se cruzam quando um começa antes do outro terminar (o dia da saída não conta, como na #494)
export const overlaps = (startDate, endDate) => ({ startDate: { lt: endDate }, endDate: { gt: startDate } });

// Reservas que ocupam o dia (timestamp da meia-noite UTC): a entrada conta, a saída não
export const occupiedOn = (reservations, day) =>
    reservations.filter((r) => r.startDate.getTime() <= day && day < r.endDate.getTime()).length;

// Maior número de reservas num mesmo dia do período: duas reservas em dias diferentes não disputam a mesma vaga
export function peakOccupancy(reservations, startDate, endDate) {
    let peak = 0;
    for (let day = startDate.getTime(); day < endDate.getTime(); day += DAY_MS) {
        peak = Math.max(peak, occupiedOn(reservations, day));
    }
    return peak;
}

// Dia bloqueado pelo Host (#482). Usada na criação (#494) e no aceite (#491), na transação de quem chama.
// shortcut: agenda pela provider_blocked_dates (um dia por linha); a busca (#476) repete a regra em SQL, mudar juntos
export async function assertNotBlocked(tx, hostId, startDate, endDate) {
    const blocked = await tx.providerBlockedDate.count({ where: { providerId: hostId, date: { gte: startDate, lt: endDate } } });
    if (blocked) throw new AppError('O Host não atende nesse período', 409, 'PERIOD_UNAVAILABLE');
}

// Vaga do Host em todos os dias do período. Usada na criação (#488) e no aceite (#491), dentro da transação de quem chama.
export async function assertVacancy(tx, hostId, startDate, endDate) {
    // shortcut: Host sem capacidade cadastrada atende um pet por vez; exigir a capacidade no cadastro do Host
    const detail = await tx.hotelDetail.findUnique({ where: { providerId: hostId }, select: { capacity: true } });
    const capacity = detail?.capacity ?? 1;
    const reservations = await tx.reservation.findMany({
        where: { status: { in: OCCUPYING }, service: { providerId: hostId }, ...overlaps(startDate, endDate) },
        select: { startDate: true, endDate: true },
    });
    if (peakOccupancy(reservations, startDate, endDate) >= capacity) {
        throw new AppError('Sem vaga no período', 409, 'NO_CAPACITY');
    }
}

// Um pet não fica em duas hospedagens ao mesmo tempo, mesmo em Hosts diferentes (#488)
export async function assertPetFree(tx, petId, startDate, endDate) {
    const busy = await tx.reservation.count({ where: { petId, status: { in: OCCUPYING }, ...overlaps(startDate, endDate) } });
    if (busy) throw new AppError('O pet já tem hospedagem nesse período', 409, 'PET_ALREADY_BOOKED');
}
