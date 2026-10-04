-- ==== 20260904100000_identity ====
-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "account_type_enum" AS ENUM ('tutor', 'provider', 'admin');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL,
    "password" VARCHAR(255) NOT NULL,
    "account_type" "account_type_enum" NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "users_status_check" CHECK ("status" IN ('active', 'blocked', 'suspended', 'pending'))
);

-- CreateTable
CREATE TABLE "tutors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(30),
    "cpf" VARCHAR(14),
    "birth_date" DATE,
    CONSTRAINT "tutors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "tutors_user_id_key" ON "tutors"("user_id");
CREATE UNIQUE INDEX "tutors_cpf_key" ON "tutors"("cpf");

-- AddForeignKey
ALTER TABLE "tutors" ADD CONSTRAINT "tutors_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ==== 20260904101000_providers ====
-- CreateTable
CREATE TABLE "providers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider_type" VARCHAR(30) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "cpf_cnpj" VARCHAR(18),
    "location" VARCHAR(500),
    "rating" DECIMAL(3,2),
    "url_picture" VARCHAR(2048),
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "validation_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "providers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "providers_type_check" CHECK ("provider_type" IN ('hotel', 'pet_sitter', 'pet_walker')),
    CONSTRAINT "providers_rating_check" CHECK ("rating" IS NULL OR "rating" BETWEEN 0 AND 5),
    CONSTRAINT "providers_status_check" CHECK ("status" IN ('active', 'inactive')),
    CONSTRAINT "providers_validation_status_check" CHECK ("validation_status" IN ('pending', 'approved', 'rejected'))
);

CREATE TABLE "provider_photos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_photos_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hotel_details" (
    "provider_id" UUID NOT NULL,
    "capacity" INTEGER,
    CONSTRAINT "hotel_details_pkey" PRIMARY KEY ("provider_id"),
    CONSTRAINT "hotel_details_capacity_check" CHECK ("capacity" IS NULL OR "capacity" >= 0)
);

CREATE TABLE "pet_sitter_details" (
    "provider_id" UUID NOT NULL,
    "home_attended" BOOLEAN,
    "kilometer_radius" DECIMAL(6,2),
    CONSTRAINT "pet_sitter_details_pkey" PRIMARY KEY ("provider_id"),
    CONSTRAINT "pet_sitter_details_radius_check" CHECK ("kilometer_radius" IS NULL OR "kilometer_radius" >= 0)
);

CREATE TABLE "pet_walker_details" (
    "provider_id" UUID NOT NULL,
    "duration_walk" INTEGER,
    CONSTRAINT "pet_walker_details_pkey" PRIMARY KEY ("provider_id"),
    CONSTRAINT "pet_walker_details_duration_check" CHECK ("duration_walk" IS NULL OR "duration_walk" > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "providers_user_id_key" ON "providers"("user_id");
CREATE UNIQUE INDEX "providers_cpf_cnpj_key" ON "providers"("cpf_cnpj");
CREATE INDEX "providers_provider_type_idx" ON "providers"("provider_type");
CREATE INDEX "provider_photos_provider_id_idx" ON "provider_photos"("provider_id");

-- AddForeignKey
ALTER TABLE "providers" ADD CONSTRAINT "providers_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_photos" ADD CONSTRAINT "provider_photos_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hotel_details" ADD CONSTRAINT "hotel_details_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pet_sitter_details" ADD CONSTRAINT "pet_sitter_details_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pet_walker_details" ADD CONSTRAINT "pet_walker_details_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ==== 20260904102000_pets_services_availability ====
-- CreateTable
CREATE TABLE "pets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tutor_id" UUID NOT NULL,
    "pet_name" VARCHAR(255) NOT NULL,
    "pet_species" VARCHAR(100) NOT NULL,
    "pet_breed" VARCHAR(100),
    "pet_size" VARCHAR(30),
    "pet_birth_date" DATE,
    "medical_notes" TEXT,
    "behavioral_notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "pets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "services_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "services_price_check" CHECK ("price" >= 0)
);

CREATE TABLE "provider_working_hours" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,
    CONSTRAINT "provider_working_hours_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provider_working_hours_day_check" CHECK ("day_of_week" BETWEEN 0 AND 6),
    CONSTRAINT "provider_working_hours_time_check" CHECK ("end_time" > "start_time")
);

