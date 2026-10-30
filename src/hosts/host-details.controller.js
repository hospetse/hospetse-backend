import { findPublicHostService } from './host-details.service.js';

// O id vai para uma coluna UUID: texto em outro formato faria o Prisma lançar erro (500), então já responde 404
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = { code: 'NOT_FOUND', message: 'Host não encontrado' };

// Camada HTTP do GET /api/v1/hosts/:id (HSP-PBI-031-TSK-01 #479): o Tutor consulta os dados públicos de um Host antes de solicitar.
// Mesmo 404 para inexistente e não elegível, para não revelar que um Host pendente ou inativo existe.
export async function hostDetailsController(req, res) {
    if (!UUID.test(req.params.id)) return res.status(404).json(notFound);

    const host = await findPublicHostService(req.params.id);
    if (!host) return res.status(404).json(notFound);

    // Decimal do Prisma vira número no JSON; campos escolhidos um a um, como no /me
    res.status(200).json({
        id: host.id,
        name: host.name,
        description: host.description,
        pictureUrl: host.urlPicture,
        location: { city: host.address?.city ?? null, neighborhood: host.address?.neighborhood ?? null },
        photos: host.photos.map((photo) => photo.url),
        accepts: { species: host.acceptedSpecies, sizes: host.acceptedSizes, breeds: host.acceptedBreeds },
        services: host.services.map((service) => ({ id: service.id, name: service.name, price: Number(service.price) })),
        reputation: { rating: host.rating == null ? null : Number(host.rating), reviewCount: host._count.reviews },
    });
}
