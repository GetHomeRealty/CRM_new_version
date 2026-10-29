-- REMOVES THE WHATSAPP SUPPORT ROTATION (added by 20261029120000_whatsapp_rotation, withdrawn the
-- same day at the brokerage's request). The feature's code was reverted; these are its three tables.
-- The earlier migration stays in the history because databases have already recorded it.
-- IF EXISTS, so this is safe on a database that never had them.

DROP TABLE IF EXISTS "whatsapp_intake";
DROP TABLE IF EXISTS "whatsapp_rotation_members";
DROP TABLE IF EXISTS "whatsapp_rotation_settings";
