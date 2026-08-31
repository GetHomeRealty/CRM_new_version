-- CRM-029 — replace the visual builder's starter text in the campaign templates that use it.
--
-- WHAT THIS FIXES. Templates built with the visual builder start life carrying the builder's
-- own starter paragraph, "Write your message here." Four templates were sent to real leads
-- still carrying it. This writes the approved copy into those four, and deactivates the
-- remaining templates that hold the placeholder but no campaign has ever used.
--
-- SAFE TO RUN MORE THAN ONCE. Every statement is guarded on the placeholder still being
-- present, so a second run changes nothing. A template somebody has already rewritten by
-- hand is left alone rather than overwritten.
--
-- MATCHED BY NAME AND SUBJECT, NOT BY ID. Ids differ between databases; these were read from
-- development. Check the SELECT at the bottom reports 0 before you commit.
--
-- A builder template stores its design twice: the base64 <!--BUILDER:--> comment the editor
-- reads back, and the rendered HTML that is actually mailed. Both are replaced together —
-- changing one alone makes the editor and the email disagree.

BEGIN;

-- ---- "Welcome" (development id 5588)
UPDATE campaign_templates
   SET subject = 'Welcome to Get Home Realty, {{LEAD_NAME}}',
       content = '<!--BUILDER:eyJ2IjoyLCJibG9ja3MiOlt7InR5cGUiOiJoZWFkaW5nIiwidGV4dCI6IldlbGNvbWUsIHt7TEVBRF9OQU1FfX0iLCJsZXZlbCI6MSwiYWxpZ24iOiJjZW50ZXIiLCJjb2xvciI6IiMxMTE4MjcifSx7InR5cGUiOiJwYXJhZ3JhcGgiLCJ0ZXh0IjoiRGVhciB7e0xFQURfTkFNRX19LFxuXG5UaGFuayB5b3UgZm9yIGdldHRpbmcgaW4gdG91Y2ggd2l0aCBHZXQgSG9tZSBSZWFsdHkg4oCUIHdlIGFyZSBnbGFkIHlvdSBkaWQsIGFuZCB3ZSBhcmUgbG9va2luZyBmb3J3YXJkIHRvIGhlbHBpbmcgeW91LlxuXG5JIGFtIHt7QUdFTlRfTkFNRX19LCBhbmQgSSB3aWxsIGJlIGxvb2tpbmcgYWZ0ZXIgeW91IGZyb20gaGVyZS4gV2hlbmV2ZXIgeW91IGhhdmUgYSBxdWVzdGlvbiDigJQgYWJvdXQgYSBwcm9wZXJ0eSwgYSBuZWlnaGJvdXJob29kLCBvciBzaW1wbHkgd2hlcmUgdG8gc3RhcnQg4oCUIHJlcGx5IHRvIHRoaXMgZW1haWwgYW5kIGl0IGNvbWVzIHN0cmFpZ2h0IHRvIG1lLiIsImFsaWduIjoibGVmdCJ9LHsidHlwZSI6ImJveCIsInRpdGxlIjoiV2hhdCBoYXBwZW5zIG5leHQiLCJib2R5IjoiSSBzZW5kIHlvdSBsaXN0aW5ncyB0aGF0IG1hdGNoIHdoYXQgeW91IGFyZSBsb29raW5nIGZvclxuV2UgYXJyYW5nZSB2aWV3aW5ncyBhdCB0aW1lcyB0aGF0IHN1aXQgeW91XG5ObyBwcmVzc3VyZSBhbmQgbm8gb2JsaWdhdGlvbiBhdCBhbnkgc3RhZ2UiLCJjb2xvciI6IiNkYzI2MjYifSx7InR5cGUiOiJidXR0b24iLCJ0ZXh0IjoiUmVwbHkgdG8gVGhpcyBFbWFpbCIsInVybCI6Im1haWx0bzp7e0FHRU5UX0VNQUlMfX0iLCJjb2xvciI6IiNkYzI2MjYiLCJhbGlnbiI6ImNlbnRlciJ9XSwic3R5bGVzIjp7ImhlYWRlciI6dHJ1ZSwiZm9vdGVyIjp0cnVlLCJsb2dvIjoiIiwiYnJhbmROYW1lIjoiR2V0IEhvbWUgUmVhbHR5IiwiYnJhbmQiOiIjZGMyNjI2IiwiYWNjZW50IjoiI2RjMjYyNiIsImJnIjoiI2ZmZmZmZiIsImZvb3RlclRleHQiOiJcIkEgVHJhZGl0aW9uIG9mIFRydXN0XCIg4oCUIEJyb2tlcmFnZVxue3tBR0VOVF9OQU1FfX0gwrcge3tBR0VOVF9FTUFJTH19IMK3IHt7QUdFTlRfUEhPTkV9fSJ9fQ==-->
