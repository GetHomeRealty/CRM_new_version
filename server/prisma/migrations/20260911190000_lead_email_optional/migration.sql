-- A manually entered lead may be known by phone before an email address is available.
-- Phone remains required by the API and lead form. This stores an honest NULL instead of
-- inventing a fake email; the existing unique index still covers every real email address.
ALTER TABLE "leads" ALTER COLUMN "email" DROP NOT NULL;
