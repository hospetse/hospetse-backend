import { AppError } from '../lib/app-error.js';
import { isValidCpf, stripCpf } from '../lib/cpf.js';
import { isAdult } from '../users/profile-policy.js';
import { completeTutorProfileService, isCpfTaken } from './tutor-profile.service.js';

// [assunção] telefone só com dígitos e DDD, sem +55; CEP com ou sem hífen. Alinhar com o mobile.
const PHONE = /^\d{10,11}$/;
const ZIP_CODE = /^\d{5}-?\d{3}$/;
const STATE = /^[A-Za-z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ADDRESS_FIELDS = ['zipCode', 'street', 'number', 'complement', 'neighborhood', 'city', 'state'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.trim().length <= max;
// new Date('2000-02-30') vira 01/03 sem erro: só aceita se a data convertida voltar igual ao texto
const isRealDate = (value) => typeof value === 'string' && DATE.test(value)
    && !isNaN(new Date(value)) && new Date(value).toISOString().slice(0, 10) === value;

// Camada HTTP do PUT /api/v1/me/tutor-profile (TSK-04 #275): valida o payload, chama o service e traduz o resultado em status.
// O usuário vem só do JWT (req.user): nenhum id do body ou da URL é aceito.
export async function tutorProfileController(req, res) {
    const { cpf, birthDate, phone, address, emergencyContact, ...extra } = req.body ?? {};

    // Lista todos os campos inválidos de uma vez. Nunca devolve o valor recebido (o CPF não pode voltar na resposta).
    const details = [];
    const invalid = (field, message) => details.push({ field, message });

    const cleanCpf = typeof cpf === 'string' ? stripCpf(cpf) : '';
    if (!isValidCpf(cleanCpf)) invalid('cpf', 'CPF inválido');

    if (!isRealDate(birthDate)) invalid('birthDate', 'data no formato YYYY-MM-DD');
    else if (!isAdult(birthDate)) invalid('birthDate', 'idade mínima de 18 anos');

    if (typeof phone !== 'string' || !PHONE.test(phone)) invalid('phone', 'só dígitos, com DDD (10 ou 11)');

    if (!isObject(emergencyContact)) {
        invalid('emergencyContact', 'obrigatório');
    } else {
        if (!isText(emergencyContact.name, 255)) invalid('emergencyContact.name', 'obrigatório, até 255 caracteres');
        if (typeof emergencyContact.phone !== 'string' || !PHONE.test(emergencyContact.phone)) {
            invalid('emergencyContact.phone', 'só dígitos, com DDD (10 ou 11)');
        }
    }

    if (!isObject(address)) {
        invalid('address', 'obrigatório');
    } else {
        if (typeof address.zipCode !== 'string' || !ZIP_CODE.test(address.zipCode)) invalid('address.zipCode', 'deve ter 8 dígitos');
        if (!isText(address.street, 255)) invalid('address.street', 'obrigatório, até 255 caracteres');
        if (!isText(address.number, 20)) invalid('address.number', 'obrigatório, até 20 caracteres');
        if (address.complement != null && address.complement !== '' && !isText(address.complement, 100)) {
            invalid('address.complement', 'até 100 caracteres');
        }
        if (!isText(address.neighborhood, 100)) invalid('address.neighborhood', 'obrigatório, até 100 caracteres');
        if (!isText(address.city, 100)) invalid('address.city', 'obrigatório, até 100 caracteres');
        if (typeof address.state !== 'string' || !STATE.test(address.state)) invalid('address.state', 'sigla com 2 letras');
        for (const field of Object.keys(address)) {
            if (!ADDRESS_FIELDS.includes(field)) invalid(`address.${field}`, 'não faz parte do contrato');
        }
    }

    for (const field of Object.keys(extra)) invalid(field, 'não faz parte do contrato');

    try {
        // Só consulta o banco se o CPF é válido; o duplicado sai junto com os outros erros
        if (isValidCpf(cleanCpf) && await isCpfTaken(cleanCpf, req.user.id)) invalid('cpf', 'CPF já cadastrado');
        if (details.length) {
            return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Payload inválido', details });
        }

        await completeTutorProfileService(req.user, {
            cpf: cleanCpf,
            birthDate,
            phone,
            emergencyContact: { name: emergencyContact.name.trim(), phone: emergencyContact.phone },
            address: {
                zipCode: address.zipCode.replace('-', ''),
                street: address.street.trim(),
                number: address.number.trim(),
                complement: address.complement?.trim() || null,
                neighborhood: address.neighborhood.trim(),
                city: address.city.trim(),
                state: address.state.toUpperCase(),
            },
        });
        return res.status(204).end();
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ code: error.code, message: error.message, details: error.details });
        }
        console.log(error.message); // só a mensagem: o erro do Prisma pode trazer o CPF
        return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
    }
}
