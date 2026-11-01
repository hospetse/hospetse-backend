import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';
import { OCCUPYING, occupiedOn, overlaps } from '../reservations/availability.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BLOCK_FIELDS = { id: true, date: true, reason: true };

// Cada dia do período, de start (meia-noite UTC) até o dia antes de end
function eachDay(start, end) {
    const days = [];
    for (let day = start.getTime(); day < end.getTime(); day += DAY_MS) days.push(day);
    return days;
}

const occupyingIn = (hostId, start, end) => ({ status: { in: OCCUPYING }, service: { providerId: hostId }, ...overlaps(start, end) });

// Agenda do Host (GET /api/v1/me/host/agenda, #482). Não conhece HTTP; o Host vem do req.user.
// blocked vence occupied: o dia bloqueado não recebe solicitação nova, mesmo com vaga.
// occupied = sem vaga (reservas que ocupam >= capacidade), o mesmo critério da busca (#476).
export async function getAgendaService(hostId, { startDate, endDate }) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const [detail, blocks, reservations] = await Promise.all([
        prisma.hotelDetail.findUnique({ where: { providerId: hostId }, select: { capacity: true } }),
        prisma.providerBlockedDate.findMany({ where: { providerId: hostId, date: { gte: start, lt: end } }, select: BLOCK_FIELDS }),
        prisma.reservation.findMany({ where: occupyingIn(hostId, start, end), select: { startDate: true, endDate: true } }),
    ]);
    // shortcut: Host sem capacidade cadastrada atende um pet por vez, como no assertVacancy; exigir a capacidade no cadastro do Host
    const capacity = detail?.capacity ?? 1;
    const blockByDay = new Map(blocks.map((block) => [block.date.getTime(), block]));

    const days = eachDay(start, end).map((day) => {
        const occupied = occupiedOn(reservations, day);
        const block = blockByDay.get(day);
        const status = block ? 'blocked' : occupied >= capacity ? 'occupied' : 'free';
        return {
            date: new Date(day).toISOString().slice(0, 10),
            status,
            occupied,
            ...(block && { block: { id: block.id, reason: block.reason } }),
        };
    });
    return { startDate, endDate, capacity, days };
}

// Bloqueio de um período (POST /api/v1/me/host/agenda/blocks, #482): uma linha por dia.
// Recusado se alguma reserva que ocupa cair no período: bloquear não pode deixar hospedagem aceita dentro do bloqueio.
// Solicitação só pendente não impede: o aceite dela passa a ser recusado (assertNotBlocked).
export function blockPeriodService(hostId, { startDate, endDate, reason }) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    return prisma.$transaction(async (tx) => {
        // Mesma trava do aceite (#491): bloqueio e aceite do mesmo Host andam em fila, e o segundo já vê o primeiro
        await tx.$queryRaw`SELECT id FROM providers WHERE id = ${hostId}::uuid FOR UPDATE`;

        const busy = await tx.reservation.count({ where: occupyingIn(hostId, start, end) });
        if (busy) throw new AppError('Há hospedagem no período; nenhum dia foi bloqueado', 409, 'PERIOD_OCCUPIED');

        // Dia já bloqueado fica como está, com o motivo antigo: o UNIQUE (provider_id, date) ignora a repetição
        await tx.providerBlockedDate.createMany({
            data: eachDay(start, end).map((day) => ({ providerId: hostId, date: new Date(day), reason })),
            skipDuplicates: true,
        });
        return tx.providerBlockedDate.findMany({
            where: { providerId: hostId, date: { gte: start, lt: end } },
            select: BLOCK_FIELDS,
            orderBy: { date: 'asc' },
        });
    // Mesma trava do aceite: o tempo esperando por ela conta no timeout, e os 5 s padrão não cobrem a latência do Railway
    }, { timeout: 15000 });
}

// Remoção de um dia bloqueado (DELETE /api/v1/me/host/agenda/blocks/:id, #482).
// O filtro pelo Host é o que impede um Host de apagar o bloqueio de outro: o de outro responde igual ao inexistente.
export async function unblockDayService(hostId, id) {
    const { count } = await prisma.providerBlockedDate.deleteMany({ where: { id, providerId: hostId } });
    if (!count) throw new AppError('Bloqueio não encontrado', 404, 'NOT_FOUND');
}
