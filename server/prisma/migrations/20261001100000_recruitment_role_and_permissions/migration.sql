-- The Recruitment screen, and the Recruiter role that exists to work it.
--
-- WHY THIS IS A MIGRATION AND NOT ONLY CODE. `RolePermissionStore` reads `role_permissions` and,
-- when it finds rows, that is what governs — the defaults compiled into the application are the
-- fallback for a database that has never been seeded. There are 135 rows here already, so a role
-- or a screen added only in TypeScript would exist in the catalogue and grant nothing. Both halves
-- or neither.
--
-- EVERY STATEMENT IS IDEMPOTENT. `ON CONFLICT DO NOTHING` throughout, matching
-- 20260730140000_roles_and_permissions, so re-running costs nothing and a partially applied attempt
-- can be finished rather than unpicked.
--
-- WHAT IS DELIBERATELY ABSENT. No grant to `agent`, `crm`, `accounting` or `documentation`. A
-- recruiter works with people applying to join the brokerage, not with its customers, and the
-- reverse is equally true: nobody gains a screen full of applicants' personal details by being
-- good at invoices. `recruitment.decide` — final approval and creating the agent account — is NOT
-- a screen permission at all and is not seeded here; it lives in `CAPABILITIES` so that holding
-- `recruitment: 'edit'` can never carry it by accident.

-- ---- 1. The screen, at both grantable levels. Module 'crm', matching SCREEN_DOMAIN.
INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at")
VALUES ('crm','recruitment.view','recruitment','view',NOW(),NOW())
ON CONFLICT ("permission_name") DO NOTHING;

INSERT INTO "permissions" ("module","permission_name","screen","level","created_at","updated_at")
VALUES ('crm','recruitment.edit','recruitment','edit',NOW(),NOW())
ON CONFLICT ("permission_name") DO NOTHING;

-- ---- 2. The role.
--
-- `is_system` true: it is part of the application rather than something a brokerage invented, so
-- the roles screen must not offer to delete it and leave users pointing at a role that is gone.
-- `sort` 6, after the six that already exist.
INSERT INTO "roles" ("key","label","is_system","is_active","sort","created_at","updated_at")
VALUES ('recruiter','Recruiter',true,true,6,NOW(),NOW())
ON CONFLICT ("key") DO NOTHING;

-- ---- 3. Who gets the screen.
--
-- Recruiter: edit — the whole day-to-day job, and still no power to approve anybody, because that
-- is a capability rather than a screen level.
INSERT INTO "role_permissions" ("role_id","permission_id","created_at")
SELECT r."id", p."id", NOW()
  FROM "roles" r, "permissions" p
 WHERE r."key" = 'recruiter' AND p."permission_name" IN ('recruitment.view','recruitment.edit')
ON CONFLICT ("role_id","permission_id") DO NOTHING;

-- Super Admin and Admin: edit, since they assign recruiters, approve candidates and read reports.
INSERT INTO "role_permissions" ("role_id","permission_id","created_at")
SELECT r."id", p."id", NOW()
  FROM "roles" r, "permissions" p
 WHERE r."key" IN ('admin','manager') AND p."permission_name" IN ('recruitment.view','recruitment.edit')
ON CONFLICT ("role_id","permission_id") DO NOTHING;

-- ---- 4. What the Recruiter needs in order to be able to work at all.
--
-- Somewhere to land after signing in, and a diary to book interviews into. Neither carries customer
-- data, and without them the role signs in to a screen it cannot open. Nothing else is granted:
-- Lead, Transactions, Invoice, Reports and the audit trail stay closed, which is the point of the
-- role existing rather than reusing an old one.
INSERT INTO "role_permissions" ("role_id","permission_id","created_at")
SELECT r."id", p."id", NOW()
  FROM "roles" r, "permissions" p
 WHERE r."key" = 'recruiter' AND p."permission_name" IN ('dashboard.view','calendar.view')
ON CONFLICT ("role_id","permission_id") DO NOTHING;
