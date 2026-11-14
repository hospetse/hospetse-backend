-- HSP-PBI-008-TSK-05 (#325): rascunho do cadastro do Host, antes da submissão para validação.
-- Só amplia os valores aceitos: nenhuma linha existente muda.
ALTER TABLE "providers" DROP CONSTRAINT "providers_validation_status_check";
ALTER TABLE "providers" ADD CONSTRAINT "providers_validation_status_check"
  CHECK ("validation_status" IN ('draft', 'pending', 'approved', 'rejected'));
