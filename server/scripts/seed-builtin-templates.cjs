/**
 * Seeds / refreshes styled built-in campaign templates using the visual-builder model (v2:
 * standard header + granular blocks — heading, paragraph, highlight box, button). They render as
 * polished emails AND open in the visual builder for editing.
 *
 * A template that still carries our builder marker is refreshed to the current design; a
 * hand-authored one (no marker) with the same name is left untouched. Run:
 *   node scripts/seed-builtin-templates.cjs
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const prisma = new PrismaClient();

/**
 * Embed the logo as a real image (base64 data URI, no external URL) if a logo file is present.
 * Drop the file at any of these paths and re-run:
 *   server/scripts/logo.png (or .webp/.jpg/.svg)   ·   client/public/logo.png
 * If none is found, the banner falls back to a clean "Get Home Realty" text logo.
 */
function loadLogo() {
  const names = ['logo.png', 'logo.webp', 'logo.jpg', 'logo.jpeg', 'logo.svg'];
  const dirs = [path.join(process.cwd(), 'scripts'), path.join(process.cwd(), 'assets'), path.join(process.cwd(), '..', 'client', 'public')];
  for (const d of dirs) for (const n of names) {
    const f = path.join(d, n);
    if (fs.existsSync(f)) {
      const ext = path.extname(f).slice(1).toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      return { uri: `data:${mime};base64,${fs.readFileSync(f).toString('base64')}`, from: f };
    }
  }
  return { uri: '', from: null };
}
const LOGO = loadLogo();