CREATE TABLE "provider_blocked_dates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "reason" VARCHAR(500),
    CONSTRAINT "provider_blocked_dates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "walk_slots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "meeting_point" VARCHAR(500),
    CONSTRAINT "walk_slots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "walk_slots_capacity_check" CHECK ("capacity" > 0),
    CONSTRAINT "walk_slots_time_check" CHECK ("end_time" > "start_time")
);

-- CreateIndex
CREATE INDEX "pets_tutor_id_idx" ON "pets"("tutor_id");
CREATE INDEX "services_provider_id_idx" ON "services"("provider_id");
CREATE INDEX "provider_working_hours_provider_id_day_of_week_idx" ON "provider_working_hours"("provider_id", "day_of_week");
CREATE UNIQUE INDEX "provider_blocked_dates_provider_id_date_key" ON "provider_blocked_dates"("provider_id", "date");
CREATE INDEX "walk_slots_provider_id_idx" ON "walk_slots"("provider_id");

-- AddForeignKey
ALTER TABLE "pets" ADD CONSTRAINT "pets_tutor_id_fkey"
  FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "services" ADD CONSTRAINT "services_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_working_hours" ADD CONSTRAINT "provider_working_hours_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_blocked_dates" ADD CONSTRAINT "provider_blocked_dates_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "walk_slots" ADD CONSTRAINT "walk_slots_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ==== 20260904103000_reservations ====
-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pet_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "walk_slot_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'requested',
    "start_date" TIMESTAMPTZ(3) NOT NULL,
    "end_date" TIMESTAMPTZ(3),
    "created_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_value" DECIMAL(10,2) NOT NULL,
    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reservations_status_check" CHECK ("status" IN ('requested', 'accepted', 'rejected', 'checked_in', 'checked_out', 'cancelled', 'completed')),
    CONSTRAINT "reservations_dates_check" CHECK ("end_date" IS NULL OR "end_date" > "start_date"),
    CONSTRAINT "reservations_total_value_check" CHECK ("total_value" >= 0)
);

-- CreateIndex
CREATE INDEX "reservations_pet_id_idx" ON "reservations"("pet_id");
CREATE INDEX "reservations_tutor_id_idx" ON "reservations"("tutor_id");
CREATE INDEX "reservations_service_id_idx" ON "reservations"("service_id");
CREATE INDEX "reservations_walk_slot_id_idx" ON "reservations"("walk_slot_id");
CREATE INDEX "reservations_status_start_date_idx" ON "reservations"("status", "start_date");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_pet_id_fkey"
  FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tutor_id_fkey"
  FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_service_id_fkey"
  FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_walk_slot_id_fkey"
  FOREIGN KEY ("walk_slot_id") REFERENCES "walk_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ==== 20260904104000_interactions ====
-- CreateEnum
CREATE TYPE "sender_type_enum" AS ENUM ('tutor', 'host', 'ai');

-- CreateTable
CREATE TABLE "pet_activity_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reservation_id" UUID NOT NULL,
    "activity_type" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "photo_url" VARCHAR(2048),
    "registered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pet_activity_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reservation_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reviews_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);

CREATE TABLE "favorites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tutor_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tutor_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "reservation_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ai_handling',
    "escalated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "conversations_status_check" CHECK ("status" IN ('ai_handling', 'escalated', 'human_handling', 'closed'))
);

CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "sender_type" "sender_type_enum" NOT NULL,
    "content" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provider_faqs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    CONSTRAINT "provider_faqs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pet_activity_logs_reservation_id_registered_at_idx" ON "pet_activity_logs"("reservation_id", "registered_at");
CREATE UNIQUE INDEX "reviews_reservation_id_key" ON "reviews"("reservation_id");
CREATE INDEX "reviews_provider_id_created_at_idx" ON "reviews"("provider_id", "created_at");
CREATE INDEX "reviews_tutor_id_idx" ON "reviews"("tutor_id");
CREATE UNIQUE INDEX "favorites_tutor_id_provider_id_key" ON "favorites"("tutor_id", "provider_id");
CREATE INDEX "favorites_provider_id_idx" ON "favorites"("provider_id");
CREATE INDEX "conversations_tutor_id_idx" ON "conversations"("tutor_id");
CREATE INDEX "conversations_provider_id_idx" ON "conversations"("provider_id");
CREATE INDEX "conversations_reservation_id_idx" ON "conversations"("reservation_id");
CREATE INDEX "conversations_status_escalated_at_idx" ON "conversations"("status", "escalated_at");
CREATE INDEX "messages_conversation_id_sent_at_idx" ON "messages"("conversation_id", "sent_at");
CREATE INDEX "provider_faqs_provider_id_idx" ON "provider_faqs"("provider_id");

