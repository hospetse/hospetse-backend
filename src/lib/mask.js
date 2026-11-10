// CPF ou CNPJ nas respostas (LGPD): só os 4 últimos dígitos. Sem valor, null.
export const maskDocument = (value) => (value ? `***${value.slice(-4)}` : null);
