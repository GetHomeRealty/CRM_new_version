-- Marketing / physical-asset inventory (signboards, lock boxes, banners, ...).
-- Distinct from the property-listing "Inventory" screen. Additive.

CREATE TABLE IF NOT EXISTS "marketing_inventory" (
  "id"            SERIAL PRIMARY KEY,
  "as_on_date"    VARCHAR(10),
  "type"          VARCHAR(64)  NOT NULL,
  "custom_type"   VARCHAR(191),
  "count"         INTEGER      NOT NULL DEFAULT 0,
  "assignments"   JSONB,
  "assigned_qty"  INTEGER      NOT NULL DEFAULT 0,
  "assigned_to"   VARCHAR(255),
  "assigned_date" VARCHAR(10),
  "returned_date" VARCHAR(10),
  "status"        VARCHAR(16)  NOT NULL DEFAULT 'Available',
  "remarks"       TEXT,
  "created_at"    TIMESTAMP(0),
  "updated_at"    TIMESTAMP(0),
  "deleted_at"    TIMESTAMP(0)
);

CREATE INDEX IF NOT EXISTS "marketing_inventory_deleted_at_idx" ON "marketing_inventory"("deleted_at");
CREATE INDEX IF NOT EXISTS "marketing_inventory_type_idx" ON "marketing_inventory"("type");
