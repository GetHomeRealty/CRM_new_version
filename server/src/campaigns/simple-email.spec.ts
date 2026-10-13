import { simplifyHtml, ensureGreeting, simpleEmailBody } from './simple-email';

/**
 * THE SIMPLE EMAIL BODY — pure, so it is asserted directly with no database and no mailer.
 *
 * WHAT THESE PIN. The simplifier's one job is to keep every word the author wrote while dropping
 * the newsletter furniture. The failure that would matter is not "it left a `<table>` behind" — it
 * is "it ate the message", and a table-laid-out template is the shape where that happens, because
 * such a template has no `<p>` anywhere for the text to live in.
 *
 * WHAT THIS IS NOT TESTING. Nothing here is a claim about which Gmail tab anything lands in. These
 * assert a readable, lighter body; placement is decided per recipient and no sender controls it.
 */

describe('the simplifier keeps the words and drops the decoration', () => {
  it('KEEPS EVERY WORD of a table-laid-out template, which is where stripping would eat the message', () => {
    const designed = `
      <table width="600" bgcolor="#f5f5f5" cellpadding="20">
        <tr><td style="background:#0a4;color:#fff;font-size:28px;">GET HOME REALTY</td></tr>
        <tr><td><img src="https://cdn.test/banner.png" width="600" alt="Spring market" /></td></tr>
        <tr><td style="font-family:Georgia;">Prices in Brampton rose 3% last month.</td></tr>
        <tr><td><a href="https://gethomerealty.ca/listings" style="background:#0a4;padding:14px 28px;color:#fff;border-radius:6px;display:inline-block;">BROWSE LISTINGS NOW</a></td></tr>
      </table>`;

    const out = simplifyHtml(designed);

    // The words survive.
    expect(out).toContain('GET HOME REALTY');
    expect(out).toContain('Prices in Brampton rose 3% last month.');
    expect(out).toContain('BROWSE LISTINGS NOW');
    // The furniture does not.
    expect(out).not.toMatch(/<table|<tr|<td|bgcolor|cellpadding/i);
    expect(out).not.toContain('<img');
    expect(out).not.toMatch(/style\s*=/i);
    expect(out).not.toContain('border-radius');
  });

  it('KEEPS LINKS WORKING — dropping them would silently break every call to action', () => {
    const out = simplifyHtml('<p>See the <a href="https://gethomerealty.ca/listings" style="color:#fff">new listings</a>.</p>');
    expect(out).toContain('<a href="https://gethomerealty.ca/listings">');
    expect(out).toContain('new listings');
    // The link survives; its button styling does not.
    expect(out).not.toMatch(/style\s*=/i);
  });

  it('keeps emphasis and lists, which are prose rather than decoration', () => {
    const out = simplifyHtml('<p>Three <strong>things</strong>:</p><ul><li>One</li><li>Two</li></ul>');
    expect(out).toContain('<strong>things</strong>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>One</li>');
  });

  it('GIVES A DIV-LAID-OUT TEMPLATE PARAGRAPH BREAKS, rather than one run-together block', () => {
    /*
     * The failure this catches: unwrap the tags first and every line joins into a single
     * paragraph. All the words are present and the email is unreadable, which is the kind of
     * regression that passes a "does it contain the text" assertion.
     */
    const out = simplifyHtml('<div>First line.</div><div>Second line.</div><div>Third line.</div>');
    const paragraphs = out.split(/<\/p>/).filter((p) => /[A-Za-z]/.test(p));
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
    expect(out.indexOf('First line.')).toBeLessThan(out.indexOf('Second line.'));
  });

  it('DROPS SCRIPT AND STYLE CONTENT, not just their tags', () => {
    const out = simplifyHtml('<style>.x{color:red}</style><script>alert(1)</script><p>Hello.</p>');
    expect(out).toContain('Hello.');
    expect(out).not.toContain('color:red');
    expect(out).not.toContain('alert');
  });

  it('REFUSES A javascript: HREF, rendering it as text instead of a link', () => {
    // A template carrying one is either a mistake or an attack; either way it must not reach a
    // recipient's mail client as something clickable.
    const out = simplifyHtml('<a href="javascript:alert(1)">Click</a>');
    expect(out).toContain('Click');
    expect(out).not.toContain('javascript:');
    expect(out).not.toMatch(/href=/i);
  });

  it('allows mailto, which is a reply link and not a redirect', () => {
    expect(simplifyHtml('<a href="mailto:dana@test.local">Email me</a>'))
      .toContain('<a href="mailto:dana@test.local">');
  });

  it('strips Outlook conditional comments', () => {
    const out = simplifyHtml('<!--[if mso]><table><tr><td><![endif]--><p>Hello.</p>');
    expect(out).toContain('Hello.');
    expect(out).not.toContain('mso');
  });

  it('leaves a message that is already plain almost exactly as it was', () => {
    const plain = '<p>Hi there,</p><p>The market moved this month.</p>';
    expect(simplifyHtml(plain)).toBe(plain);
  });

  it('survives an empty or markup-only body without throwing', () => {
    for (const input of ['', '   ', '<div></div>', '<table><tr><td></td></tr></table>']) {
      expect(typeof simplifyHtml(input)).toBe('string');
    }
  });
});