// ---- port of client/src/desk/TemplateBuilder.tsx renderBuilder (kept in sync by hand) ----
const DEFAULT_STYLES = { header: false, footer: false, logo: '', brandName: 'Get Home Realty', brand: '#dc2626', accent: '#dc2626', bg: '#ffffff', footerText: '' };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const brs = (s) => esc(s).replace(/\n/g, '<br>');
function tint(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return `rgba(37,99,235,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
function blockHtml(b) {
  switch (b.type) {
    case 'banner': {
      const bg = b.color2 ? `background:${b.color};background:linear-gradient(135deg,${b.color},${b.color2});` : `background:${b.color};`;
      const logo = b.logo
        ? `<img src="${b.logo}" alt="${esc(b.logoText || '')}" style="max-height:52px;margin:0 auto 16px;display:block;background:#ffffff;padding:8px 12px;border-radius:8px;">`
        : b.logoText
          ? `<div style="font-size:15px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;margin-bottom:14px;">${esc(b.logoText)}</div>`
          : '';
      const sub = b.subtitle ? `<div style="font-size:14px;font-weight:400;opacity:.92;margin-top:9px;">${esc(b.subtitle)}</div>` : '';
      return `<div style="${bg}color:#ffffff;padding:${logo ? '28px' : '38px'} 24px 34px;text-align:center;border-radius:10px 10px 0 0;">${logo}<div style="font-size:26px;font-weight:700;line-height:1.25;">${esc(b.text)}</div>${sub}</div>`;
    }
    case 'image': {
      const img = `<img src="${esc(b.url)}" alt="${esc(b.alt)}" style="width:${b.width}%;max-width:100%;display:inline-block;border:0;">`;
      const inner = b.link ? `<a href="${esc(b.link)}" style="text-decoration:none;">${img}</a>` : img;
      return `<div style="text-align:${b.align};margin:14px 4px;">${inner}</div>`;
    }
    case 'heading': {
      const size = b.level === 1 ? 26 : b.level === 2 ? 21 : 17;
      return `<h${b.level} style="text-align:${b.align};color:${b.color};font-family:Arial,Helvetica,sans-serif;font-size:${size}px;font-weight:700;line-height:1.3;margin:16px 4px;">${esc(b.text)}</h${b.level}>`;
    }
    case 'paragraph':
      return `<p style="text-align:${b.align};font-size:15px;line-height:1.65;color:#1f2937;margin:14px 4px;">${brs(b.text)}</p>`;
    case 'button':
      return `<div style="text-align:${b.align};margin:20px 4px;"><a href="${esc(b.url)}" style="display:inline-block;background:${b.color};color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:600;font-size:15px;">${esc(b.text)}</a></div>`;
    case 'divider':
      return `<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 4px;">`;
    case 'spacer':
      return `<div style="height:${Math.max(0, b.height)}px;line-height:${Math.max(0, b.height)}px;font-size:1px;">&nbsp;</div>`;
    case 'columns':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0;"><tr>`
        + `<td valign="top" style="width:50%;padding:0 8px;font-size:14px;line-height:1.6;color:#334155;">${brs(b.left)}</td>`
        + `<td valign="top" style="width:50%;padding:0 8px;font-size:14px;line-height:1.6;color:#334155;">${brs(b.right)}</td></tr></table>`;
    case 'box':
      return `<div style="background:${tint(b.color, 0.08)};border-left:4px solid ${b.color};border-radius:8px;padding:15px 18px;margin:16px 4px;">`
        + `<div style="color:${b.color};font-weight:700;font-size:15px;margin-bottom:7px;">${esc(b.title)}</div>`
        + `<div style="color:#334155;font-size:14px;line-height:1.65;">${brs(b.body)}</div></div>`;
    case 'list': {
      const items = b.items.split('\n').map((i) => i.trim()).filter(Boolean).map((i) => `<li style="margin:4px 0;">${esc(i)}</li>`).join('');
      return `<div style="margin:16px 4px;">${b.title ? `<div style="font-weight:700;font-size:15px;margin-bottom:6px;color:#1f2937;">${esc(b.title)}</div>` : ''}`
        + `<ul style="margin:0;padding-left:20px;color:#334155;font-size:14px;line-height:1.6;">${items}</ul></div>`;
    }
  }
}
function headerHtml(s) {
  if (!s.header) return '';
  const logo = s.logo
    ? `<img src="${s.logo}" alt="${esc(s.brandName || '')}" style="max-height:48px;display:inline-block;border:0;">`
    : `<div style="font-size:18px;font-weight:800;color:${s.brand};letter-spacing:.04em;text-transform:uppercase;">${esc(s.brandName || 'Your Logo')}</div>`;
  return `<div style="text-align:center;padding:12px 24px 10px;background:#ffffff;">${logo}</div><div style="height:3px;background:${s.accent};"></div>`;
}
function footerHtml(s) {
  if (!s.footer) return '';
  return `<div style="border-top:1px solid #e5e7eb;background:#f8fafc;padding:22px 24px;text-align:center;font-size:12px;line-height:1.7;color:#94a3b8;">`
    + (s.brandName ? `<div style="font-weight:800;color:${s.brand};letter-spacing:.04em;text-transform:uppercase;">${esc(s.brandName)}</div>` : '')
    + (s.footerText ? `<div style="margin-top:4px;">${brs(s.footerText)}</div>` : '')
    + `</div>`;
}
function renderBuilder(blocks, styles) {
  const s = { ...DEFAULT_STYLES, ...styles };
  const marker = `<!--BUILDER:${Buffer.from(JSON.stringify({ v: 2, blocks, styles: s }), 'utf8').toString('base64')}-->`;
  const body = blocks.map(blockHtml).join('\n');
  return `${marker}\n<div style="max-width:600px;margin:0 auto;background:${s.bg};font-family:Arial,Helvetica,sans-serif;">\n${headerHtml(s)}\n${body}\n${footerHtml(s)}\n</div>`;
}

