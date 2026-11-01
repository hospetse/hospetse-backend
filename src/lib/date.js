const DATE = /^\d{4}-\d{2}-\d{2}$/;

// new Date('2026-02-30') vira 02/03 sem erro: só aceita se a data convertida voltar igual ao texto
export const isRealDate = (value) => typeof value === 'string' && DATE.test(value)
    && !isNaN(new Date(value)) && new Date(value).toISOString().slice(0, 10) === value;
