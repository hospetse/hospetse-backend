-- HSP-PBI-001-TSK-02 (#260): USER vinculado à identidade do Auth Server, sem senha.
-- As colunas NOT NULL vêm primeiro: se a tabela já tiver linhas, a migração falha aqui, antes de apagar qualquer dado.

-- AlterTable: vínculo com o Auth, nome do cadastro e estado do perfil
ALTER TABLE "users"
  ADD COLUMN "auth_user_id" UUID NOT NULL,
  ADD COLUMN "name" VARCHAR(255) NOT NULL,
  ADD COLUMN "profile_status" VARCHAR(20) NOT NULL DEFAULT 'incomplete';

ALTER TABLE "users"
  ADD CONSTRAINT "users_profile_status_check" CHECK ("profile_status" IN ('incomplete', 'complete'));

-- CreateIndex
CREATE UNIQUE INDEX "users_auth_user_id_key" ON "users"("auth_user_id");

-- AlterEnum: account_type_enum (tutor, provider, admin) -> (user, admin).
-- O PostgreSQL não remove valores de enum: cria o tipo novo, converte (tutor/provider -> user) e troca.
CREATE TYPE "account_type_enum_new" AS ENUM ('user', 'admin');
ALTER TABLE "users"
  ALTER COLUMN "account_type" TYPE "account_type_enum_new"
  USING (CASE WHEN "account_type" = 'admin' THEN 'admin' ELSE 'user' END)::"account_type_enum_new";
DROP TYPE "account_type_enum";
ALTER TYPE "account_type_enum_new" RENAME TO "account_type_enum";
ALTER TABLE "users" ALTER COLUMN "account_type" SET DEFAULT 'user';

-- AlterTable: a senha fica só no Auth Server
ALTER TABLE "users" DROP COLUMN "password";
