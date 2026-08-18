import { renderTemplate, MAIL_EVENTS } from './mail-event-registry';
import { escapeHtml } from '../users/user-onboarding.service';

/**
 * S-M9 / CRM-LEADS-M01 — merge values are HTML-escaped, except the four that ARE markup.
 *
 * The escaping half and the opt-out half are equally load-bearing, and a test for only the first
 * would let someone "fix" a rendering bug by adding a variable to the allow-list. Both directions
 * are asserted here.
 */

describe('merge values are escaped', () => {
  const tpl = '<p>Regards,<br>{{ company_name }}</p>';

  it('escapes a bare ampersand — the case already shipping', () => {
    /*
     * Not hypothetical. The company email this application ships with is
     * "info@GetHomeRealty.ca & Commissionpayouts@gethomerealty.ca", and that `&` was being emitted
     * into HTML mail as an unterminated entity on every send.
     */
    expect(renderTemplate('<p>{{ company_email }}</p>', {
      company_email: 'info@GetHomeRealty.ca & Commissionpayouts@gethomerealty.ca',
    })).toBe('<p>info@GetHomeRealty.ca &amp; Commissionpayouts@gethomerealty.ca</p>');
  });

  it('escapes a brokerage name containing an ampersand', () => {
    expect(renderTemplate(tpl, { company_name: 'Smith & Jones Realty' }))
      .toBe('<p>Regards,<br>Smith &amp; Jones Realty</p>');
  });

  it.each([
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    ['" onmouseover="alert(1)', '&quot; onmouseover=&quot;alert(1)'],
    ["O'Brien Realty", 'O&#39;Brien Realty'],
  ])('neutralises %s', (input, expected) => {
    expect(renderTemplate(tpl, { company_name: input })).toBe(`<p>Regards,<br>${expected}</p>`);
  });

  it('escapes a LEAD name, which the API accepts verbatim', () => {
    // `POST /api/leads` stores `<script>…` as the name — measured in the Leads audit. A lead name
    // is merge data, so this is where that stops mattering.
    expect(renderTemplate('<p>Dear {{ customer_name }},</p>', { customer_name: '<script>x</script>' }))
      .toBe('<p>Dear &lt;script&gt;x&lt;/script&gt;,</p>');
  });

  it('leaves ordinary text alone', () => {
    expect(renderTemplate(tpl, { company_name: 'Get Home Realty' })).toBe('<p>Regards,<br>Get Home Realty</p>');
  });

  it('still drops unknown, null and undefined tokens', () => {
    expect(renderTemplate('[{{ nope }}][{{ a }}][{{ b }}]', { a: null, b: undefined })).toBe('[][][]');
  });
});

describe('the markup variables are NOT escaped, and each one has earned it', () => {
  /*
   * These carry HTML by design and would render as visible angle brackets if escaped — the logo
   * would vanish, the document table would print as source, the agreement's Commission Structure
   * would arrive as `&lt;li&gt;Flat 95-05% split…`.
   *
   * THE LIST GREW FROM FOUR TO NINE when the agent contract agreement was added. That is a security
   * decision per entry, not a formatting one, so each addition was traced to its builder before this
   * test was changed — the alternative, widening the expectation to make a red test green, is how an
   * allow-list stops meaning anything. What was checked, in `user-onboarding.service.ts`:
   *
   *   training_banner   fixed markup plus base64 read off disk; the `alt` is a literal and the mime
   *                     comes from a fixed map keyed by a fixed extension list. No input reaches it.
   *   commission_terms  interpolates ONLY numbers — every value passes `pct()` (which returns ''
   *                     unless `Number.isFinite` and > 0) or `Math.floor(Number(...))`. No free text
   *                     from the profile reaches the markup.
   *   agent_address     typed text, but `escapeHtml`d by the builder before the ruled blank is put
   *   company_address   around it, and landing in TEXT CONTENT ("residing at {{ agent_address }}"),
   *   agent_type        not in an attribute. The past-brokerage name inside `agent_type` is escaped
   *                     the same way.
   *
   * The three that carry typed text are only safe because of that builder-side escaping, so it is
   * asserted directly below rather than left as a claim in a comment.
   */
  const cases: [string, string][] = [
    ['logo_img', '<img src="/api/company-settings/logo?v=1" alt="Get Home Realty" width="132">'],
    ['training_banner', '<img src="data:image/jpeg;base64,AAA" alt="Onboard Trainings" width="420">'],
    ['commission_terms', '<li>Flat 95-05% split on all transactions;</li>'],
    ['agent_address', '<span style="color:#9ca3af">____________________________</span>'],
    ['company_address', '<span style="color:#9ca3af">____________________________</span>'],
    ['agent_type', 'Experienced Agent [Past Brokerage Name: Smith &amp; Jones]'],
    ['documents_table', '<tr><td>Form 630</td><td>Valid</td></tr>'],
    ['pending_docs', '<ul><li>Form 630</li><li>FINTRAC ID</li></ul>'],
    ['transaction_button', '<p style="margin:18px 0"><a href="https://x/t/1">Open the transaction</a></p>'],
  ];

  it.each(cases)('%s passes through intact', (key, html) => {
    expect(renderTemplate(`{{ ${key} }}`, { [key]: html })).toBe(html);
  });

  it('the allow-list is exactly these nine and no more', () => {
    /*
     * A guard on the list itself. Adding a variable here is a security decision — whatever builds it
     * becomes responsible for producing safe HTML — so growing the list should require changing this
     * test deliberately rather than happening as a side effect of fixing a rendering complaint.
     */
    const escapedProbe = '<b>x</b>';
    const declared = new Set<string>();
    for (const event of Object.values(MAIL_EVENTS)) {
      for (const v of event.variables) declared.add(v);
    }
    const passthrough = [...declared].filter(
      (v) => renderTemplate(`{{ ${v} }}`, { [v]: escapedProbe }) === escapedProbe,
    );
    expect(passthrough.sort()).toEqual([
      'agent_address', 'agent_type', 'commission_terms', 'company_address',
      'documents_table', 'logo_img', 'pending_docs', 'training_banner', 'transaction_button',
    ]);
  });
});

describe('the builder escapes what the renderer no longer will', () => {
  /*
   * `agent_address`, `company_address` and `agent_type` are on the allow-list, so `renderTemplate`
   * hands their value through untouched. Everything that keeps an agent's typed address from
   * carrying markup into an email — and into the signed PDF generated from that email — is this one
   * function. It is asserted here, beside the allow-list it justifies, so the two can never drift.
   */
  it.each([
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    ['12 King St W & Co', '12 King St W &amp; Co'],
    ['" onmouseover="alert(1)', '&quot; onmouseover=&quot;alert(1)'],
  ])('neutralises %s', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it("escapes the apostrophe too, though today's templates place these in text content", () => {
    /*
     * Defence against a change nobody would think of as a security change. These three land in text
     * content — `residing at {{ agent_address }}` — where an apostrophe is harmless. But templates
     * are edited in Settings → Templates by people with no reason to know that, and the day one
     * moves inside a single-quoted attribute, `x' onmouseover='…` becomes an injection.
     */
    expect(escapeHtml("O'Brien & Sons")).toBe('O&#39;Brien &amp; Sons');
  });

  it('leaves an ordinary address alone', () => {
    expect(escapeHtml('120 Eglinton Ave E, Suite 500, Toronto ON')).toBe('120 Eglinton Ave E, Suite 500, Toronto ON');
  });
});
