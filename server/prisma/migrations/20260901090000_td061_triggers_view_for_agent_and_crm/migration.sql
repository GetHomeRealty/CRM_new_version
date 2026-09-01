-- TD-061: the Agent and CRM roles drop from `triggers: edit` to `triggers: view`.
--
-- WHAT WAS WRONG. `GET /api/user` reported permissions.triggers = 'edit' for an agent, and the
-- Triggers screen refused them: the 'days between reminders' input renders disabled above the line
-- 'You do not have permission to change this.' An administrator reading Settings → Roles &
-- Permissions to answer "can our agents retime the brokerage's reminder emails?" was told yes, and
-- the answer is no. Nothing was exposed by it — the defect is that the matrix, which is the artefact
-- people trust when deciding what a role may do, was wrong.
--
-- WHY THE GRANT EXISTED, AND WHY IT NO LONGER SHOULD. 20260804160000_crm_per_user_triggers raised
-- both roles from view to edit, and said why: "with triggers now personal, choosing which CRM emails
-- you send is your own decision and cannot reach anyone else's account". That was true when the
-- Triggers screen served both areas. It no longer does. The CRM half moved wholesale to
-- CRM → Communications, which is an `open` route needing no permission at all, and `area.ts` now
-- maps `triggers` to the Desk alone. What is left behind this key is the brokerage-wide automation
-- panel — lawyer-reminder cadence and Desk message templates — which is precisely what an agent
-- must not retime. The grant stopped granting anything and only misdescribed the role.
--
-- WHY THIS DIRECTION. The same 2026-08-04 migration also re-pointed the screen's check at
-- `triggers`; today `DeskTriggersPanel` checks `settings: 'edit'` again, and correctly so, because
-- the panel saves through the company-settings and email-template endpoints and the SERVER enforces
-- `settings` on those writes. Re-gating the panel on `triggers` instead would hand agents a Save
-- button that the API answers with a 403. The screen is right; the matrix is what moves.
--
-- WHY A MIGRATION AND NOT JUST THE CODE. `PermissionService.roleDefaults` reads the stored
-- `role_permissions` rows FIRST and falls back to the compiled map only when there are none, so a
-- code change alone leaves the running application exactly as it was. `core/role-permission.spec.ts`
-- is what catches the two drifting apart.
--
-- SCOPE. Two roles, one grant. `triggers.view` is untouched and both roles already hold it from the
-- original seed (20260730140000), so each lands on 'view' rather than 'none': the sidebar entry and
-- the read-only screen stay exactly where they are. No other role, screen or level is referenced —
-- admin and manager keep `triggers.edit`, accounting and documentation keep the `view` they had.
--
-- PER-USER OVERRIDES ARE NOT TOUCHED, deliberately. If somebody was individually granted
-- triggers.edit, that was a decision about that person and this is not the place to reverse it.
--
-- REVERSIBLE. To undo, re-run the INSERT from 20260804160000_crm_per_user_triggers.
--
-- DML ONLY. No ALTER TABLE, CREATE TABLE or CREATE INDEX, so this is unaffected by the application
-- database user not owning the tables it migrates.

DELETE FROM "role_permissions" rp
 USING "roles" r, "permissions" p
 WHERE rp."role_id" = r."id"
   AND rp."permission_id" = p."id"
   AND r."key" IN ('agent', 'crm')
   AND p."permission_name" = 'triggers.edit';
