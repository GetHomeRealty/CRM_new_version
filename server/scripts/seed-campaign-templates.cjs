/**
 * Seeds the starter campaign template library.
 *
 * IMPORTANT: this wording is a starting point written for Transaction Desk — it is NOT a copy of
 * the templates from the previous system, whose content was never available here. Edit each one
 * under Campaigns → Email Templates to match how your brokerage actually writes.
 *
 * Idempotent: a template whose name already exists is left exactly as it is, so running this
 * again never overwrites edits. Pass --force to reset the starters back to this wording.
 *
 *   node scripts/seed-campaign-templates.cjs
 *   node scripts/seed-campaign-templates.cjs --force
 *
 * Only tokens the send engine actually fills are used: LEAD_NAME, AGENT_NAME, AGENT_EMAIL,
 * AGENT_PHONE, PROPERTY_ADDRESS, PROPERTY_PRICE, BEDROOMS, BATHROOMS, SQUARE_FOOTAGE,
 * KEY_FEATURES. Property tokens come from each lead's own record and render blank when that
 * lead has no value, so every template below still reads correctly without them.
 */
const { PrismaClient } = require('@prisma/client');

const force = process.argv.includes('--force');

/** Shared shell so every email renders consistently in Gmail, Outlook and Apple Mail. */
const wrap = (body) => `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;max-width:600px;margin:0 auto;padding:8px">
${body}
<hr style="border:0;border-top:1px solid #e5e7eb;margin:26px 0 14px">
<p style="font-size:13px;color:#6b7280;margin:0">
  {{AGENT_NAME}}<br>
  Get Home Realty<br>
  <a href="mailto:{{AGENT_EMAIL}}" style="color:#4f46e5">{{AGENT_EMAIL}}</a> · {{AGENT_PHONE}}
</p>
</div>`;