<div style="max-width:600px;margin:0 auto;background:#ffffff;font-family:Arial,Helvetica,sans-serif;">
<div style="text-align:center;padding:12px 24px 10px;background:#ffffff;"><div style="font-size:18px;font-weight:800;color:#dc2626;letter-spacing:.04em;text-transform:uppercase;">Get Home Realty</div></div><div style="height:3px;background:#dc2626;"></div>
<h1 style="text-align:center;color:#111827;font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:700;line-height:1.3;margin:16px 4px;">Welcome, {{LEAD_NAME}}</h1>
<p style="text-align:left;font-size:15px;line-height:1.65;color:#1f2937;margin:14px 4px;">Dear {{LEAD_NAME}},<br><br>Thank you for getting in touch with Get Home Realty — we are glad you did, and we are looking forward to helping you.<br><br>I am {{AGENT_NAME}}, and I will be looking after you from here. Whenever you have a question — about a property, a neighbourhood, or simply where to start — reply to this email and it comes straight to me.</p>
<div style="background:rgba(220,38,38,0.08);border-left:4px solid #dc2626;border-radius:8px;padding:15px 18px;margin:16px 4px;"><div style="color:#dc2626;font-weight:700;font-size:15px;margin-bottom:7px;">What happens next</div><div style="color:#334155;font-size:14px;line-height:1.65;">I send you listings that match what you are looking for<br>We arrange viewings at times that suit you<br>No pressure and no obligation at any stage</div></div>
<div style="text-align:center;margin:20px 4px;"><a href="mailto:{{AGENT_EMAIL}}" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:600;font-size:15px;">Reply to This Email</a></div>
<div style="border-top:1px solid #e5e7eb;background:#f8fafc;padding:22px 24px;text-align:center;font-size:12px;line-height:1.7;color:#94a3b8;"><div style="font-weight:800;color:#dc2626;letter-spacing:.04em;text-transform:uppercase;">Get Home Realty</div><div style="margin-top:4px;">"A Tradition of Trust" — Brokerage<br>{{AGENT_NAME}} · {{AGENT_EMAIL}} · {{AGENT_PHONE}}</div></div>
</div>',
       updated_at = now()
 WHERE name = 'Welcome'
   AND content ILIKE '%Write your message here%';

