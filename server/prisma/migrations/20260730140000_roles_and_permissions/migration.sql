-- Centralized roles and permissions.
--
-- The application's access model does not change. Roles are still the six it always had, keyed by the
-- same strings already in `users.role`; permissions are still screen + level ranked none < view < edit;
-- per-user overrides in `user_permissions` still win over the role. What changes is where the role
-- defaults are read from — a table instead of a switch statement in code.
--
-- The seed below was GENERATED from that switch statement, not written by hand, so the tables
-- reproduce the previous behaviour by construction rather than by careful transcription. A test
-- asserts the two agree for every role and every screen, and the service falls back to the code
-- defaults if these tables are ever empty.
--
-- No user row is touched and no permission changes for anybody.

CREATE TABLE IF NOT EXISTS "roles" (
  "id"         SERIAL      PRIMARY KEY,
  "company_id" INTEGER     NOT NULL DEFAULT 1,
  "key"        VARCHAR(32) NOT NULL,
  "label"      VARCHAR(64) NOT NULL,
  "is_system"  BOOLEAN     NOT NULL DEFAULT FALSE,
  "sort"       INTEGER     NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(0),
  "updated_at" TIMESTAMP(0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "roles_company_id_key_key" ON "roles"("company_id", "key");

CREATE TABLE IF NOT EXISTS "permissions" (
  "id"              SERIAL      PRIMARY KEY,
  "module"          VARCHAR(16) NOT NULL,
  "permission_name" VARCHAR(64) NOT NULL,
  "screen"          VARCHAR(32) NOT NULL,
  "level"           VARCHAR(8)  NOT NULL,
  "created_at"      TIMESTAMP(0),
  "updated_at"      TIMESTAMP(0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "permissions_permission_name_key" ON "permissions"("permission_name");
CREATE INDEX IF NOT EXISTS "permissions_module_idx" ON "permissions"("module");
CREATE INDEX IF NOT EXISTS "permissions_screen_idx" ON "permissions"("screen");

CREATE TABLE IF NOT EXISTS "role_permissions" (
  "id"            SERIAL    PRIMARY KEY,
  "role_id"       INTEGER   NOT NULL,
  "permission_id" INTEGER   NOT NULL,
  "created_at"    TIMESTAMP(0),
  CONSTRAINT "role_permissions_role_id_fkey"       FOREIGN KEY ("role_id")       REFERENCES "roles"("id")       ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "role_permissions_role_id_permission_id_key" ON "role_permissions"("role_id", "permission_id");
CREATE INDEX IF NOT EXISTS "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- roles
INSERT INTO "roles" ("company_id","key","label","is_system","sort","created_at","updated_at") VALUES (1,'admin','Super Admin',TRUE,0,NOW(),NOW()) ON CONFLICT ("company_id","key") DO NOTHING;
INSERT INTO "roles" ("company_id","key","label","is_system","sort","created_at","updated_at") VALUES (1,'manager','Admin',TRUE,1,NOW(),NOW()) ON CONFLICT ("company_id","key") DO NOTHING;
INSERT INTO "roles" ("company_id","key","label","is_system","sort","created_at","updated_at") VALUES (1,'agent','Agent',TRUE,2,NOW(),NOW()) ON CONFLICT ("company_id","key") DO NOTHING;
INSERT INTO "roles" ("company_id","key","label","is_system","sort","created_at","updated_at") VALUES (1,'accounting','Accounting',TRUE,3,NOW(),NOW()) ON CONFLICT ("company_id","key") DO NOTHING;
INSERT INTO "roles" ("company_id","key","label","is_system","sort","created_at","updated_at") VALUES (1,'documentation','Documentation',TRUE,4,NOW(),NOW()) ON CONFLICT ("company_id","key") DO NOTHING;
INSERT INTO "roles" ("company_id","key","label","is_system","sort","created_at","updated_at") VALUES (1,'crm','CRM',TRUE,5,NOW(),NOW()) ON CONFLICT ("company_id","key") DO NOTHING;

-- permissions: one per screen per grantable level (none is the absence of a grant)
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','dashboard.view','dashboard','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','dashboard.edit','dashboard','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('desk','analytics.view','analytics','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('desk','analytics.edit','analytics','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','calendar.view','calendar','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','calendar.edit','calendar','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('crm','reviews.view','reviews','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('crm','reviews.edit','reviews','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','favorites.view','favorites','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','favorites.edit','favorites','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','inventory.view','inventory','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','inventory.edit','inventory','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','inbox.view','inbox','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','inbox.edit','inbox','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('crm','lead.view','lead','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('crm','lead.edit','lead','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('crm','campaigns.view','campaigns','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('crm','campaigns.edit','campaigns','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('crm','meta.view','meta','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('crm','meta.edit','meta','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','mls.view','mls','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','mls.edit','mls','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('desk','transactions.view','transactions','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('desk','transactions.edit','transactions','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('desk','invoice.view','invoice','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('desk','invoice.edit','invoice','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('desk','reports.view','reports','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('desk','reports.edit','reports','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','audit.view','audit','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','audit.edit','audit','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','users.view','users','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','users.edit','users','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','settings.view','settings','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','settings.edit','settings','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','triggers.view','triggers','view',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at") VALUES ('core','triggers.edit','triggers','edit',NOW(),NOW()) ON CONFLICT ("permission_name") DO NOTHING;

-- grants, derived from the role defaults the application used before this migration
-- admin: 36 grants
INSERT INTO "role_permissions" ("role_id","permission_id","created_at")
SELECT r."id", p."id", NOW() FROM "roles" r, "permissions" p
 WHERE r."company_id" = 1 AND r."key" = 'admin'
   AND p."permission_name" IN ('dashboard.view', 'dashboard.edit', 'analytics.view', 'analytics.edit', 'calendar.view', 'calendar.edit', 'reviews.view', 'reviews.edit', 'favorites.view', 'favorites.edit', 'inventory.view', 'inventory.edit', 'inbox.view', 'inbox.edit', 'lead.view', 'lead.edit', 'campaigns.view', 'campaigns.edit', 'meta.view', 'meta.edit', 'mls.view', 'mls.edit', 'transactions.view', 'transactions.edit', 'invoice.view', 'invoice.edit', 'reports.view', 'reports.edit', 'audit.view', 'audit.edit', 'users.view', 'users.edit', 'settings.view', 'settings.edit', 'triggers.view', 'triggers.edit')
ON CONFLICT ("role_id","permission_id") DO NOTHING;

-- manager: 32 grants
INSERT INTO "role_permissions" ("role_id","permission_id","created_at")
SELECT r."id", p."id", NOW() FROM "roles" r, "permissions" p
 WHERE r."company_id" = 1 AND r."key" = 'manager'
   AND p."permission_name" IN ('dashboard.view', 'dashboard.edit', 'analytics.view', 'analytics.edit', 'calendar.view', 'calendar.edit', 'reviews.view', 'reviews.edit', 'favorites.view', 'favorites.edit', 'inventory.view', 'inventory.edit', 'inbox.view', 'inbox.edit', 'lead.view', 'lead.edit', 'campaigns.view', 'campaigns.edit', 'meta.view', 'meta.edit', 'mls.view', 'mls.edit', 'transactions.view', 'transactions.edit', 'invoice.view', 'invoice.edit', 'reports.view', 'reports.edit', 'audit.view', 'settings.view', 'triggers.view', 'triggers.edit')
ON CONFLICT ("role_id","permission_id") DO NOTHING;

-- agent: 19 grants
INSERT INTO "role_permissions" ("role_id","permission_id","created_at")
SELECT r."id", p."id", NOW() FROM "roles" r, "permissions" p
 WHERE r."company_id" = 1 AND r."key" = 'agent'
   AND p."permission_name" IN ('dashboard.view', 'analytics.view', 'calendar.view', 'calendar.edit', 'reviews.view', 'favorites.view', 'inventory.view', 'inbox.view', 'lead.view', 'lead.edit', 'campaigns.view', 'campaigns.edit', 'meta.view', 'meta.edit', 'mls.view', 'transactions.view', 'transactions.edit', 'reports.view', 'triggers.view')
ON CONFLICT ("role_id","permission_id") DO NOTHING;

-- accounting: 18 grants
INSERT INTO "role_permissions" ("role_id","permission_id","created_at")
SELECT r."id", p."id", NOW() FROM "roles" r, "permissions" p
 WHERE r."company_id" = 1 AND r."key" = 'accounting'
   AND p."permission_name" IN ('dashboard.view', 'analytics.view', 'calendar.view', 'reviews.view', 'favorites.view', 'inventory.view', 'inbox.view', 'lead.view', 'campaigns.view', 'meta.view', 'mls.view', 'transactions.view', 'transactions.edit', 'invoice.view', 'invoice.edit', 'reports.view', 'audit.view', 'triggers.view')
ON CONFLICT ("role_id","permission_id") DO NOTHING;

-- documentation: 15 grants
INSERT INTO "role_permissions" ("role_id","permission_id","created_at")
SELECT r."id", p."id", NOW() FROM "roles" r, "permissions" p
 WHERE r."company_id" = 1 AND r."key" = 'documentation'
   AND p."permission_name" IN ('dashboard.view', 'analytics.view', 'calendar.view', 'reviews.view', 'favorites.view', 'inventory.view', 'inbox.view', 'lead.view', 'campaigns.view', 'meta.view', 'mls.view', 'transactions.view', 'transactions.edit', 'reports.view', 'triggers.view')
ON CONFLICT ("role_id","permission_id") DO NOTHING;

-- crm: 15 grants
INSERT INTO "role_permissions" ("role_id","permission_id","created_at")
SELECT r."id", p."id", NOW() FROM "roles" r, "permissions" p
 WHERE r."company_id" = 1 AND r."key" = 'crm'
   AND p."permission_name" IN ('dashboard.view', 'analytics.view', 'calendar.view', 'reviews.view', 'reviews.edit', 'favorites.view', 'inventory.view', 'inbox.view', 'lead.view', 'lead.edit', 'campaigns.view', 'meta.view', 'mls.view', 'reports.view', 'triggers.view')
ON CONFLICT ("role_id","permission_id") DO NOTHING;
