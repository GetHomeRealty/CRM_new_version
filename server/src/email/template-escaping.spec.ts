import { renderTemplate, MAIL_EVENTS } from './mail-event-registry';

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

describe('the four markup variables are NOT escaped', () => {
  /*
   * These carry HTML by design and would render as visible angle brackets if escaped — the logo
   * would vanish, the document table would print as source. Each is built by application code, not
   * by a user.
   */
  const cases: [string, string][] = [
    ['logo_img', '<img src="/api/company-settings/logo?v=1" alt="Get Home Realty" width="132">'],
    ['documents_table', '<tr><td>Form 630</td><td>Valid</td></tr>'],
    ['pending_docs', '<ul><li>Form 630</li><li>FINTRAC ID</li></ul>'],
    ['transaction_button', '<p style="margin:18px 0"><a href="https://x/t/1">Open the transaction</a></p>'],
  ];

  it.each(cases)('%s passes through intact', (key, html) => {
    expect(renderTemplate(`{{ ${key} }}`, { [key]: html })).toBe(html);
  });

  it('the allow-list is exactly these four and no more', () => {
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
    expect(passthrough.sort()).toEqual(
      ['documents_table', 'logo_img', 'pending_docs', 'transaction_button'],
    );
  });
});