-- AddForeignKey
ALTER TABLE "pet_activity_logs" ADD CONSTRAINT "pet_activity_logs_reservation_id_fkey"
  FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reservation_id_fkey"
  FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tutor_id_fkey"
  FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_tutor_id_fkey"
  FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tutor_id_fkey"
  FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_reservation_id_fkey"
  FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_faqs" ADD CONSTRAINT "provider_faqs_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ==== 20260904105000_finance_and_coupons ====
-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tutor_id" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "token" VARCHAR(2048) NOT NULL,
    "last_digits" VARCHAR(4),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_methods_type_check" CHECK ("type" IN ('credit_card', 'debit_card', 'pix', 'boleto'))
);

CREATE TABLE "payment_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reservation_id" UUID,
    "provider_id" UUID,
    "type" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "value" DECIMAL(10,2) NOT NULL,
    "payment_method_id" UUID,
    "created_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_transactions_type_check" CHECK ("type" IN ('payment', 'refund', 'payout')),
    CONSTRAINT "payment_transactions_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'completed')),
    CONSTRAINT "payment_transactions_value_check" CHECK ("value" >= 0),
    CONSTRAINT "payment_transactions_subject_check" CHECK (
      ("type" IN ('payment', 'refund') AND "reservation_id" IS NOT NULL)
      OR ("type" = 'payout' AND "provider_id" IS NOT NULL)
    )
);

CREATE TABLE "coupons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(100) NOT NULL,
    "discount_type" VARCHAR(20) NOT NULL,
    "discount_value" DECIMAL(10,2) NOT NULL,
    "max_uses" INTEGER,
    "valid_from" DATE,
    "valid_until" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "coupons_discount_type_check" CHECK ("discount_type" IN ('percentage', 'fixed')),
    CONSTRAINT "coupons_discount_value_check" CHECK ("discount_value" >= 0),
    CONSTRAINT "coupons_max_uses_check" CHECK ("max_uses" IS NULL OR "max_uses" > 0),
    CONSTRAINT "coupons_validity_check" CHECK ("valid_from" IS NULL OR "valid_until" IS NULL OR "valid_until" >= "valid_from")
);

CREATE TABLE "coupon_usages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coupon_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "coupon_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_methods_tutor_id_idx" ON "payment_methods"("tutor_id");
CREATE INDEX "payment_transactions_reservation_id_idx" ON "payment_transactions"("reservation_id");
CREATE INDEX "payment_transactions_provider_id_idx" ON "payment_transactions"("provider_id");
CREATE INDEX "payment_transactions_payment_method_id_idx" ON "payment_transactions"("payment_method_id");
CREATE INDEX "payment_transactions_type_status_idx" ON "payment_transactions"("type", "status");
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");
CREATE UNIQUE INDEX "coupon_usages_coupon_id_reservation_id_key" ON "coupon_usages"("coupon_id", "reservation_id");
CREATE INDEX "coupon_usages_tutor_id_idx" ON "coupon_usages"("tutor_id");

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_tutor_id_fkey"
  FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_reservation_id_fkey"
  FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_payment_method_id_fkey"
  FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "coupon_usages" ADD CONSTRAINT "coupon_usages_coupon_id_fkey"
  FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coupon_usages" ADD CONSTRAINT "coupon_usages_reservation_id_fkey"
  FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coupon_usages" ADD CONSTRAINT "coupon_usages_tutor_id_fkey"
  FOREIGN KEY ("tutor_id") REFERENCES "tutors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ==== 20260904106000_notifications_and_administration ====
-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "content" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "penalties" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "applied_by" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "penalties_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "penalties_type_check" CHECK ("type" IN ('warning', 'fine', 'suspension', 'ban'))
);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_created_at_idx" ON "notifications"("user_id", "read", "created_at");
CREATE INDEX "penalties_user_id_created_at_idx" ON "penalties"("user_id", "created_at");
CREATE INDEX "penalties_applied_by_idx" ON "penalties"("applied_by");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "penalties" ADD CONSTRAINT "penalties_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "penalties" ADD CONSTRAINT "penalties_applied_by_fkey"
  FOREIGN KEY ("applied_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

