// CPF ou CNPJ nas respostas (LGPD): só os 4 últimos dígitos. Sem valor, null.
export const maskDocument = (value) => (value ? `***${value.slice(-4)}` : null);

// Telefone: a mesma regra, só os 4 últimos dígitos.
export const maskPhone = maskDocument;

// E-mail: a primeira letra e o domínio (l***@outlook.com.br). Basta para o Administrador reconhecer a conta, sem expor o endereço.
export const maskEmail = (value) => (value ? `${value[0]}***${value.slice(value.lastIndexOf('@'))}` : null);
