-- HSP-PBI-031-TSK-01 (#479): descrição pública e restrições aceitas (espécies, portes e raças) do Host.
-- Só ADD COLUMN, sem DROP: os prestadores que já existem ficam sem descrição e com as listas vazias.
-- Antecipa a parte de "restrições aceitas" da HSP-PBI-008-TSK-03 (#323), combinado com o responsável dela.

-- AlterTable
ALTER TABLE "providers" ADD COLUMN     "accepted_breeds" VARCHAR(100)[] DEFAULT ARRAY[]::VARCHAR(100)[],
ADD COLUMN     "accepted_sizes" VARCHAR(30)[] DEFAULT ARRAY[]::VARCHAR(30)[],
ADD COLUMN     "accepted_species" VARCHAR(100)[] DEFAULT ARRAY[]::VARCHAR(100)[],
ADD COLUMN     "description" VARCHAR(2000);

