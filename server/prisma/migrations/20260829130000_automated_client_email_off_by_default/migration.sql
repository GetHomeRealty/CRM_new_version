-- Stop the four automated client emails being on without anybody having chosen them.
--
-- WHAT THIS CHANGES. `crm_email_settings.template_toggles` held an explicit `true` for welcome,
-- birthday, anniversary and seasonal — the four emails the CRM sends to CLIENTS on its own
-- initiative. An explicit value overrides the compiled default, so those four were switched on for
-- the whole brokerage regardless of what the code defaults to, and nobody at the brokerage had
-- necessarily decided that.
--
-- WHY THE KEYS ARE REMOVED RATHER THAN SET TO FALSE. Removing them restores "no brokerage choice
-- has been expressed", so the row follows DEFAULT_TRIGGERS — which is now off for all four. A
-- stored `false` would look identical in behaviour but would claim the brokerage had deliberately
-- turned them off, and it hasn't; it has simply never been asked. When somebody does decide, their
-- answer is written here and is then a real choice rather than an inheritance.
--
-- WHAT IS DELIBERATELY LEFT ALONE. `promotional`, `referral` and `custom` are MANUAL sends —
-- somebody presses send — so their toggle governs availability, not unattended email. Staff
-- notifications are not in this row at all.
--
-- REVERSIBLE: re-enable any of them from CRM Settings → Communications. No data is destroyed; only
-- a default is restored.
UPDATE crm_email_settings
   SET template_toggles = (
         (template_toggles::jsonb - 'welcome' - 'birthday' - 'anniversary' - 'seasonal')::text
       )
 WHERE template_toggles IS NOT NULL
   AND template_toggles::jsonb ?| array['welcome', 'birthday', 'anniversary', 'seasonal'];