-- ---- "follow-up" (development id 6802)
UPDATE campaign_templates
   SET subject = 'Following up on your property search',
       content = '<!--BUILDER:eyJ2IjoyLCJibG9ja3MiOlt7InR5cGUiOiJoZWFkaW5nIiwidGV4dCI6IlN0aWxsIEhlcmUgdG8gSGVscCwge3tMRUFEX05BTUV9fSIsImxldmVsIjoxLCJhbGlnbiI6ImNlbnRlciIsImNvbG9yIjoiIzExMTgyNyJ9LHsidHlwZSI6InBhcmFncmFwaCIsInRleHQiOiJEZWFyIHt7TEVBRF9OQU1FfX0sXG5cbkkgd2FudGVkIHRvIGNoZWNrIGJhY2sgYW5kIHNlZSBob3cgeW91ciBwcm9wZXJ0eSBzZWFyY2ggaXMgZ29pbmcuXG5cbklmIGFueXRoaW5nIGhhcyBjaGFuZ2VkIOKAlCB5b3VyIGJ1ZGdldCwgdGhlIGFyZWEgeW91IGFyZSBsb29raW5nIGF0LCBvciB5b3VyIHRpbWluZyDigJQgcmVwbHkgYW5kIHRlbGwgbWUsIGFuZCBJIHdpbGwgYWRqdXN0IHdoYXQgSSBzZW5kIHlvdS4gSWYgbm93IGlzIG5vdCB0aGUgcmlnaHQgbW9tZW50LCB0aGF0IGlzIG5vIHRyb3VibGUgYXQgYWxsOiBzYXkgc28gYW5kIEkgd2lsbCBsZWF2ZSB5b3UgdG8gaXQuIiwiYWxpZ24iOiJsZWZ0In0seyJ0eXBlIjoiYm94IiwidGl0bGUiOiJIb3cgSSBjYW4gaGVscCIsImJvZHkiOiJTZW5kIHlvdSBmcmVzaCBsaXN0aW5ncyBhcyB0aGV5IGNvbWUgdG8gbWFya2V0XG5BcnJhbmdlIGEgdmlld2luZyB0aGF0IHN1aXRzIHlvdVxuQW5zd2VyIGFueXRoaW5nIGFib3V0IHRoZSBidXlpbmcgcHJvY2VzcyIsImNvbG9yIjoiI2RjMjYyNiJ9LHsidHlwZSI6ImJ1dHRvbiIsInRleHQiOiJSZXBseSB0byBUaGlzIEVtYWlsIiwidXJsIjoibWFpbHRvOnt7QUdFTlRfRU1BSUx9fSIsImNvbG9yIjoiI2RjMjYyNiIsImFsaWduIjoiY2VudGVyIn1dLCJzdHlsZXMiOnsiaGVhZGVyIjp0cnVlLCJmb290ZXIiOnRydWUsImxvZ28iOiIiLCJicmFuZE5hbWUiOiJHZXQgSG9tZSBSZWFsdHkiLCJicmFuZCI6IiNkYzI2MjYiLCJhY2NlbnQiOiIjZGMyNjI2IiwiYmciOiIjZmZmZmZmIiwiZm9vdGVyVGV4dCI6IlwiQSBUcmFkaXRpb24gb2YgVHJ1c3RcIiDigJQgQnJva2VyYWdlXG57e0FHRU5UX05BTUV9fSDCtyB7e0FHRU5UX0VNQUlMfX0gwrcge3tBR0VOVF9QSE9ORX19In19-->
<div style="max-width:600px;margin:0 auto;background:#ffffff;font-family:Arial,Helvetica,sans-serif;">
<div style="text-align:center;padding:12px 24px 10px;background:#ffffff;"><div style="font-size:18px;font-weight:800;color:#dc2626;letter-spacing:.04em;text-transform:uppercase;">Get Home Realty</div></div><div style="height:3px;background:#dc2626;"></div>
<h1 style="text-align:center;color:#111827;font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:700;line-height:1.3;margin:16px 4px;">Still Here to Help, {{LEAD_NAME}}</h1>
<p style="text-align:left;font-size:15px;line-height:1.65;color:#1f2937;margin:14px 4px;">Dear {{LEAD_NAME}},<br><br>I wanted to check back and see how your property search is going.<br><br>If anything has changed — your budget, the area you are looking at, or your timing — reply and tell me, and I will adjust what I send you. If now is not the right moment, that is no trouble at all: say so and I will leave you to it.</p>
<div style="background:rgba(220,38,38,0.08);border-left:4px solid #dc2626;border-radius:8px;padding:15px 18px;margin:16px 4px;"><div style="color:#dc2626;font-weight:700;font-size:15px;margin-bottom:7px;">How I can help</div><div style="color:#334155;font-size:14px;line-height:1.65;">Send you fresh listings as they come to market<br>Arrange a viewing that suits you<br>Answer anything about the buying process</div></div>
<div style="text-align:center;margin:20px 4px;"><a href="mailto:{{AGENT_EMAIL}}" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:600;font-size:15px;">Reply to This Email</a></div>
<div style="border-top:1px solid #e5e7eb;background:#f8fafc;padding:22px 24px;text-align:center;font-size:12px;line-height:1.7;color:#94a3b8;"><div style="font-weight:800;color:#dc2626;letter-spacing:.04em;text-transform:uppercase;">Get Home Realty</div><div style="margin-top:4px;">"A Tradition of Trust" — Brokerage<br>{{AGENT_NAME}} · {{AGENT_EMAIL}} · {{AGENT_PHONE}}</div></div>
</div>',
       updated_at = now()
 WHERE name = 'follow-up'
   AND content ILIKE '%Write your message here%';

