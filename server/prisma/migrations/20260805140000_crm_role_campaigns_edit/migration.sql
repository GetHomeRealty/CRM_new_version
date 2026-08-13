-- The CRM role gains campaign editing.
--
-- WHY. CRM staff prepare campaigns for agents, send mass communications and run lead nurturing —
-- that is what the role is for. It held `campaigns: 'view'`, inherited from the `fill('view')`
-- baseline and never chosen, so measured during the CRM audit it was refused 403 on campaign create
-- and test-send while an ordinary AGENT was allowed both. The one role whose job is running
-- campaigns was the one role that could not run them.
--
-- WHY A MIGRATION AND NOT JUST THE CODE. `PermissionService.roleDefaults` reads the stored
-- `role_permissions` rows FIRST and falls back to the compiled map only when there are none, so a
-- code change alone leaves the running application exactly as it was. The parity test in
-- `core/role-permission.spec.ts` is what catches that, by comparing the two.
--
-- SCOPE. Only the `crm` role, only the `campaigns.edit` grant. `campaigns.view` is already held and
-- is left alone; no other role is referenced.
--
-- WHAT THIS DOES NOT DO. It grants the permission, not the reach. A campaign's audience is still
-- scoped by lead ownership, so a CRM staffer who owns no leads still resolves an audience of zero.
-- That is finding CRM-CAMP-H01 and needs a deliberate decision — widening who a campaign may reach
-- has consent implications under CASL and is not something to change as a side effect of a
-- permission grant.
--
-- REVERSIBLE. To undo: DELETE the same row.

INSERT INTO "role_permissions" ("role_id", "permission_id", "created_at")
SELECT r."id", p."id", NOW()
  FROM "roles" r, "permissions" p
 WHERE r."key" = 'crm'
   AND p."permission_name" = 'campaigns.edit'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
