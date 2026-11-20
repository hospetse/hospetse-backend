-- #341: campos comuns ficam em providers; o raio específico do Walker fica no detalhe.
-- Novas colunas são opcionais para preservar prestadores e rascunhos existentes.
ALTER TABLE "providers"
  ADD COLUMN "person_type" VARCHAR(2),
  ADD COLUMN "administers_medication" BOOLEAN,
  ADD COLUMN "experience_range" VARCHAR(10);

-- Cadastros anteriores já informavam CPF/CNPJ, mas não tinham a escolha explícita.
UPDATE "providers" SET "person_type" = CASE
  WHEN length(regexp_replace("cpf_cnpj", '[^0-9]', '', 'g')) = 11 THEN 'pf'
  WHEN length(regexp_replace("cpf_cnpj", '[^0-9]', '', 'g')) = 14 THEN 'pj'
END
WHERE "cpf_cnpj" IS NOT NULL;

ALTER TABLE "providers"
  ADD CONSTRAINT "providers_person_type_check" CHECK ("person_type" IS NULL OR "person_type" IN ('pf', 'pj')),
  ADD CONSTRAINT "providers_experience_range_check" CHECK ("experience_range" IS NULL OR "experience_range" IN ('lt_1', '1_3', 'gt_3'));

ALTER TABLE "pet_walker_details"
  ADD COLUMN "kilometer_radius" DECIMAL(6,2),
  ADD CONSTRAINT "pet_walker_details_radius_check" CHECK ("kilometer_radius" IS NULL OR "kilometer_radius" >= 0);

ALTER TABLE "provider_documents" DROP CONSTRAINT "provider_documents_type_check";
ALTER TABLE "provider_documents" ADD CONSTRAINT "provider_documents_type_check"
  CHECK ("type" IN ('identity', 'proof_of_address', 'cnpj_card', 'qualification'));
