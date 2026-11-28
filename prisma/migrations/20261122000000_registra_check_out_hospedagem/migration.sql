BEGIN;

ALTER TABLE "reservations"
  ADD COLUMN "checked_out_at" TIMESTAMPTZ(3),
  ADD COLUMN "platform_fee_amount" DECIMAL(10,2),
  ADD CONSTRAINT "reservations_platform_fee_amount_check"
    CHECK ("platform_fee_amount" BETWEEN 0 AND "total_value");

-- Preserva as regras dos lançamentos anteriores e admite o líquido de uma hospedagem.
ALTER TABLE "financial_entries"
  DROP CONSTRAINT "financial_entries_type_check",
  DROP CONSTRAINT "financial_entries_correction_check",
  ADD CONSTRAINT "financial_entries_type_check" CHECK ("type" IN ('payment', 'correction', 'host_net')),
  ADD CONSTRAINT "financial_entries_correction_check" CHECK (
    ("type" = 'payment' AND "original_entry_id" IS NULL)
    OR ("type" = 'correction' AND "original_entry_id" IS NOT NULL AND "reason" IS NOT NULL)
    OR ("type" = 'host_net' AND "original_entry_id" IS NULL AND "status" = 'approved' AND "amount" >= 0)
  );

CREATE UNIQUE INDEX "financial_entries_host_net_once_idx"
  ON "financial_entries"("reservation_id") WHERE "type" = 'host_net';

COMMIT;
