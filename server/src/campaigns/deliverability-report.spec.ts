import {
  analyseContent, checkDkim, checkDmarc, checkSpf, spamRisk,
} from './deliverability-report';

/**
 * The deliverability check, asserted against the records this brokerage actually publishes.
 *
 * WHY IT EXISTS. Campaigns were landing in Gmail's Promotions tab, and the investigation found
 * something the application had never reported: `gethomerealty.ca` publishes NO SPF record and NO
 * DKIM selector, with DMARC at `p=none` and no `rua`. That is a SPAM-folder risk rather than a tab
 * one, and finding it required a manual `nslookup`. These tests pin the check that now surfaces it.
 *
 * THE SEPARATION IS THE DESIGN. Authentication findings are objective — a record exists or it does
 * not — and they dominate the verdict. Content findings are advisory: Gmail's tab classification is
 * undocumented and decided per recipient, so nothing here may promise Primary placement, and the
 * tests below check that the weighting keeps a missing signing key above a busy layout.
 */

describe('SPF', () => {
  it('THE REAL CASE: reports absence, and names the record to publish', () => {
    // Exactly what gethomerealty.ca returns today — a verification token and nothing else.
    const r = checkSpf(['"D2521530"', '"zoho-verification=zb81685067.zmverify.zoho.com"']);
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/No SPF record/i);
    expect(r.fix).toContain('v=spf1');
  });

  it('accepts a soft fail, which is the ordinary Workspace recommendation', () => {
    expect(checkSpf(['v=spf1 include:_spf.google.com ~all']).status).toBe('pass');
  });

  it('accepts a hard fail', () => {
    expect(checkSpf(['v=spf1 include:_spf.google.com -all']).status).toBe('pass');
  });

  it('FAILS "+all", which authorises the whole internet to send as the domain', () => {
    // Worse than publishing nothing: it actively vouches for every sender alive.
    const r = checkSpf(['v=spf1 +all']);
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/authorises anyone/i);
  });

  it('warns on a neutral "?all", which asserts nothing', () => {
    expect(checkSpf(['v=spf1 include:_spf.google.com ?all']).status).toBe('warn');
  });

  it('ignores unrelated TXT records rather than mistaking one for SPF', () => {
    expect(checkSpf(['google-site-verification=abc', 'v=spf1 -all']).status).toBe('pass');
  });
});

describe('DKIM', () => {
  it('THE REAL CASE: reports that none of the selectors tried resolved', () => {
    const tried = ['google', 'default', 'selector1', 'k1'];
    const r = checkDkim([], tried);
    expect(r.status).toBe('fail');
    /*
     * Worded as "none of the selectors tried", never "DKIM is absent". Selectors cannot be
     * enumerated from DNS — only discovered from a signed message — so claiming proof of absence
     * would be claiming something the lookup cannot establish.
     */
    expect(r.detail).toMatch(/selectors tried/i);
    expect(r.fix).toMatch(/Google Workspace/i);
    expect(r.fix).toMatch(/OFF by default/i);
  });

  it('passes when a selector carries a real key', () => {
    const r = checkDkim([{ selector: 'google', record: 'v=DKIM1; k=rsa; p=MIIBIjAN' }], ['google']);
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('google._domainkey');
  });

  it('does not accept a TXT record that is not a DKIM key', () => {
    // Something answering at the name proves the name exists, not that signing is configured.
    expect(checkDkim([{ selector: 'google', record: 'some unrelated txt' }], ['google']).status).toBe('fail');
  });
});