// ---- the built-in templates ----
// A gradient banner (heading + subtitle) leads each email, then paragraphs, a highlight box and a
// reply button. Logo is left empty so no broken image shows — add a logo URL on the banner block
// in the visual builder to brand it.
// The gradient hero (no logo here — the standard header carries the logo).
const BANNER = (text, subtitle, c1, c2) => ({ type: 'banner', text, subtitle, logo: '', logoText: '', color: c1, color2: c2 });
const P = (text) => ({ type: 'paragraph', text, align: 'left' });
const BOX = (title, body, color) => ({ type: 'box', title, body, color });
const REPLY = (color) => ({ type: 'button', text: 'Reply to This Email', url: 'mailto:{{AGENT_EMAIL}}', color, align: 'center' });
// Standard header (logo + accent) + standard footer (brand + contact) on every template.
const STD_FOOTER = '"A Tradition of Trust" — Brokerage\n{{AGENT_NAME}} · {{AGENT_EMAIL}} · {{AGENT_PHONE}}';
const styles = (accent) => ({
  header: true, footer: true, logo: LOGO.uri, brandName: 'Get Home Realty',
  brand: '#dc2626', accent, bg: '#ffffff', footerText: STD_FOOTER,
});

const TEMPLATES = [
  {
    name: 'Thank You After Showing', category: 'thank-you',
    subject: 'Thank you for the property showing - Next Steps',
    blocks: [
      BANNER('Thank You for Viewing!', 'It was a pleasure showing you around', '#2563eb', '#0ea5e9'),
      P('Dear {{LEAD_NAME}},\n\nThank you for taking the time to view the property at {{PROPERTY_ADDRESS}} today. It was a pleasure showing you around and discussing your real estate goals.'),
      BOX('Your Feedback Matters', "I'd love to hear your thoughts about the property:\nWhat did you like most about the property?\nAre there any concerns or questions you have?\nHow does it compare to other properties you've seen?", '#2563eb'),
      { type: 'list', title: '📝 Next Steps Options', items: 'Schedule a second viewing\nGet a comparative market analysis\nDiscuss financing options\nExplore similar properties\nMake an offer' },
      P("I'm here to support you through every step of your real estate journey.\n\nBest regards,\n{{AGENT_NAME}}"),
      REPLY('#2563eb'),
    ],
  },
  {
    name: 'Property Showing Confirmation', category: 'showing',
    subject: 'Property Showing Confirmed - {{PROPERTY_ADDRESS}}',
    blocks: [
      BANNER('Property Showing Confirmed', 'Everything you need for your visit', '#f97316', '#dc2626'),
      P('Dear {{LEAD_NAME}},\n\nGreat news! Your property showing has been confirmed. Here are the important details:'),
      BOX('Showing Details', 'Property Address: {{PROPERTY_ADDRESS}}\nDate & Time: {{SHOWING_DATE_TIME}}\nMeeting Point: Front entrance', '#f97316'),
      P('Please arrive a few minutes early. If anything changes, just reply to this email.\n\nSee you soon,\n{{AGENT_NAME}}'),
      REPLY('#f97316'),
    ],
  },
  {
    name: 'New Property Match', category: 'property-update',
    subject: 'New Property Match - Perfect for Your Requirements!',
    blocks: [
      BANNER('🏠 New Property Match Found!', 'Fresh on the market, matched to you', '#7c3aed', '#4f46e5'),
      P("Dear {{LEAD_NAME}},\n\nI'm excited to share that I've found a property that matches your criteria perfectly! This one just hit the market and I believe it's exactly what you've been looking for."),
      BOX('Property Highlights', 'Address: {{PROPERTY_ADDRESS}}\nPrice: {{PROPERTY_PRICE}}\nBedrooms: {{BEDROOMS}}\nBathrooms: {{BATHROOMS}}', '#7c3aed'),
      { type: 'button', text: 'Arrange a Viewing', url: 'mailto:{{AGENT_EMAIL}}', color: '#7c3aed', align: 'center' },
      P('Homes like this move quickly — let me know if you would like to see it.\n\nWarm regards,\n{{AGENT_NAME}}'),
    ],
  },
  {
    name: 'Market Update Newsletter', category: 'property-update',
    subject: 'Monthly Market Update - {{MONTH_YEAR}}',
    blocks: [
      BANNER('📊 Market Update - {{MONTH_YEAR}}', 'The numbers that matter this month', '#ef4444', '#f59e0b'),
      P("Dear {{LEAD_NAME}},\n\nI hope you're doing well! I wanted to share the latest market insights and trends that could impact your real estate decisions."),
      BOX('Market Highlights', 'Average Home Price: {{AVERAGE_PRICE}}\nPrice change from last month: {{PRICE_CHANGE}}\nHomes sold: {{HOMES_SOLD}}\nAverage days on market: {{DAYS_ON_MARKET}}', '#ef4444'),
      P('If you would like a personalised assessment of your home or neighbourhood, just reply and I will put one together.\n\nBest,\n{{AGENT_NAME}}'),
      REPLY('#ef4444'),
    ],
  },
  {
    name: 'Follow-up on Inquiry', category: 'follow-up',
    subject: 'Following up on your property inquiry - Get Home Realty',
    blocks: [
      BANNER('Property Update for {{LEAD_NAME}}', 'A quick follow-up from Get Home Realty', '#16a34a', '#0d9488'),
      P('Dear {{LEAD_NAME}},\n\nI hope this message finds you well! I wanted to follow up on your recent property inquiry and share some exciting updates that might interest you.'),
      BOX('Market Update', 'The local real estate market has been quite active, and new opportunities are coming up that fit what you described.', '#16a34a'),
      P("Would you like to hop on a quick call this week?\n\nTalk soon,\n{{AGENT_NAME}}"),
      REPLY('#16a34a'),
    ],
  },
  {
    name: 'Leads Follow Up', category: 'follow-up',
    subject: 'Just checking in, {{LEAD_NAME}} - Get Home Realty',
    blocks: [
      BANNER('Still Here to Help, {{LEAD_NAME}}', 'A quick check-in from Get Home Realty', '#dc2626', '#7c3aed'),
      P("Dear {{LEAD_NAME}},\n\nIt's been a little while since we last connected, so I wanted to check in and see where you are in your property search. There's no pressure at all — whether you're actively looking or simply keeping an eye on the market, I'm happy to help either way."),
      BOX('How I Can Help Right Now', "Send you fresh listings that match what you're after\nShare what comparable homes are actually selling for\nArrange a viewing at a time that suits you\nConnect you with a trusted mortgage advisor", '#dc2626'),
      P("If your plans have changed or the timing isn't right, just reply and let me know — I'll keep your details on file and reach out only when something genuinely worth seeing comes up."),
      REPLY('#dc2626'),
    ],
  },
  {
    name: 'Welcome New Lead', category: 'welcome',
    subject: "Welcome! Let's find your perfect home",
    blocks: [
      BANNER('Welcome, {{LEAD_NAME}}!', "Let's find your perfect home", '#2563eb', '#0ea5e9'),
      P("Dear {{LEAD_NAME}},\n\nThank you for reaching out — I'm delighted to help you with your real estate journey. My goal is to make the process smooth, clear and even enjoyable."),
      BOX('What happens next', "We'll talk through what you're looking for\nI'll set up tailored property alerts for you\nWe'll arrange viewings whenever you're ready", '#2563eb'),
      P('Feel free to reply with any questions at all.\n\nWarm welcome,\n{{AGENT_NAME}}'),
      REPLY('#2563eb'),
    ],
  },
  {
    name: 'New Listing Match', category: 'property-update',
    subject: "A new listing that fits what you're looking for",
    blocks: [
      BANNER('A New Listing for You', 'Fresh on the market, matched to your search', '#2563eb', '#0ea5e9'),
      P("Dear {{LEAD_NAME}},\n\nA property just came on the market that lines up well with what you're looking for. I wanted you to be among the first to see it."),
      BOX('Listing Details', 'Address: {{PROPERTY_ADDRESS}}\nPrice: {{PROPERTY_PRICE}}\nBedrooms: {{BEDROOMS}}\nBathrooms: {{BATHROOMS}}', '#2563eb'),
      { type: 'button', text: 'View the Listing', url: 'mailto:{{AGENT_EMAIL}}', color: '#2563eb', align: 'center' },
      P('Would you like to arrange a viewing?\n\nBest regards,\n{{AGENT_NAME}}'),
    ],
  },
  {
    name: 'Price Improvement', category: 'property-update',
    subject: 'Price reduced on a home you were watching',
    blocks: [
      BANNER('Price Improvement', 'A home you liked just got better value', '#f97316', '#dc2626'),
      P('Dear {{LEAD_NAME}},\n\nGood news — the price has just been reduced on a property you were interested in. It may be worth another look.'),
      BOX('Updated Pricing', 'Address: {{PROPERTY_ADDRESS}}\nNew Price: {{PROPERTY_PRICE}}', '#f97316'),
      P('Reduced homes often attract quick interest — let me know if you would like to revisit it.\n\nBest,\n{{AGENT_NAME}}'),
      REPLY('#f97316'),
    ],
  },
  {
    name: 'Showing Follow-up', category: 'showing',
    subject: 'What did you think of {{PROPERTY_ADDRESS}}?',
    blocks: [
      BANNER('How Was the Showing?', 'Your thoughts help me help you', '#16a34a', '#0d9488'),
      P('Dear {{LEAD_NAME}},\n\nThank you for viewing {{PROPERTY_ADDRESS}}. I would love to hear what you thought so I can fine-tune what I send you next.'),
      BOX('A Few Quick Questions', 'Did the home feel right for you?\nHow was the location and layout?\nWould you like to see anything similar?', '#16a34a'),
      P('Just reply with a line or two — no detail is too small.\n\nTalk soon,\n{{AGENT_NAME}}'),
      REPLY('#16a34a'),
    ],
  },
];

