-- HSP-PBI-022-TSK-04 (#404): decisão do Administrador sobre o cadastro do prestador (autor, data e motivo da reprovação).
-- Seguro: só acrescenta colunas opcionais, um índice e uma FK. Nenhuma coluna ou linha é removida.
-- Sem CHECK de motivo obrigatório: cadastros rejected antigos não têm motivo. A regra fica na rota.
ALTER TABLE "providers" ADD COLUMN     "rejection_reason" VARCHAR(500),
ADD COLUMN     "validation_decided_at" TIMESTAMPTZ(3),
ADD COLUMN     "validation_decided_by" UUID;

CREATE INDEX "providers_validation_decided_by_idx" ON "providers"("validation_decided_by");

-- RESTRICT: o autor da decisão não pode sumir da auditoria
ALTER TABLE "providers" ADD CONSTRAINT "providers_validation_decided_by_fkey" FOREIGN KEY ("validation_decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