-- ---- "checking" (development id 8482)
UPDATE campaign_templates
   SET subject = 'Still looking? A quick check-in',
       content = '<!--BUILDER:eyJ2IjoyLCJibG9ja3MiOlt7InR5cGUiOiJoZWFkaW5nIiwidGV4dCI6IkNoZWNraW5nIEluLCB7e0xFQURfTkFNRX19IiwibGV2ZWwiOjEsImFsaWduIjoiY2VudGVyIiwiY29sb3IiOiIjMTExODI3In0seyJ0eXBlIjoicGFyYWdyYXBoIiwidGV4dCI6IkRlYXIge3tMRUFEX05BTUV9fSxcblxuSXQgaGFzIGJlZW4gYSBsaXR0bGUgd2hpbGUsIHNvIEkgdGhvdWdodCBJIHdvdWxkIHNlZSB3aGV0aGVyIHlvdSBhcmUgc3RpbGwgbG9va2luZy5cblxuSWYgeW91IGFyZSwgdGVsbCBtZSB3aGF0IGhhcyBjaGFuZ2VkIGFuZCBJIHdpbGwgc2VuZCB5b3Ugc29tZXRoaW5nIGNsb3NlciB0byB3aGF0IHlvdSB3YW50LiBJZiB5b3UgaGF2ZSBhbHJlYWR5IGZvdW5kIHNvbWV3aGVyZSwgY29uZ3JhdHVsYXRpb25zIOKAlCBJIHdvdWxkIHN0aWxsIGxpa2UgdG8gaGVhciBob3cgaXQgd2VudC4gQW5kIGlmIHlvdSB3b3VsZCByYXRoZXIgbm90IGhlYXIgZnJvbSBtZSBhZ2Fpbiwgc2F5IHNvIGFuZCBJIHdpbGwgc3RvcC4iLCJhbGlnbiI6ImxlZnQifSx7InR5cGUiOiJib3giLCJ0aXRsZSI6IlN0aWxsIGhhcHB5IHRvIGhlbHAgd2l0aCIsImJvZHkiOiJOZXcgbGlzdGluZ3MgaW4gdGhlIGFyZWFzIHlvdSBhcmUgd2F0Y2hpbmdcbkFycmFuZ2luZyBhIHZpZXdpbmcgYXJvdW5kIHlvdXIgc2NoZWR1bGVcbkFuIGhvbmVzdCB2aWV3IG9mIHdoYXQgYSBwcm9wZXJ0eSBpcyB3b3J0aCIsImNvbG9yIjoiI2RjMjYyNiJ9LHsidHlwZSI6ImJ1dHRvbiIsInRleHQiOiJSZXBseSB0byBUaGlzIEVtYWlsIiwidXJsIjoibWFpbHRvOnt7QUdFTlRfRU1BSUx9fSIsImNvbG9yIjoiI2RjMjYyNiIsImFsaWduIjoiY2VudGVyIn1dLCJzdHlsZXMiOnsiaGVhZGVyIjp0cnVlLCJmb290ZXIiOnRydWUsImxvZ28iOiIiLCJicmFuZE5hbWUiOiJHZXQgSG9tZSBSZWFsdHkiLCJicmFuZCI6IiNkYzI2MjYiLCJhY2NlbnQiOiIjZGMyNjI2IiwiYmciOiIjZmZmZmZmIiwiZm9vdGVyVGV4dCI6IlwiQSBUcmFkaXRpb24gb2YgVHJ1c3RcIiDigJQgQnJva2VyYWdlXG57e0FHRU5UX05BTUV9fSDCtyB7e0FHRU5UX0VNQUlMfX0gwrcge3tBR0VOVF9QSE9ORX19In19-->
