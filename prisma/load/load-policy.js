// Regras do gerador de massa de carga (HSP-PBI-083-TSK-02 #577), sem banco: trava de ambiente, flags e CPF.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// Volumes padrão e máximos de cada flag. min 0: a entidade pode ficar de fora
export const VOLUMES = {
    tutors: { default: 10000, min: 1, max: 1000000 },
    hosts: { default: 1000, min: 1, max: 100000 },
    reservations: { default: 20000, min: 0, max: 5000000 },
    conversations: { default: 2000, min: 0, max: 1000000 },
};

// A carga nunca usa DATABASE_URL: um .env apontando para o Railway não é lido por engano.
// Só banco local com nome terminado em _load, fora de produção. Devolve a URL ou lança o motivo, sem mostrar a URL.
export function loadDatabaseUrl(env = process.env) {
    if (env.NODE_ENV === 'production') throw new Error('Recusado: NODE_ENV=production.');
    if (!env.LOAD_DATABASE_URL) throw new Error('Recusado: defina LOAD_DATABASE_URL (a DATABASE_URL nunca é usada).');

    let url;
    try {
        url = new URL(env.LOAD_DATABASE_URL);
    } catch {
        throw new Error('Recusado: LOAD_DATABASE_URL não é uma URL válida.');
    }
    if (!['postgresql:', 'postgres:'].includes(url.protocol)) throw new Error('Recusado: LOAD_DATABASE_URL precisa ser PostgreSQL.');
    if (!LOCAL_HOSTS.includes(url.hostname)) throw new Error(`Recusado: o banco de carga precisa estar em ${LOCAL_HOSTS.join(', ')}.`);
    if (!url.pathname.slice(1).endsWith('_load')) throw new Error('Recusado: o nome do banco de carga precisa terminar em _load.');
    return env.LOAD_DATABASE_URL;
}

// Flags --tutors=N, --hosts=N, --reservations=N, --conversations=N e --clean-only. Devolve todos os erros de uma vez.
export function parseLoadArgs(argv) {
    const errors = [];
    const options = { cleanOnly: false };
    for (const [name, { default: value }] of Object.entries(VOLUMES)) options[name] = value;

    for (const arg of argv) {
        if (arg === '--clean-only') {
            options.cleanOnly = true;
            continue;
        }
        const match = /^--([a-z]+)=(.*)$/.exec(arg);
        const limits = match && VOLUMES[match[1]];
        if (!limits) {
            errors.push(`${arg}: flag desconhecida`);
            continue;
        }
        const value = Number(match[2]);
        if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
            errors.push(`--${match[1]}: inteiro de ${limits.min} a ${limits.max}`);
            continue;
        }
        options[match[1]] = value;
    }
    return { errors, options };
}

function checkDigit(digits) {
    const sum = [...digits].reduce((total, digit, i) => total + Number(digit) * (digits.length + 1 - i), 0);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
}

// CPF válido e único por índice (0 a 1.000.000), para o UNIQUE de tutors.cpf. Base 100000000 + i nunca repete dígitos
export function cpfFromIndex(index) {
    const base = String(100000000 + index);
    const withFirst = base + checkDigit(base);
    return withFirst + checkDigit(withFirst);
}
