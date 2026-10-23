-- THE PAYMENT SHEET, STORED AS UPLOADED (brokerage request, 2026-10-19).
--
-- The Pending Payments report computes its rows from the deals. The brokerage asked for it to show
-- its own Payment Sheet instead, word for word; this table holds that sheet. An upload replaces every
-- row, and with no rows the report computes from the deals as before.
--
-- ADDITIVE ONLY: a new table, nothing existing is altered or read differently. IF NOT EXISTS so a
-- re-run is harmless.
CREATE TABLE IF NOT EXISTS "payment_sheet_rows" (
    "id" SERIAL NOT NULL,
    "position" INTEGER NOT NULL,
    "section" VARCHAR(16) NOT NULL,
    "agent_group" VARCHAR(32),
    "trade_no" VARCHAR(64),
    "closing_date" DATE,
    "property" VARCHAR(255),
    "agent_name" VARCHAR(255),
    "docs_status" VARCHAR(64),
    "validation_status" VARCHAR(64),
    "validation_comments" TEXT,
    "payment_schedule" TEXT,
    "remarks" TEXT,
    "uploaded_by" VARCHAR(255),
    "uploaded_at" TIMESTAMP(0) NOT NULL,

    CONSTRAINT "payment_sheet_rows_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "payment_sheet_rows_position_idx" ON "payment_sheet_rows"("position");