<div style="max-width:600px;margin:0 auto;background:#ffffff;font-family:Arial,Helvetica,sans-serif;">
<div style="text-align:center;padding:12px 24px 10px;background:#ffffff;"><div style="font-size:18px;font-weight:800;color:#dc2626;letter-spacing:.04em;text-transform:uppercase;">Get Home Realty</div></div><div style="height:3px;background:#dc2626;"></div>
<h1 style="text-align:center;color:#111827;font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:700;line-height:1.3;margin:16px 4px;">Checking In, {{LEAD_NAME}}</h1>
<p style="text-align:left;font-size:15px;line-height:1.65;color:#1f2937;margin:14px 4px;">Dear {{LEAD_NAME}},<br><br>It has been a little while, so I thought I would see whether you are still looking.<br><br>If you are, tell me what has changed and I will send you something closer to what you want. If you have already found somewhere, congratulations — I would still like to hear how it went. And if you would rather not hear from me again, say so and I will stop.</p>
<div style="background:rgba(220,38,38,0.08);border-left:4px solid #dc2626;border-radius:8px;padding:15px 18px;margin:16px 4px;"><div style="color:#dc2626;font-weight:700;font-size:15px;margin-bottom:7px;">Still happy to help with</div><div style="color:#334155;font-size:14px;line-height:1.65;">New listings in the areas you are watching<br>Arranging a viewing around your schedule<br>An honest view of what a property is worth</div></div>
<div style="text-align:center;margin:20px 4px;"><a href="mailto:{{AGENT_EMAIL}}" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:600;font-size:15px;">Reply to This Email</a></div>
<div style="border-top:1px solid #e5e7eb;background:#f8fafc;padding:22px 24px;text-align:center;font-size:12px;line-height:1.7;color:#94a3b8;"><div style="font-weight:800;color:#dc2626;letter-spacing:.04em;text-transform:uppercase;">Get Home Realty</div><div style="margin-top:4px;">"A Tradition of Trust" — Brokerage<br>{{AGENT_NAME}} · {{AGENT_EMAIL}} · {{AGENT_PHONE}}</div></div>
</div>',
       updated_at = now()
 WHERE name = 'checking'
   AND content ILIKE '%Write your message here%';

-- ---- "welcome" (development id 8484)
UPDATE campaign_templates
   SET subject = 'Welcome to Get Home Realty, {{LEAD_NAME}}',
       content = '<!--BUILDER:eyJ2IjoyLCJibG9ja3MiOlt7InR5cGUiOiJoZWFkaW5nIiwidGV4dCI6IldlbGNvbWUsIHt7TEVBRF9OQU1FfX0iLCJsZXZlbCI6MSwiYWxpZ24iOiJjZW50ZXIiLCJjb2xvciI6IiMxMTE4MjcifSx7InR5cGUiOiJwYXJhZ3JhcGgiLCJ0ZXh0IjoiRGVhciB7e0xFQURfTkFNRX19LFxuXG5UaGFuayB5b3UgZm9yIGdldHRpbmcgaW4gdG91Y2ggd2l0aCBHZXQgSG9tZSBSZWFsdHkg4oCUIHdlIGFyZSBnbGFkIHlvdSBkaWQsIGFuZCB3ZSBhcmUgbG9va2luZyBmb3J3YXJkIHRvIGhlbHBpbmcgeW91LlxuXG5JIGFtIHt7QUdFTlRfTkFNRX19LCBhbmQgSSB3aWxsIGJlIGxvb2tpbmcgYWZ0ZXIgeW91IGZyb20gaGVyZS4gV2hlbmV2ZXIgeW91IGhhdmUgYSBxdWVzdGlvbiDigJQgYWJvdXQgYSBwcm9wZXJ0eSwgYSBuZWlnaGJvdXJob29kLCBvciBzaW1wbHkgd2hlcmUgdG8gc3RhcnQg4oCUIHJlcGx5IHRvIHRoaXMgZW1haWwgYW5kIGl0IGNvbWVzIHN0cmFpZ2h0IHRvIG1lLiIsImFsaWduIjoibGVmdCJ9LHsidHlwZSI6ImJveCIsInRpdGxlIjoiV2hhdCBoYXBwZW5zIG5leHQiLCJib2R5IjoiSSBzZW5kIHlvdSBsaXN0aW5ncyB0aGF0IG1hdGNoIHdoYXQgeW91IGFyZSBsb29raW5nIGZvclxuV2UgYXJyYW5nZSB2aWV3aW5ncyBhdCB0aW1lcyB0aGF0IHN1aXQgeW91XG5ObyBwcmVzc3VyZSBhbmQgbm8gb2JsaWdhdGlvbiBhdCBhbnkgc3RhZ2UiLCJjb2xvciI6IiNkYzI2MjYifSx7InR5cGUiOiJidXR0b24iLCJ0ZXh0IjoiUmVwbHkgdG8gVGhpcyBFbWFpbCIsInVybCI6Im1haWx0bzp7e0FHRU5UX0VNQUlMfX0iLCJjb2xvciI6IiNkYzI2MjYiLCJhbGlnbiI6ImNlbnRlciJ9XSwic3R5bGVzIjp7ImhlYWRlciI6dHJ1ZSwiZm9vdGVyIjp0cnVlLCJsb2dvIjoiIiwiYnJhbmROYW1lIjoiR2V0IEhvbWUgUmVhbHR5IiwiYnJhbmQiOiIjZGMyNjI2IiwiYWNjZW50IjoiI2RjMjYyNiIsImJnIjoiI2ZmZmZmZiIsImZvb3RlclRleHQiOiJcIkEgVHJhZGl0aW9uIG9mIFRydXN0XCIg4oCUIEJyb2tlcmFnZVxue3tBR0VOVF9OQU1FfX0gwrcge3tBR0VOVF9FTUFJTH19IMK3IHt7QUdFTlRfUEhPTkV9fSJ9fQ==-->
