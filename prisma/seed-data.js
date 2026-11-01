export const profile = {
    cpf: '52998224725', birthDate: new Date('1990-01-01'), phone: '11900000001',
    emergencyContactName: 'Contato Demonstração', emergencyContactPhone: '11900000002',
};
export const address = {
    zipCode: '01001000', street: 'Rua de Demonstração', number: '100', complement: null,
    neighborhood: 'Bairro de Demonstração', city: 'São Paulo', state: 'SP',
};
// Raças (#498): sem raça, Host que restringe raça nunca combinaria com os pets do seed
export const pets = [
    { id: '49700000-0000-4000-8000-000000000011', petName: 'Rex', petSpecies: 'dog', petSize: 'medium', petBreed: 'Vira-lata', active: true },
    { id: '49700000-0000-4000-8000-000000000012', petName: 'Mia', petSpecies: 'cat', petSize: 'small', petBreed: 'Siamês', active: true },
    { id: '49700000-0000-4000-8000-000000000013', petName: 'Thor', petSpecies: 'dog', petSize: 'large', petBreed: 'Labrador', active: true },
];

const photo = (text) => `https://placehold.co/800x600/png?text=${encodeURIComponent(text)}`;
const hostAddress = (id, city, state, zipCode, neighborhood) => ({
    id, zipCode, street: 'Rua de Demonstração', number: '200', complement: null, neighborhood, city, state,
});

// Hosts de demonstração (#498). accountId = conta de seed-accounts.js com role host.
// Validados gravam os mesmos valores do ELIGIBLE_HOST (hotel, active, approved): a busca não tem desvio para o seed.
// Agenda em dias contados a partir da data em que o seed roda; [from, to) como nas reservas.
export const hosts = [
    {
        key: 'aberto',
        accountId: '49800000-0000-4000-8000-000000000001',
        provider: {
            id: '49800000-0000-4000-8000-000000000101', providerType: 'hotel', name: 'Hotel Aberto Demonstração',
            description: 'Aceita qualquer pet. Dados de demonstração.', status: 'active', validationStatus: 'approved',
            acceptedSpecies: [], acceptedSizes: [], acceptedBreeds: [], urlPicture: photo('Hotel Aberto'),
        },
        address: hostAddress('49800000-0000-4000-8000-000000000201', 'São Paulo', 'SP', '01310100', 'Bela Vista'),
        service: { id: '49800000-0000-4000-8000-000000000301', name: 'Diária', price: 80 },
        capacity: 3,
        photos: [photo('Hotel Aberto 1'), photo('Hotel Aberto 2')],
    },
    {
        key: 'caes',
        accountId: '49800000-0000-4000-8000-000000000002',
        provider: {
            id: '49800000-0000-4000-8000-000000000102', providerType: 'hotel', name: 'Hotel Só Cães Demonstração',
            description: 'Cães de porte pequeno e médio. Dados de demonstração.', status: 'active', validationStatus: 'approved',
            acceptedSpecies: ['dog'], acceptedSizes: ['small', 'medium'], acceptedBreeds: [], urlPicture: photo('Hotel Só Cães'),
        },
        address: hostAddress('49800000-0000-4000-8000-000000000202', 'São Paulo', 'SP', '05422000', 'Pinheiros'),
        service: { id: '49800000-0000-4000-8000-000000000302', name: 'Diária', price: 120 },
        capacity: 2,
        photos: [photo('Hotel Só Cães')],
        blocked: [{ from: 7, to: 10, reason: 'Manutenção (demonstração)' }],
    },
    {
        key: 'gatos',
        accountId: '49800000-0000-4000-8000-000000000003',
        provider: {
            id: '49800000-0000-4000-8000-000000000103', providerType: 'hotel', name: 'Hotel Gatos Demonstração',
            description: 'Só gatos. Dados de demonstração.', status: 'active', validationStatus: 'approved',
            acceptedSpecies: ['cat'], acceptedSizes: [], acceptedBreeds: [], urlPicture: photo('Hotel Gatos'),
        },
        address: hostAddress('49800000-0000-4000-8000-000000000203', 'Campinas', 'SP', '13015000', 'Centro'),
        service: { id: '49800000-0000-4000-8000-000000000303', name: 'Diária', price: 150 },
        capacity: 1,
        photos: [photo('Hotel Gatos')],
        // Ocupação com a Mia do Tutor completo: a Mia fica indisponível nesse período (PET_ALREADY_BOOKED)
        occupied: { reservationId: '49800000-0000-4000-8000-000000000401', petId: pets[1].id, from: 14, to: 17 },
    },
    {
        key: 'racas',
        accountId: '49800000-0000-4000-8000-000000000004',
        provider: {
            id: '49800000-0000-4000-8000-000000000104', providerType: 'hotel', name: 'Hotel Raças Demonstração',
            description: 'Só Labrador e Golden. Dados de demonstração.', status: 'active', validationStatus: 'approved',
            acceptedSpecies: ['dog'], acceptedSizes: [], acceptedBreeds: ['Labrador', 'Golden'], urlPicture: photo('Hotel Raças'),
        },
        address: hostAddress('49800000-0000-4000-8000-000000000204', 'Rio de Janeiro', 'RJ', '22041001', 'Copacabana'),
        service: { id: '49800000-0000-4000-8000-000000000304', name: 'Diária', price: 200 },
        capacity: 2,
        photos: [photo('Hotel Raças')],
    },
    {
        key: 'pendente',
        accountId: '49800000-0000-4000-8000-000000000005',
        provider: {
            id: '49800000-0000-4000-8000-000000000105', providerType: 'hotel', name: 'Hotel Pendente Demonstração',
            description: 'Aguardando validação. Não aparece na busca.', status: 'active', validationStatus: 'pending',
            acceptedSpecies: [], acceptedSizes: [], acceptedBreeds: [], urlPicture: photo('Hotel Pendente'),
        },
        address: hostAddress('49800000-0000-4000-8000-000000000205', 'São Paulo', 'SP', '04538000', 'Itaim Bibi'),
        service: { id: '49800000-0000-4000-8000-000000000305', name: 'Diária', price: 90 },
        capacity: 1,
        photos: [photo('Hotel Pendente')],
    },
    {
        key: 'inativo',
        accountId: '49800000-0000-4000-8000-000000000006',
        provider: {
            id: '49800000-0000-4000-8000-000000000106', providerType: 'hotel', name: 'Hotel Inativo Demonstração',
            description: 'Inativo. Não aparece na busca.', status: 'inactive', validationStatus: 'approved',
            acceptedSpecies: [], acceptedSizes: [], acceptedBreeds: [], urlPicture: photo('Hotel Inativo'),
        },
        address: hostAddress('49800000-0000-4000-8000-000000000206', 'São Paulo', 'SP', '04543000', 'Vila Olímpia'),
        service: { id: '49800000-0000-4000-8000-000000000306', name: 'Diária', price: 90 },
        capacity: 1,
        photos: [photo('Hotel Inativo')],
    },
];
