ALTER TABLE "leads"
  ALTER COLUMN "email" DROP NOT NULL,
  ADD COLUMN "lead_estimation" VARCHAR(32),
  ADD COLUMN "lead_quality" VARCHAR(16),
  ADD COLUMN "middle_name" VARCHAR(128);