<div style="max-width:600px;margin:0 auto;background:#ffffff;font-family:Arial,Helvetica,sans-serif;">
<div style="text-align:center;padding:12px 24px 10px;background:#ffffff;"><div style="font-size:18px;font-weight:800;color:#dc2626;letter-spacing:.04em;text-transform:uppercase;">Get Home Realty</div></div><div style="height:3px;background:#dc2626;"></div>
<h1 style="text-align:center;color:#111827;font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:700;line-height:1.3;margin:16px 4px;">Welcome, {{LEAD_NAME}}</h1>
<p style="text-align:left;font-size:15px;line-height:1.65;color:#1f2937;margin:14px 4px;">Dear {{LEAD_NAME}},<br><br>Thank you for getting in touch with Get Home Realty — we are glad you did, and we are looking forward to helping you.<br><br>I am {{AGENT_NAME}}, and I will be looking after you from here. Whenever you have a question — about a property, a neighbourhood, or simply where to start — reply to this email and it comes straight to me.</p>
<div style="background:rgba(220,38,38,0.08);border-left:4px solid #dc2626;border-radius:8px;padding:15px 18px;margin:16px 4px;"><div style="color:#dc2626;font-weight:700;font-size:15px;margin-bottom:7px;">What happens next</div><div style="color:#334155;font-size:14px;line-height:1.65;">I send you listings that match what you are looking for<br>We arrange viewings at times that suit you<br>No pressure and no obligation at any stage</div></div>
<div style="text-align:center;margin:20px 4px;"><a href="mailto:{{AGENT_EMAIL}}" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:600;font-size:15px;">Reply to This Email</a></div>
<div style="border-top:1px solid #e5e7eb;background:#f8fafc;padding:22px 24px;text-align:center;font-size:12px;line-height:1.7;color:#94a3b8;"><div style="font-weight:800;color:#dc2626;letter-spacing:.04em;text-transform:uppercase;">Get Home Realty</div><div style="margin-top:4px;">"A Tradition of Trust" — Brokerage<br>{{AGENT_NAME}} · {{AGENT_EMAIL}} · {{AGENT_PHONE}}</div></div>
</div>',
       updated_at = now()
 WHERE name = 'welcome'
   AND content ILIKE '%Write your message here%';

-- ---- retire the templates that still hold the placeholder and no campaign has used
UPDATE campaign_templates t
   SET is_active = false, updated_at = now()
 WHERE t.content ILIKE '%Write your message here%'
   AND t.is_active = true
   AND NOT EXISTS (SELECT 1 FROM campaigns k WHERE k.template_id = t.id);

-- ---- verification: must report 0 before you COMMIT
SELECT count(*) AS active_templates_still_holding_the_placeholder
  FROM campaign_templates
 WHERE content ILIKE '%Write your message here%' AND is_active = true;

-- COMMIT;   -- uncomment once the count above reads 0
ROLLBACK;   -- remove this line when you are ready to commit
