-- HSP-PBI-008-TSK-03 (#323): documentos do Host para a validação do perfil.
-- Só acrescenta: tabela nova, sem alterar nem apagar linhas existentes.
-- storage_key em vez de URL pública: o documento é privado e só sai por link assinado (#324).
-- Sem UNIQUE (provider_id, type): um mesmo tipo pode ter mais de um arquivo (ex.: frente e verso da identidade).

-- CreateTable
CREATE TABLE "provider_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "storage_key" VARCHAR(1024) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_documents_pkey" PRIMARY KEY ("id"),
    -- shortcut: tipos provisórios, revisar quando o fluxo de validação do Admin for definido
    CONSTRAINT "provider_documents_type_check" CHECK ("type" IN ('identity', 'proof_of_address', 'cnpj_card'))
);

-- CreateIndex
CREATE INDEX "provider_documents_provider_id_idx" ON "provider_documents"("provider_id");

-- AddForeignKey
ALTER TABLE "provider_documents" ADD CONSTRAINT "provider_documents_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
