-- AlterTable
ALTER TABLE "conversations" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "coupon_usages" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "coupons" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "favorites" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "messages" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "notifications" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "payment_methods" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "payment_transactions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "penalties" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "pet_activity_logs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "pets" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "provider_blocked_dates" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "provider_faqs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "provider_photos" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "provider_working_hours" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "providers" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "reservations" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "reviews" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "services" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tutors" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "walk_slots" ALTER COLUMN "id" DROP DEFAULT;
