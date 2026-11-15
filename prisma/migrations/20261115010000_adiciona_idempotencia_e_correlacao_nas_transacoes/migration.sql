-- #527: idempotência e correlação com o gateway nas transações de pagamento (ADR-016).
-- Seguro: só acrescenta colunas opcionais e índices. Nenhuma coluna ou linha é removida.
ALTER TABLE "payment_transactions" ADD COLUMN "idempotency_key" VARCHAR(100);
-- Id do PaymentIntent no Stripe (pi_...): liga o webhook (#528) à transação
ALTER TABLE "payment_transactions" ADD COLUMN "gateway_payment_id" VARCHAR(255);
-- Motivo da recusa devolvido pelo gateway (ex.: card_declined). Nunca dado do cartão
ALTER TABLE "payment_transactions" ADD COLUMN "failure_code" VARCHAR(100);

CREATE UNIQUE INDEX "payment_transactions_gateway_payment_id_key" ON "payment_transactions"("gateway_payment_id");

-- Reenvio com a mesma chave para a mesma contratação acha a transação já criada, sem cobrar de novo.
-- NULL não colide com NULL no Postgres: transações antigas, sem chave, continuam válidas.
CREATE UNIQUE INDEX "payment_transactions_reservation_id_idempotency_key_key" ON "payment_transactions"("reservation_id", "idempotency_key");

-- No máximo um pagamento aberto ou aprovado por contratação: duas chaves diferentes não cobram duas vezes.
-- Depois de uma recusa, uma nova tentativa é permitida. Índice parcial: o Prisma não expressa, então só existe aqui.
CREATE UNIQUE INDEX "payment_transactions_active_payment_idx" ON "payment_transactions"("reservation_id")
  WHERE "type" = 'payment' AND "status" IN ('pending', 'approved');
