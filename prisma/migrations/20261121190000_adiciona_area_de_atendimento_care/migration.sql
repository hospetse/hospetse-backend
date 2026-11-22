ALTER TABLE "providers"
ADD COLUMN "service_city" VARCHAR(100),
ADD COLUMN "service_neighborhoods" VARCHAR(100)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(100)[];
