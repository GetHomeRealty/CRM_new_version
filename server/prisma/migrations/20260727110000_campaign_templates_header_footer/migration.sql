-- Give the seeded sample campaign templates the same fixed branded header (brand bar + accent line)
-- and footer (brand + tagline + contact) that the visual builder's Standard header/footer produce,
-- so the samples look complete out of the box.
--
-- Applies only to the System-seeded samples, and is guarded so it never double-wraps (idempotent,
-- and safe to run after the seed on a fresh database).

UPDATE "campaign_templates"
SET "content" =
      '<div style="max-width:600px;margin:0 auto;background:#ffffff;font-family:Arial,Helvetica,sans-serif;">'
    || '<div style="text-align:center;padding:14px 24px 10px;background:#ffffff;"><div style="font-size:19px;font-weight:800;color:#dc2626;letter-spacing:.04em;text-transform:uppercase;">Get Home Realty</div></div><div style="height:3px;background:#dc2626;"></div>'
    || "content"
    || '<div style="border-top:1px solid #e5e7eb;background:#f8fafc;padding:22px 24px;text-align:center;font-size:12px;line-height:1.7;color:#94a3b8;"><div style="font-weight:800;color:#dc2626;letter-spacing:.04em;text-transform:uppercase;">Get Home Realty</div><div style="margin-top:4px;">&quot;A Tradition of Trust&quot; &mdash; Brokerage<br>info@gethomerealty.ca &middot; +1 (905) 565-9933</div></div>'
    || '</div>',
    "updated_at" = NOW()
WHERE "created_by" = 'System'
  AND "deleted_at" IS NULL
  AND "content" NOT LIKE '%height:3px;background:#dc2626%';