describe('DMARC', () => {
  it('THE REAL CASE: "p=none" with no rua is a warning, not a pass', () => {
    const r = checkDmarc(['v=DMARC1; p=none;']);
    expect(r.status).toBe('warn');
    // It enforces nothing, and without `rua` the reports that would prove SPF/DKIM work go nowhere.
    expect(r.detail).toMatch(/enforces nothing/i);
    expect(r.detail).toMatch(/no reports are delivered/i);
    expect(r.fix).toMatch(/rua=/);
  });

  it('fails when nothing is published', () => {
    expect(checkDmarc([]).status).toBe('fail');
  });

  it('passes on an enforcing policy', () => {
    expect(checkDmarc(['v=DMARC1; p=quarantine; rua=mailto:d@example.test']).status).toBe('pass');
  });

  it('notes a missing rua even on an enforcing policy', () => {
    expect(checkDmarc(['v=DMARC1; p=reject']).detail).toMatch(/no reports/i);
  });
});

describe('content signals', () => {
  it('does not count our own tracking pixel against the author', () => {
    const html = '<p>Hi Ashu, a few listings that match what you asked for.</p>'
      + '<img src="https://x.test/api/campaigns/track/open?c=1&t=a" alt="" width="1" height="1" style="display:none;" />';
    // The pixel is the application's decision, not a content choice anyone made.
    expect(analyseContent(html).images).toBe(0);
  });

  it('flags an image-only message', () => {
    const r = analyseContent('<html><body><img src="https://x.test/banner.png" width="600"></body></html>');
    expect(r.imageOnly).toBe(true);
    expect(r.signals.join(' ')).toMatch(/image-only/i);
  });

  it('flags promotional phrasing', () => {
    const r = analyseContent('<p>ACT NOW — limited time offer, 20% off, click here!</p>');
    expect(r.signals.join(' ')).toMatch(/Promotional phrasing/i);
  });

  it('counts links and images', () => {
    const html = '<p>text</p><a href="#">1</a><a href="#">2</a><img src="a.png"><img src="b.png">';
    const r = analyseContent(html);
    expect(r.links).toBe(2);
    expect(r.images).toBe(2);
  });

  it('is quiet about a short personal message', () => {
    const html = '<p>Hi {{first_name}}, I wanted to share a couple of properties that match what you described. '
      + 'Let me know if either is worth a viewing and I will arrange it.</p>';
    const r = analyseContent(html);
    // The thing the brokerage was told to write. It should not be lectured at.
    expect(r.signals).toEqual([]);
    expect(r.imageOnly).toBe(false);
  });

  it('notices when nothing is personalised', () => {
    expect(analyseContent('<p>Check our latest offers on new builds this season across the region.</p>').signals.join(' '))
      .toMatch(/No personalisation/i);
  });
});

describe('the overall verdict', () => {
  const pass = { name: 'SPF' as const, status: 'pass' as const, detail: '' };
  const fail = { name: 'DKIM' as const, status: 'fail' as const, detail: '' };
  const warn = { name: 'DMARC' as const, status: 'warn' as const, detail: '' };
  const clean = { links: 1, images: 0, textRatio: 0.5, imageOnly: false, signals: [] as string[] };

  it('THE REAL CASE: no SPF and no DKIM is HIGH, whatever the content looks like', () => {
    expect(spamRisk([fail, { ...fail, name: 'SPF' }, warn], clean)).toBe('high');
  });

  it('one authentication failure outweighs a tidy message', () => {
    /*
     * The weighting that matters. A missing signing key risks the spam folder; a busy layout only
     * correlates with a tab. Letting content outrank authentication would point the reader at the
     * cosmetic problem and away from the real one.
     */
    expect(spamRisk([fail, pass, pass], clean)).toBe('medium');
  });

  it('is low when authentication is sound and the message is plain', () => {
    expect(spamRisk([pass, { ...pass, name: 'DKIM' }, { ...pass, name: 'DMARC' }], clean)).toBe('low');
  });

  it('raises a fully authenticated domain to medium on an image-only message', () => {
    const imageOnly = { ...clean, imageOnly: true, signals: ['image-only'] };
    expect(spamRisk([pass, { ...pass, name: 'DKIM' }, { ...pass, name: 'DMARC' }], imageOnly)).toBe('medium');
  });
});
