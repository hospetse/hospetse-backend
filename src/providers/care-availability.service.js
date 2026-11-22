import { Prisma } from '@prisma/client';
import { AppError } from '../lib/app-error.js';
import { prisma } from '../lib/prisma.js';
import { OCCUPYING } from '../reservations/availability.js';
import { acceptsSql } from '../hosts/host-search.service.js';

const asTime = (value) => new Date(`1970-01-01T${value}:00.000Z`);
const timeText = (value) => value.toISOString().slice(11, 16);
const localDateTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const localStamp = (value) => {
    const parts = Object.fromEntries(localDateTime.formatToParts(value).map(({ type, value: part }) => [type, part]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(value.getUTCMilliseconds()).padStart(3, '0')}`;
};

export async function findApprovedCare(user, db = prisma) {
    const provider = await db.provider.findUnique({ where: { userId: user.id }, select: { id: true, providerType: true, status: true, validationStatus: true, serviceCity: true, serviceNeighborhoods: true } });
    if (!provider || !['pet_sitter', 'pet_walker'].includes(provider.providerType)) throw new AppError('Prestador não encontrado', 404, 'NOT_FOUND');
    if (provider.status !== 'active' || provider.validationStatus !== 'approved') throw new AppError('Prestador não aprovado', 403, 'PROVIDER_NOT_APPROVED');
    return provider;
}

async function busyIntervals(providerId, date) {
    if (!date) return [];
    const day = new Date(`${date}T00:00:00Z`);
    // shortcut: três dias UTC cobrem o dia local; calcular limites UTC exatos se o volume de reservas crescer.
    const from = new Date(day.getTime() - 86400000);
    const through = new Date(day.getTime() + 2 * 86400000);
    const rows = await prisma.reservation.findMany({
        where: { service: { providerId }, status: { in: OCCUPYING }, startDate: { lt: through }, endDate: { gt: from } },
        select: { startDate: true, endDate: true }, orderBy: { startDate: 'asc' },
    });
    const startOfDay = `${date}T00:00:00.000`;
    const endOfDay = `${new Date(day.getTime() + 86400000).toISOString().slice(0, 10)}T00:00:00.000`;
    return rows.flatMap(({ startDate, endDate }) => {
        const start = localStamp(startDate);
        const end = localStamp(endDate);
        if (start >= endOfDay || end <= startOfDay) return [];
        return [{ startTime: start < startOfDay ? '00:00' : start.slice(11, 16), endTime: end >= endOfDay ? '24:00' : end.slice(11, 16) }];
    });
}

export async function getCareAvailability(user, date) {
    const provider = await findApprovedCare(user);
    const [hours, service, walker] = await Promise.all([
        prisma.providerWorkingHours.findMany({ where: { providerId: provider.id }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] }),
        prisma.service.findFirst({ where: { providerId: provider.id }, orderBy: { id: 'asc' }, select: { price: true } }),
        provider.providerType === 'pet_walker' ? prisma.petWalkerDetail.findUnique({ where: { providerId: provider.id }, select: { durationWalk: true } }) : null,
    ]);
    return {
        providerType: provider.providerType,
        serviceCity: provider.serviceCity,
        serviceNeighborhoods: provider.serviceNeighborhoods,
        workingHours: hours.map((hour) => ({ dayOfWeek: hour.dayOfWeek, startTime: timeText(hour.startTime), endTime: timeText(hour.endTime) })),
        price: service ? Number(service.price) : null,
        durationWalkMinutes: walker?.durationWalk ?? null,
        busyIntervals: await busyIntervals(provider.id, date),
    };
}

export async function saveCareAvailability(user, data) {
    await prisma.$transaction(async (tx) => {
        const provider = await findApprovedCare(user, tx);
        await tx.$queryRaw`SELECT id FROM providers WHERE id = ${provider.id}::uuid FOR UPDATE`;
        await findApprovedCare(user, tx);
        await tx.provider.update({ where: { id: provider.id }, data: { serviceCity: data.serviceCity, serviceNeighborhoods: data.serviceNeighborhoods } });
        await tx.providerWorkingHours.deleteMany({ where: { providerId: provider.id } });
        await tx.providerWorkingHours.createMany({ data: data.workingHours.map((hour) => ({
            providerId: provider.id, dayOfWeek: hour.dayOfWeek, startTime: asTime(hour.startTime), endTime: asTime(hour.endTime),
        })) });
        const service = await tx.service.findFirst({ where: { providerId: provider.id }, orderBy: { id: 'asc' }, select: { id: true } });
        if (service) await tx.service.update({ where: { id: service.id }, data: { price: data.price } });
        else await tx.service.create({ data: { providerId: provider.id, name: provider.providerType === 'pet_sitter' ? 'Visita' : 'Passeio', price: data.price } });
        if (provider.providerType === 'pet_walker') {
            await tx.petWalkerDetail.upsert({ where: { providerId: provider.id }, create: { providerId: provider.id, durationWalk: data.durationWalkMinutes }, update: { durationWalk: data.durationWalkMinutes } });
        }
    });
    return getCareAvailability(user);
}

export async function searchCareProviders({ providerType, city, neighborhood, date, startTime, endTime, minPrice, maxPrice, page, pageSize }, pet = {}) {
    const conditions = [
        Prisma.sql`p.provider_type = ${providerType}`,
        Prisma.sql`p.status = 'active'`, Prisma.sql`p.validation_status = 'approved'`, Prisma.sql`s.active = true`,
        Prisma.sql`lower(p.service_city) = lower(${city})`,
        Prisma.sql`EXISTS (SELECT 1 FROM provider_working_hours h WHERE h.provider_id = p.id)`,
    ];
    if (neighborhood !== undefined) conditions.push(Prisma.sql`(cardinality(p.service_neighborhoods) = 0 OR EXISTS (SELECT 1 FROM unnest(p.service_neighborhoods) AS n WHERE lower(n) = lower(${neighborhood})))`);
    if (minPrice !== undefined) conditions.push(Prisma.sql`s.price >= ${minPrice}`);
    if (maxPrice !== undefined) conditions.push(Prisma.sql`s.price <= ${maxPrice}`);
    if (pet.species !== undefined) conditions.push(acceptsSql(Prisma.raw('p.accepted_species'), pet.species));
    if (pet.size !== undefined) conditions.push(acceptsSql(Prisma.raw('p.accepted_sizes'), pet.size));
    if (pet.breed !== undefined) conditions.push(acceptsSql(Prisma.raw('p.accepted_breeds'), pet.breed));
    if (date) {
        const day = new Date(`${date}T12:00:00Z`).getUTCDay();
        conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM provider_working_hours h WHERE h.provider_id = p.id AND h.day_of_week = ${day}
            AND h.start_time <= ${startTime}::time AND h.end_time >= ${endTime}::time)`);
        conditions.push(Prisma.sql`NOT EXISTS (
            SELECT 1 FROM reservations r JOIN services booked ON booked.id = r.service_id
            WHERE booked.provider_id = p.id AND r.status IN (${Prisma.join(OCCUPYING)})
              AND r.start_date < ((${date}::date + ${endTime}::time) AT TIME ZONE 'America/Sao_Paulo')
              AND r.end_date > ((${date}::date + ${startTime}::time) AT TIME ZONE 'America/Sao_Paulo'))`);
    }
    const where = Prisma.sql`FROM services s JOIN providers p ON p.id = s.provider_id
        LEFT JOIN pet_walker_details w ON w.provider_id = p.id WHERE ${Prisma.join(conditions, ' AND ')}`;
    const [rows, [{ total }]] = await prisma.$transaction([
        prisma.$queryRaw`SELECT p.id AS provider_id, s.id AS service_id, p.provider_type, p.name, s.price, p.service_city, p.service_neighborhoods, w.duration_walk ${where}
            ORDER BY s.price, s.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        prisma.$queryRaw`SELECT count(*)::int AS total ${where}`,
    ]);
    return { items: rows.map((row) => ({
        providerId: row.provider_id, serviceId: row.service_id, providerType: row.provider_type, name: row.name,
        price: Number(row.price), serviceCity: row.service_city, serviceNeighborhoods: row.service_neighborhoods,
        durationWalkMinutes: row.duration_walk,
    })), page, pageSize, total };
}
