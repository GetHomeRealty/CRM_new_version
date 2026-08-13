-- Accounting loses the Audit Trail.
--
-- WHY. `GET /api/audit-logs` answered 200 to accounting while documentation and crm got 403 —
-- measured during the CRM full audit. The grant came from `fill('view')` in the compiled defaults
-- and was never a decision: the audit trail is not a financial record. It carries user
-- administration, permission grants and settings changes, so the role could read the history of
-- actions on screens it cannot open and rights it does not hold.
--
-- WHY A MIGRATION AND NOT JUST THE CODE. `PermissionService.roleDefaults` reads the stored
-- `role_permissions` rows FIRST and only falls back to the compiled map. Changing the code alone
-- would have left the running application exactly as it was — the parity test in
-- `core/role-permission.spec.ts` is what caught that, by comparing the two.
--
-- SCOPE. Only the `accounting` role, only the `audit.view` grant, only where a brokerage has not
-- already customised it away. Every other grant this role holds is untouched, and roles that
-- legitimately keep the audit trail — admin and manager — are not referenced.
--
-- REVERSIBLE. To restore, re-run the INSERT from 20260730140000 for `audit.view` alone.

DELETE FROM "role_permissions" rp
 USING "roles" r, "permissions" p
 WHERE rp."role_id" = r."id"
   AND rp."permission_id" = p."id"
   AND r."key" = 'accounting'
   AND p."permission_name" IN ('audit.view', 'audit.edit');
