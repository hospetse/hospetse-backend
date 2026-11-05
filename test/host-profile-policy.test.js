// Regras do cadastro do Host (#325), sem HTTP nem banco.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseHostDraft, submissionProblems } from '../src/hosts/host-profile-policy.js';

const CPF = '52998224725';
const CNPJ = '11222333000181';

const fields = (details) => details.map((detail) => detail.field);

const completeProvider = (overrides = {}) => ({
    description: 'Casa com quintal',
    cpfCnpj: CPF,
    address: { city: 'São Paulo' },
    acceptedSpecies: ['dog'],
    acceptedSizes: ['small'],
    photos: [{ id: 'f1', url: 'photos/1.jpg' }],
    documents: [{ id: 'd1', type: 'identity' }, { id: 'd2', type: 'proof_of_address' }],
    ...overrides,
});

test('rascunho mínimo: só providerType e name', () => {
    const { details, data } = parseHostDraft({ providerType: 'hotel', name: '  Hotelzinho  ' });
    assert.deepStrictEqual(details, []);
    assert.strictEqual(data.name, 'Hotelzinho');
});

test('campo omitido fica undefined, para não apagar o que já foi salvo', () => {
    const { data } = parseHostDraft({ providerType: 'hotel', name: 'Hotelzinho' });
    for (const field of ['description', 'cpfCnpj', 'address', 'acceptedSpecies', 'acceptedSizes', 'acceptedBreeds']) {
        assert.strictEqual(data[field], undefined, field);
    }
});

test('null limpa a descrição e o documento', () => {
    const { data } = parseHostDraft({ providerType: 'hotel', name: 'Hotelzinho', description: null, cpfCnpj: null });
    assert.strictEqual(data.description, null);
    assert.strictEqual(data.cpfCnpj, null);
});

test('devolve todos os campos inválidos de uma vez', () => {
    const { details } = parseHostDraft({
        providerType: 'pet_sitter',
        name: '',
        description: 'x'.repeat(2001),
        cpfCnpj: '123',
        address: { zipCode: '1' },
        acceptedSpecies: ['dragon'],
        acceptedSizes: 'small',
        acceptedBreeds: [''],
        userId: 'de-outro-usuario',
    });
    for (const field of ['providerType', 'name', 'description', 'cpfCnpj', 'address.zipCode', 'address.street', 'acceptedSpecies', 'acceptedSizes', 'acceptedBreeds', 'userId']) {
        assert.ok(fields(details).includes(field), field);
    }
});

test('body vazio pede os dois campos obrigatórios', () => {
    assert.deepStrictEqual(fields(parseHostDraft(undefined).details), ['providerType', 'name']);
});

test('CPF e CNPJ com pontuação são gravados só com dígitos', () => {
    const base = { providerType: 'hotel', name: 'Hotelzinho' };
    assert.strictEqual(parseHostDraft({ ...base, cpfCnpj: '529.982.247-25' }).data.cpfCnpj, CPF);
    assert.strictEqual(parseHostDraft({ ...base, cpfCnpj: '11.222.333/0001-81' }).data.cpfCnpj, CNPJ);
});

test('CPF válido é devolvido mesmo com outros erros, para conferir o duplicado', () => {
    assert.strictEqual(parseHostDraft({ name: '', cpfCnpj: CPF }).validCpfCnpj, CPF);
    assert.strictEqual(parseHostDraft({ name: '', cpfCnpj: '123' }).validCpfCnpj, undefined);
});

test('o valor inválido de CPF ou CNPJ não volta na mensagem', () => {
    const { details } = parseHostDraft({ providerType: 'hotel', name: 'Hotelzinho', cpfCnpj: '52998224724' });
    assert.ok(!JSON.stringify(details).includes('52998224724'));
});

test('cadastro completo com CPF pode ser enviado', () => {
    assert.deepStrictEqual(submissionProblems(completeProvider()), []);
});

test('rascunho vazio lista tudo o que falta', () => {
    const problems = submissionProblems({
        description: null, cpfCnpj: null, address: null, acceptedSpecies: [], acceptedSizes: [], photos: [], documents: [],
    });
    assert.deepStrictEqual(fields(problems), [
        'description', 'cpfCnpj', 'address', 'acceptedSpecies', 'acceptedSizes', 'photos', 'documents.identity', 'documents.proof_of_address',
    ]);
});

test('CNPJ também exige o cartão CNPJ', () => {
    assert.deepStrictEqual(fields(submissionProblems(completeProvider({ cpfCnpj: CNPJ }))), ['documents.cnpj_card']);
    const documents = [...completeProvider().documents, { id: 'd3', type: 'cnpj_card' }];
    assert.deepStrictEqual(submissionProblems(completeProvider({ cpfCnpj: CNPJ, documents })), []);
});

test('CPF não exige o cartão CNPJ', () => {
    assert.ok(!fields(submissionProblems(completeProvider())).includes('documents.cnpj_card'));
});
