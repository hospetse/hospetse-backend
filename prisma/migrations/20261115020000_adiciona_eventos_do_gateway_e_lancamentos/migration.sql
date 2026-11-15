-- #528: eventos recebidos do gateway e registro financeiro imutável (RF-PAG-09).
-- Seguro: só cria tabelas, índices e um trigger. Nenhuma tabela existente é alterada.

-- Cada aviso do Stripe (evt_...) que chegou com assinatura válida, inclusive os ignorados. A PK impede processar o mesmo aviso duas vezes
CREATE TABLE "payment_events" (
    "id" VARCHAR(255) NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- Extrato: um lançamento por pagamento decidido e um por correção. Tutor e prestador são o snapshot do momento (sem FK)
CREATE TABLE "financial_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "transaction_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "original_entry_id" UUID,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "financial_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "financial_entries_type_check" CHECK ("type" IN ('payment', 'correction')),
    CONSTRAINT "financial_entries_status_check" CHECK ("status" IN ('approved', 'rejected')),
    -- Correção sempre aponta para o original e tem motivo; pagamento nunca aponta para outro lançamento
    CONSTRAINT "financial_entries_correction_check" CHECK (
      ("type" = 'payment' AND "original_entry_id" IS NULL)
      OR ("type" = 'correction' AND "original_entry_id" IS NOT NULL AND "reason" IS NOT NULL)
    )
);

-- RESTRICT: nada que tenha lançamento pode ser apagado
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_transaction_id_fkey"
  FOREIGN KEY ("transaction_id") REFERENCES "payment_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_reservation_id_fkey"
  FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_original_entry_id_fkey"
  FOREIGN KEY ("original_entry_id") REFERENCES "financial_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "financial_entries_transaction_id_idx" ON "financial_entries"("transaction_id");
CREATE INDEX "financial_entries_reservation_id_idx" ON "financial_entries"("reservation_id");
CREATE INDEX "financial_entries_original_entry_id_idx" ON "financial_entries"("original_entry_id");

-- Um único lançamento de pagamento por transação, mesmo com o webhook chegando duas vezes. Índice parcial: só em SQL
CREATE UNIQUE INDEX "financial_entries_payment_once_idx" ON "financial_entries"("transaction_id") WHERE "type" = 'payment';

-- Só inserção: o banco recusa UPDATE e DELETE, inclusive feitos à mão. Correção é um novo lançamento ligado ao original
CREATE FUNCTION financial_entries_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'financial_entries é só de inserção';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER financial_entries_no_update BEFORE UPDATE OR DELETE ON "financial_entries"
  FOR EACH ROW EXECUTE FUNCTION financial_entries_append_only();