// The old plain-HTML starter templates that these replace / supersede. Soft-deleted below so the
// library shows only the styled built-ins (they can be restored from Recently Deleted).
const RETIRE = ['Welcome — New Enquiry', 'New Listing Match', 'Showing Confirmation', 'Showing Follow-up', 'Price Improvement', 'Thank You — After Closing', 'Checking In'];

(async () => {
  console.log(LOGO.from ? `Logo: embedding ${LOGO.from} (${Math.round(LOGO.uri.length / 1024)} KB base64)` : 'Logo: none found — using the "Get Home Realty" text logo. Drop logo.png in scripts/ or client/public/ and re-run to embed the image.');
  const now = new Date();

  // Retire the old plain-HTML starter templates (they render blank) so the library shows only the
  // styled built-ins. Only plain ones are touched — never a styled or user-edited template — and
  // it's a soft delete, recoverable from Recently Deleted.
  const retired = await prisma.campaign_templates.updateMany({
    where: { name: { in: RETIRE }, deleted_at: null, NOT: { content: { contains: 'BUILDER:' } } },
    data: { deleted_at: now, updated_at: now },
  });
  console.log(`Retired ${retired.count} old plain starter template(s).`);

  let added = 0, updated = 0, skipped = 0;
  for (const t of TEMPLATES) {
    const banner = t.blocks.find((b) => b.type === 'banner');
    const content = renderBuilder(t.blocks, styles(banner ? banner.color : '#dc2626'));
    const exists = await prisma.campaign_templates.findFirst({ where: { name: t.name, deleted_at: null }, select: { id: true, content: true } });
    if (!exists) {
      const row = await prisma.campaign_templates.create({ data: { name: t.name, subject: t.subject, category: t.category, content, is_active: true, created_at: now, updated_at: now } });
      console.log(`  ADD   "${t.name}" [${t.category}] → #${row.id}`); added++;
    } else if (/<!--BUILDER:/.test(exists.content)) {
      await prisma.campaign_templates.update({ where: { id: exists.id }, data: { subject: t.subject, category: t.category, content, updated_at: now } });
      console.log(`  UPD   "${t.name}" [${t.category}] → #${exists.id}`); updated++;
    } else {
      console.log(`  SKIP  "${t.name}" — a customised template with this name exists (#${exists.id})`); skipped++;
    }
  }
  console.log(`\nDone — ${added} added, ${updated} updated, ${skipped} skipped.`);
  await prisma.$disconnect();
})();
