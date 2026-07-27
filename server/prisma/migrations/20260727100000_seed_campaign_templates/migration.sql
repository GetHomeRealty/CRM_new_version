-- Seed the Campaigns module with a set of ready-to-use starter email templates.
--
-- Campaign templates are user-authored content (not transactional email_templates), so a fresh
-- database starts with none and the Campaigns library looks empty. This gives the module a usable
-- starting set across the six categories. Each insert is guarded by name, so it is idempotent and
-- never duplicates a template an agent already created or that a restore brought back.

INSERT INTO "campaign_templates" ("name","subject","content","category","is_active","created_by","created_at","updated_at")
SELECT 'Welcome — New Lead',
       'Welcome to Get Home Realty, {{LEAD_NAME}}!',
       '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1f2937;line-height:1.6"><h2 style="color:#c8102e;margin:0 0 12px">Welcome, {{LEAD_NAME}}!</h2><p>Thank you for connecting with Get Home Realty. I am {{AGENT_NAME}}, and I will be your point of contact for everything related to your property journey.</p><p>Whether you are buying, selling, or simply exploring the market, I am here to help you make confident, well-informed decisions. Feel free to reach out any time with questions.</p><p style="margin-top:20px">Warm regards,<br><strong>{{AGENT_NAME}}</strong><br>Get Home Realty<br>{{AGENT_EMAIL}} &middot; {{AGENT_PHONE}}</p></div>',
       'welcome', true, 'System', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "campaign_templates" WHERE "name" = 'Welcome — New Lead');

INSERT INTO "campaign_templates" ("name","subject","content","category","is_active","created_by","created_at","updated_at")
SELECT 'Follow-up — Checking In',
       'Following up on your home search, {{LEAD_NAME}}',
       '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1f2937;line-height:1.6"><h2 style="color:#c8102e;margin:0 0 12px">Hi {{LEAD_NAME}},</h2><p>I wanted to check in and see how your property search is going. The market moves quickly, and I would be glad to line up options that match what you are looking for.</p><p>If now is a good time, just reply to this email or call me and we can take the next step together.</p><p style="margin-top:20px">Talk soon,<br><strong>{{AGENT_NAME}}</strong><br>Get Home Realty<br>{{AGENT_EMAIL}} &middot; {{AGENT_PHONE}}</p></div>',
       'follow-up', true, 'System', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "campaign_templates" WHERE "name" = 'Follow-up — Checking In');

INSERT INTO "campaign_templates" ("name","subject","content","category","is_active","created_by","created_at","updated_at")
SELECT 'Showing — Confirmation',
       'Your showing is confirmed — {{PROPERTY_ADDRESS}}',
       '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1f2937;line-height:1.6"><h2 style="color:#c8102e;margin:0 0 12px">Showing confirmed</h2><p>Hi {{LEAD_NAME}}, your viewing for <strong>{{PROPERTY_ADDRESS}}</strong> is confirmed. I look forward to showing you the property in person.</p><table style="border-collapse:collapse;font-size:14px;margin:12px 0"><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Property</td><td style="padding:4px 0;font-weight:600">{{PROPERTY_ADDRESS}}</td></tr><tr><td style="padding:4px 12px 4px 0;color:#6b7280">Listed at</td><td style="padding:4px 0;font-weight:600">{{PROPERTY_PRICE}}</td></tr></table><p>If anything changes or you have questions before we meet, please let me know.</p><p style="margin-top:20px">See you soon,<br><strong>{{AGENT_NAME}}</strong><br>Get Home Realty<br>{{AGENT_EMAIL}} &middot; {{AGENT_PHONE}}</p></div>',
       'showing', true, 'System', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "campaign_templates" WHERE "name" = 'Showing — Confirmation');

INSERT INTO "campaign_templates" ("name","subject","content","category","is_active","created_by","created_at","updated_at")
SELECT 'Property Update — New Listing',
       'A new listing you may love — {{PROPERTY_ADDRESS}}',
       '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1f2937;line-height:1.6"><h2 style="color:#c8102e;margin:0 0 12px">Just listed for you, {{LEAD_NAME}}</h2><p>A new property came on the market that fits what you have been looking for:</p><div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:12px 0"><div style="font-size:16px;font-weight:700">{{PROPERTY_ADDRESS}}</div><div style="font-size:18px;color:#c8102e;font-weight:800;margin:6px 0">{{PROPERTY_PRICE}}</div><table style="border-collapse:collapse;font-size:14px"><tr><td style="padding:2px 14px 2px 0;color:#6b7280">Beds</td><td style="padding:2px 0;font-weight:600">{{BEDROOMS}}</td><td style="padding:2px 14px;color:#6b7280">Baths</td><td style="padding:2px 0;font-weight:600">{{BATHROOMS}}</td><td style="padding:2px 14px;color:#6b7280">Size</td><td style="padding:2px 0;font-weight:600">{{SQUARE_FOOTAGE}}</td></tr></table><div style="margin-top:8px;color:#374151">{{KEY_FEATURES}}</div></div><p>Would you like to arrange a viewing? Reply to this email and I will set it up.</p><p style="margin-top:20px">Best,<br><strong>{{AGENT_NAME}}</strong><br>Get Home Realty<br>{{AGENT_EMAIL}} &middot; {{AGENT_PHONE}}</p></div>',
       'property-update', true, 'System', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "campaign_templates" WHERE "name" = 'Property Update — New Listing');

INSERT INTO "campaign_templates" ("name","subject","content","category","is_active","created_by","created_at","updated_at")
SELECT 'Thank You — After Closing',
       'Thank you, {{LEAD_NAME}}!',
       '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1f2937;line-height:1.6"><h2 style="color:#c8102e;margin:0 0 12px">Thank you, {{LEAD_NAME}}!</h2><p>It has been a genuine pleasure working with you. Thank you for trusting Get Home Realty with such an important decision.</p><p>If you ever need anything down the road, or know someone who could use a hand with their property, I am only a message away. Referrals from happy clients mean the world to me.</p><p style="margin-top:20px">With gratitude,<br><strong>{{AGENT_NAME}}</strong><br>Get Home Realty<br>{{AGENT_EMAIL}} &middot; {{AGENT_PHONE}}</p></div>',
       'thank-you', true, 'System', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "campaign_templates" WHERE "name" = 'Thank You — After Closing');

INSERT INTO "campaign_templates" ("name","subject","content","category","is_active","created_by","created_at","updated_at")
SELECT 'Monthly Market Update',
       '{{LEAD_NAME}}, your monthly market update',
       '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1f2937;line-height:1.6"><h2 style="color:#c8102e;margin:0 0 12px">Your market update</h2><p>Hi {{LEAD_NAME}}, here is a quick look at what is happening in the market this month. Understanding the trends now can help you time your next move with confidence.</p><ul style="padding-left:18px"><li>Inventory and pricing in your areas of interest</li><li>Recent sales and how they compare to asking prices</li><li>What buyers and sellers should watch for right now</li></ul><p>Want a tailored view for a specific neighbourhood or property type? Reply and I will put it together for you.</p><p style="margin-top:20px">Best regards,<br><strong>{{AGENT_NAME}}</strong><br>Get Home Realty<br>{{AGENT_EMAIL}} &middot; {{AGENT_PHONE}}</p></div>',
       'property-update', true, 'System', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "campaign_templates" WHERE "name" = 'Monthly Market Update');