describe('the greeting', () => {
  it('ADDS ONE when the message opens straight into its subject matter', () => {
    const out = ensureGreeting('<p>The market moved this month.</p>');
    expect(out).toContain('Hi {{LEAD_NAME}},');
    // A TOKEN, not a resolved name: this runs before personalisation, so the same `personalize`
    // call that fills the standard body fills this too — including its "there" fallback.
    expect(out).toContain('{{LEAD_NAME}}');
  });

  it('DOES NOT ADD A SECOND ONE when the template already greets the reader', () => {
    // Two greetings stacked is exactly what makes an email look machine-assembled.
    for (const opening of ['Hi {{LEAD_NAME}},', 'Hello {{LEAD_NAME}}', 'Dear Ms Okafor', 'Good morning,', 'Hey there']) {
      const out = ensureGreeting(`<p>${opening}</p><p>Body.</p>`);
      expect(out.match(/Hi \{\{LEAD_NAME\}\},/g) ?? []).toHaveLength(opening.startsWith('Hi {{') ? 1 : 0);
      expect(out.startsWith('<p>Hi {{LEAD_NAME}},</p>')).toBe(opening.startsWith('Hi {{'));
    }
  });

  it('sees past the markup to find the greeting', () => {
    // A greeting wrapped in a styled span is still a greeting.
    const out = ensureGreeting('<div><span style="font-size:18px"><b>Hello {{LEAD_NAME}}</b></span></div>');
    expect(out).not.toMatch(/Hi \{\{LEAD_NAME\}\},/);
  });
});

describe('the assembled body', () => {
  it('wraps in system fonts with NO card, width or background', () => {
    /*
     * A fixed-width centred card on a grey background is the single most recognisable newsletter
     * shape there is. The wrapper sets type and colour so the mail resembles what the reader's own
     * messages look like, and nothing else.
     */
    const out = simpleEmailBody('<p>Hello.</p>');
    expect(out).toContain('font-family');
    expect(out).not.toMatch(/max-width|width:\s*\d|background(-color)?:|border|margin:\s*0\s+auto/i);
  });

  it('DOES NOT ADD AN UNSUBSCRIBE FOOTER — that has one implementation, at send time', () => {
    /*
     * Deliberate, and the reason is compliance. `injectTracking` appends the unsubscribe link for
     * EVERY mode; adding a second copy here would mean two implementations of the one thing that
     * must never be missing, and the duplicate is what eventually diverges.
     */
    const out = simpleEmailBody('<p>Hello.</p>');
    expect(out.toLowerCase()).not.toContain('unsubscribe');
  });

  it('is simplified AND greeted, in that order', () => {
    const out = simpleEmailBody('<table><tr><td style="color:red">Prices moved.</td></tr></table>');
    expect(out).toContain('Hi {{LEAD_NAME}},');
    expect(out).toContain('Prices moved.');
    expect(out).not.toMatch(/<table|color:red/i);
  });
});
