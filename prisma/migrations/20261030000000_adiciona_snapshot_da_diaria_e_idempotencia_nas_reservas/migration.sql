-- HSP-PBI-039-TSK-01 (#494): snapshot da diária, observações do Tutor e chave de idempotência da solicitação de hospedagem.
-- Só ADD COLUMN e índice, sem DROP: as reservas que já existem ficam com as colunas novas nulas.
-- O UNIQUE (tutor_id, idempotency_key) segura dois envios simultâneos da mesma intenção; nulos não colidem entre si.

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "daily_price" DECIMAL(10,2),
ADD COLUMN     "idempotency_key" VARCHAR(100),
ADD COLUMN     "notes" VARCHAR(1000);

-- CreateIndex
CREATE UNIQUE INDEX "reservations_tutor_id_idempotency_key_key" ON "reservations"("tutor_id", "idempotency_key");

