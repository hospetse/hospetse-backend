-- HSP-PBI-042-TSK-01 (#491): aceite e recusa da solicitação pelo Host.
-- Só acrescenta: duas colunas que aceitam nulo e um status novo no CHECK. Nenhuma linha é alterada ou apagada.

-- AlterTable: motivo da recusa e momento da decisão do Host
ALTER TABLE "reservations" ADD COLUMN     "decided_at" TIMESTAMPTZ(3),
ADD COLUMN     "rejection_reason" VARCHAR(500);

-- awaiting_payment: aceita pelo Host, aguardando o pagamento do Tutor (HSP-DEC-004).
-- O Postgres não altera um CHECK no lugar: remove e recria na mesma migração, com a lista anterior mais o status novo.
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_status_check";
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_status_check" CHECK ("status" IN ('requested', 'awaiting_payment', 'accepted', 'rejected', 'checked_in', 'checked_out', 'cancelled', 'completed'));
