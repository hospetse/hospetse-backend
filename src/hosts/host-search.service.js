import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ELIGIBLE_HOST } from './host-policy.js';
import { OCCUPYING } from '../reservations/availability.js';

// Pet ativo do próprio Tutor (o tutorId vem do req.user). O de outro Tutor responde igual ao inexistente.
export function findTutorPet(tutorId, petId) {
    if (!tutorId) return null;
    return prisma.pet.findFirst({
        where: { id: petId, tutorId, active: true },
        select: { petSpecies: true, petSize: true, petBreed: true },
    });
}

// Mesma regra do accepts() da solicitação (#494), em SQL: lista vazia aceita tudo; sem diferenciar maiúsculas.
// value null = o pet não tem o dado: só Host que não restringe aceita.
function acceptsSql(column, value) {
    if (value === null) return Prisma.sql`cardinality(${column}) = 0`;
    return Prisma.sql`(cardinality(${column}) = 0 OR EXISTS (SELECT 1 FROM unnest(${column}) AS v WHERE lower(v) = lower(${value})))`;
}

// Filtros em SQL, e não depois em memória: filtrar depois de paginar perderia e repetiria resultados (AC-02 do #188).
// pet: { species, size, breed } com null para "pet sem o dado"; undefined = filtro não informado.
function whereSql({ city, minPrice, maxPrice, startDate, endDate }, pet) {
    const conditions = [
        Prisma.sql`s.active = true`,
        Prisma.sql`p.provider_type = ${ELIGIBLE_HOST.providerType}`,
        Prisma.sql`p.status = ${ELIGIBLE_HOST.status}`,
        Prisma.sql`p.validation_status = ${ELIGIBLE_HOST.validationStatus}`,
    ];
    if (city !== undefined) conditions.push(Prisma.sql`lower(a.city) = lower(${city})`);
    if (minPrice !== undefined) conditions.push(Prisma.sql`s.price >= ${minPrice}`);
    if (maxPrice !== undefined) conditions.push(Prisma.sql`s.price <= ${maxPrice}`);
    if (pet.species !== undefined) conditions.push(acceptsSql(Prisma.raw('p.accepted_species'), pet.species));
    if (pet.size !== undefined) conditions.push(acceptsSql(Prisma.raw('p.accepted_sizes'), pet.size));
    if (pet.breed !== undefined) conditions.push(acceptsSql(Prisma.raw('p.accepted_breeds'), pet.breed));

    if (startDate !== undefined) {
        // shortcut: agenda pela provider_blocked_dates atual (um dia por linha), como a solicitação; ajustar junto se a #482 mudar
        conditions.push(Prisma.sql`NOT EXISTS (
            SELECT 1 FROM provider_blocked_dates b
            WHERE b.provider_id = p.id AND b.date >= ${startDate}::date AND b.date < ${endDate}::date)`);
        // Mesma conta do assertVacancy (#488): em algum dia do período, as reservas que ocupam já somam a capacidade?
        // Os dias vão em UTC, como as datas gravadas na solicitação; o dia da saída não entra na série.
        conditions.push(Prisma.sql`NOT EXISTS (
            SELECT 1 FROM generate_series(${startDate}::date, ${endDate}::date - 1, interval '1 day') AS d(day)
            WHERE (
                SELECT count(*) FROM reservations r JOIN services rs ON rs.id = r.service_id
                WHERE rs.provider_id = p.id
                  AND r.status IN (${Prisma.join(OCCUPYING)})
                  AND r.start_date <= (d.day AT TIME ZONE 'UTC')
                  AND r.end_date > (d.day AT TIME ZONE 'UTC')
            ) >= COALESCE((SELECT h.capacity FROM hotel_details h WHERE h.provider_id = p.id), 1))`);
    }
    return Prisma.sql`
        FROM services s
        JOIN providers p ON p.id = s.provider_id
        LEFT JOIN addresses a ON a.id = p.address_id
        WHERE ${Prisma.join(conditions, ' AND ')}`;
}

// Só campos públicos, os mesmos do GET /api/v1/hosts/:id (LGPD): CPF/CNPJ, e-mail, telefone e endereço completo não são lidos.
const OFFER_FIELDS = {
    id: true,
    name: true,
    price: true,
    provider: {
        select: {
            id: true,
            name: true,
            urlPicture: true,
            rating: true,
            address: { select: { city: true, neighborhood: true } },
            _count: { select: { reviews: true } },
        },
    },
};

// Busca de ofertas de hospedagem (GET /api/v1/hosts/search, #476). Não conhece HTTP: recebe os filtros já validados.
// Ordem: menor diária primeiro, desempate pelo id do serviço (AC-03), o que deixa a paginação estável (AC-02).
export async function searchHostsService(filters, pet = {}) {
    const where = whereSql(filters, pet);
    const { page, pageSize } = filters;
    const [rows, [{ total }]] = await prisma.$transaction([
        prisma.$queryRaw`SELECT s.id ${where} ORDER BY s.price ASC, s.id ASC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        prisma.$queryRaw`SELECT count(*)::int AS total ${where}`,
    ]);

    const ids = rows.map((row) => row.id);
    const services = await prisma.service.findMany({ where: { id: { in: ids } }, select: OFFER_FIELDS });
    // O findMany não garante a ordem: volta à ordem da consulta paginada
    const byId = new Map(services.map((service) => [service.id, service]));
    return { items: ids.map((id) => byId.get(id)), page, pageSize, total };
}
