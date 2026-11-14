-- #398: data em que o cadastro do prestador foi enviado para validação. A fila do Administrador ordena por ela,
-- porque updated_at muda a cada edição.
-- Seguro: só acrescenta uma coluna opcional e um índice. Nenhuma coluna ou linha é removida.
ALTER TABLE "providers" ADD COLUMN "submitted_at" TIMESTAMPTZ(3);

-- Quem já está pendente recebe a data da última alteração, a melhor aproximação que existe do envio.
-- Só preenche o que está vazio: os outros cadastros ficam como estão.
UPDATE "providers" SET "submitted_at" = "updated_at" WHERE "validation_status" = 'pending' AND "submitted_at" IS NULL;

CREATE INDEX "providers_validation_status_submitted_at_idx" ON "providers"("validation_status", "submitted_at");