const TEMPLATES = [
  {
    name: 'Welcome — New Enquiry',
    category: 'welcome',
    subject: 'Welcome, {{LEAD_NAME}} — let’s find the right home',
    content: wrap(`<p>Hi {{LEAD_NAME}},</p>
<p>Thanks for getting in touch. I’m {{AGENT_NAME}}, and I’ll be looking after your search from here.</p>
<p>To make sure I only send you places worth your time, it helps to know three things:</p>
<ul>
  <li>The areas you’re considering</li>
  <li>Your budget range</li>
  <li>When you’d ideally like to move</li>
</ul>
<p>Just reply to this email with whatever you know so far — rough answers are fine.</p>
<p>Talk soon,</p>`),
  },
  {
    name: 'New Listing Match',
    category: 'property-update',
    subject: 'A new listing that fits what you’re looking for',
    content: wrap(`<p>Hi {{LEAD_NAME}},</p>
<p>A property came up that matches your search:</p>
<table style="border-collapse:collapse;margin:14px 0;font-size:14px">
  <tr><td style="padding:5px 14px 5px 0;color:#6b7280">Address</td><td style="padding:5px 0"><strong>{{PROPERTY_ADDRESS}}</strong></td></tr>
  <tr><td style="padding:5px 14px 5px 0;color:#6b7280">Price</td><td style="padding:5px 0">{{PROPERTY_PRICE}}</td></tr>
  <tr><td style="padding:5px 14px 5px 0;color:#6b7280">Bedrooms</td><td style="padding:5px 0">{{BEDROOMS}}</td></tr>
  <tr><td style="padding:5px 14px 5px 0;color:#6b7280">Bathrooms</td><td style="padding:5px 0">{{BATHROOMS}}</td></tr>
  <tr><td style="padding:5px 14px 5px 0;color:#6b7280">Size</td><td style="padding:5px 0">{{SQUARE_FOOTAGE}}</td></tr>
</table>
<p>{{KEY_FEATURES}}</p>
<p>Would you like to see it this week? Reply with a couple of times that suit you and I’ll arrange it.</p>`),
  },
  {
    name: 'Showing Confirmation',
    category: 'showing',
    subject: 'Your viewing is confirmed',
    content: wrap(`<p>Hi {{LEAD_NAME}},</p>
<p>Your viewing of <strong>{{PROPERTY_ADDRESS}}</strong> is booked. I’ll meet you at the door — give yourself about 30 minutes to look around properly.</p>
<p>Worth doing before you arrive:</p>
<ul>
  <li>Have a look at the street on a map — parking, transit, what’s nearby</li>
  <li>Note any questions about the building, the age of the roof or the mechanicals</li>
  <li>Bring anyone whose opinion will matter in the decision</li>
</ul>
<p>If anything changes, call or text me on {{AGENT_PHONE}} and I’ll rearrange it.</p>`),
  },
  {
    name: 'Showing Follow-up',
    category: 'showing',
    subject: 'What did you think of {{PROPERTY_ADDRESS}}?',
    content: wrap(`<p>Hi {{LEAD_NAME}},</p>
<p>Thanks for coming to see {{PROPERTY_ADDRESS}}. What was your honest impression?</p>
<p>Whether it was a yes, a no, or a maybe, telling me <em>why</em> is genuinely useful — it’s how I stop sending you the wrong places.</p>
<p>If you’d like to go back for a second look, or want me to find out more about the property before you decide, just say the word.</p>`),
  },
  {
    name: 'Checking In',
    category: 'follow-up',
    subject: 'Still looking, {{LEAD_NAME}}?',
    content: wrap(`<p>Hi {{LEAD_NAME}},</p>
<p>It’s been a little while, so I thought I’d check in rather than keep sending listings into the void.</p>
<p>Where are you at?</p>
<ul>
  <li><strong>Still looking</strong> — tell me what’s changed and I’ll adjust the search</li>
  <li><strong>Paused for now</strong> — no problem, I’ll check back another time</li>
  <li><strong>Sorted elsewhere</strong> — congratulations, and let me know so I stop emailing you</li>
</ul>
<p>A one-line reply is plenty.</p>`),
  },
  {
    name: 'Price Improvement',
    category: 'property-update',
    subject: 'Price reduced on a home you were watching',
    content: wrap(`<p>Hi {{LEAD_NAME}},</p>
<p>The asking price on <strong>{{PROPERTY_ADDRESS}}</strong> has come down. It’s now <strong>{{PROPERTY_PRICE}}</strong>.</p>
<p>Reductions tend to bring renewed interest, so if this one was on your list it’s worth another look sooner rather than later.</p>
<p>Want me to book a viewing, or pull the full history on the listing first?</p>`),
  },
  {
    name: 'Thank You — After Closing',
    category: 'thank-you',
    subject: 'Congratulations, and thank you',
    content: wrap(`<p>Hi {{LEAD_NAME}},</p>
<p>Congratulations — it’s done. It was a pleasure working with you, and I hope the move goes smoothly.</p>
<p>A few things worth doing in the first fortnight: change the locks, note where the main water shut-off is, and update your address with your bank, insurer and the utilities.</p>
<p>If you ever need a tradesperson, a valuation, or just a second opinion on something property-related, my number stays the same: {{AGENT_PHONE}}.</p>
<p>And if you know someone else who’s buying or selling, I’d be grateful for the introduction.</p>`),
  },
];

(async () => {
  const prisma = new PrismaClient();
  const now = new Date();
  let created = 0, updated = 0, kept = 0;

  try {
    for (const t of TEMPLATES) {
      const existing = await prisma.campaign_templates.findFirst({ where: { name: t.name, deleted_at: null } });

      if (existing && !force) { kept++; console.log(`  kept    ${t.name} (already present, #${existing.id})`); continue; }

      if (existing) {
        await prisma.campaign_templates.update({
          where: { id: existing.id },
          data: { subject: t.subject, content: t.content, category: t.category, updated_at: now },
        });
        updated++;
        console.log(`  reset   ${t.name} (#${existing.id})`);
      } else {
        const row = await prisma.campaign_templates.create({
          data: {
            name: t.name, subject: t.subject, content: t.content, category: t.category,
            is_active: true, created_by: 'Starter template', created_at: now, updated_at: now,
          },
        });
        created++;
        console.log(`  created ${t.name} (#${row.id})`);
      }
    }

    const total = await prisma.campaign_templates.count({ where: { deleted_at: null } });
    console.log(`\n${created} created, ${updated} reset, ${kept} left alone — ${total} template(s) in the library.`);
    console.log('Edit them under Campaigns → Email Templates; the wording is a starting point, not your old copy.');
  } finally {
    await prisma.$disconnect();
  }
})();
