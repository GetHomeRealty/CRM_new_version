import { CampaignsService, publicBaseUrlProblem } from './campaigns.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CAMPAIGN MAIL CARRIES A text/plain ALTERNATIVE.
 *
 * WHAT WAS WRONG. Every campaign message left as HTML-only. The mailer has supported a text part
 * for some time and personal lead mail has sent one for just as long — `lead-activity.service.ts`
 * passes `htmlToText(html)` and says in a comment why — but the campaign send simply never passed
 * it, and `sendFromAccount` did not even expose the option that `sendDirect` did.
 *
 * WHY IT MATTERS, STATED HONESTLY. Real correspondence is almost always multipart/alternative, so
 * HTML-only is one of the cheap signals separating machine-generated mail from typed mail. It also
 * leaves the message unreadable in a text client and weakens the preview line a mail app shows.
 * It is a structural correction to how the message is assembled. It promises nothing about which
 * Gmail tab anything lands in — that is decided per recipient and no sender controls it.
 *
 * WHAT THESE TESTS PIN is the part that could regress silently: that a text part is sent at all,
 * that it is derived from the SAME html actually delivered (so the two cannot disagree), and that
 * the unsubscribe link survives into it.
 */

const USER = { id: 3, name: 'Sender', role: 'agent' } as unknown as AuthUserRecord;

type Sent = { to: string[]; subject: string; html: string; text?: string | null; headers?: Record<string, string> };

function harness(html: string) {
  const sent: Sent[] = [];
  const emails = ['one@example.test'];
  const rows = emails.map((_, i) => ({ id: i + 1, retry_count: 0 }));
  const recipients = emails.map((email, i) => ({ id: i + 1, email, name: `R${i}`, lead_id: null }));

  const prisma = {
    campaigns: {
      update: async () => ({}),
      findUnique: async () => ({ id: 12, name: 'ZZ Market Update', created_by_id: 3 }),
      findFirst: async () => null,
    },
    campaign_recipients: { update: async () => ({}), updateMany: async () => ({ count: 1 }) },
    campaign_links: { createMany: async () => ({}), findMany: async () => [] },
    email_suppressions: { upsert: async () => ({}) },
    $executeRaw: async () => 1,
  } as unknown as PrismaService;

  // Records the whole message rather than just the address: the text part IS the assertion here.
  const mailer = {
    resolveSenderInArea: async () => ({ id: 1, from_email: 'crm@test.local' }),
    sendFromAccount: async (_a: unknown, o: Sent) => { sent.push(o); return { messageId: 'x' }; },
    sendDirect: async () => undefined,
  };

  const deliverability = { domainCanReceiveMail: async () => true } as never;

  /*
   * `injectTracking` appends the real unsubscribe footer, because one of the things worth proving
   * is that it reaches the text part. The other two are identity, so the html asserted on is the
   * template's.
   */
  const audience = {
    personalize: (text: string) => text,
    rewriteLinks: (h: string) => h,
    injectTracking: (h: string) => `${h}\n<div><a href="https://crm.test/api/campaigns/unsubscribe?c=12&t=tok0">Unsubscribe</a> from these emails.</div>`,
  } as never;

  const svc = new CampaignsService(
    prisma, audience, null as never, deliverability, mailer as never,
    undefined, undefined, undefined as never,
  );

  const job = {
    campaignId: 12,
    name: 'ZZ Market Update',
    recipients,
    rows,
    tokens: ['tok0'],
    template: { subject: 'ZZ Aug Market Update', content: html },
    agentVars: {},
    attachments: [],
    baseUrl: 'https://crm.test',
    userId: USER.id,
  };
  return { svc, sent, job };
}

async function runSend(h: ReturnType<typeof harness>) {
  const anySvc = h.svc as unknown as Record<string, unknown>;
  anySvc.claimRecipient = async () => true;
  await (anySvc.deliver as (j: unknown) => Promise<void>).call(h.svc, h.job);
}

describe('a campaign message is multipart', () => {
  it('SENDS A text/plain ALTERNATIVE, not HTML alone', async () => {
    const h = harness('<p>Hello there.</p><p>The market moved this month.</p>');
    await runSend(h);

    expect(h.sent).toHaveLength(1);
    const msg = h.sent[0];
    expect(typeof msg.text).toBe('string');
    expect(String(msg.text).trim()).not.toBe('');
    // Readable prose, with the markup gone.
    expect(msg.text).toContain('Hello there.');
    expect(msg.text).toContain('The market moved this month.');
    expect(msg.text).not.toContain('<p>');
  });

  it('DERIVES THE TEXT FROM THE HTML THAT IS ACTUALLY SENT', async () => {
    /*
     * The ordering that matters. The text is taken after personalisation, link rewriting and the
     * unsubscribe footer — so the two parts of the message say the same thing. A text part built
     * from the raw template would omit whatever those steps added, and a recipient reading the
     * text alternative would see a different email from the one that was sent.
     */
    const h = harness('<p>Hello there.</p>');
    await runSend(h);

    const msg = h.sent[0];
    expect(msg.html).toContain('Unsubscribe');
    // The footer the injector added reaches the text part too.
    expect(msg.text).toContain('Unsubscribe');
    expect(msg.text).toContain('https://crm.test/api/campaigns/unsubscribe');
  });

  it('keeps the List-Unsubscribe headers, which the text part does not replace', async () => {
    // One-Click is a header, not body content. Adding a text alternative must not disturb it.
    const h = harness('<p>Hello there.</p>');
    await runSend(h);

    const headers = h.sent[0].headers ?? {};
    expect(headers['List-Unsubscribe']).toContain('/api/campaigns/unsubscribe');
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('handles an image-only message without sending an empty text part', async () => {
    /*
     * An image-led template reduces to almost nothing as text. What must not happen is a blank
     * part: the mailer only attaches `text` when it is non-empty, so the message stays HTML-only
     * rather than becoming multipart with an empty half — which reads worse than either.
     */
    const h = harness('<p><img src="https://cdn.test/banner.png" alt="" /></p>');
    await runSend(h);

    const t = String(h.sent[0].text ?? '');
    // Whatever it contains, it must not claim to be content that is not there.
    expect(t).not.toContain('<img');
    expect(t).not.toContain('cdn.test/banner.png');
  });
});

describe('a campaign will not send without a working unsubscribe link', () => {
  /*
   * EVERY OPT-OUT ROUTE IS BUILT FROM THE BASE URL — the List-Unsubscribe header, the One-Click
   * POST target and the footer link. Without a usable one the mail still sends and still looks
   * fine, and the recipient has no way out of the list. That is a compliance failure that leaves
   * no trace, which is why this is a refusal rather than a warning.
   */

  const problems = [
    ['missing',        ''],
    ['whitespace',     '   '],
    ['not a url',      'crm.test'],
    ['plain http',     'http://crm.gethomerealty.ca'],
  ] as const;

  for (const [label, url] of problems) {
    it(`REFUSES TO SEND when the public address is ${label}, before any message goes`, async () => {
      const h = harness('<p>Hello.</p>');
      h.job.baseUrl = url;
      await expect(runSend(h)).rejects.toThrow(/cannot be sent/i);
      // Nothing left, not even the first recipient.
      expect(h.sent).toHaveLength(0);
    });
  }

  it('names the setting that fixes it, rather than failing vaguely', async () => {
    const h = harness('<p>Hello.</p>');
    h.job.baseUrl = '';
    await expect(runSend(h)).rejects.toThrow(/CAMPAIGN_PUBLIC_URL/);
  });

  it('ACCEPTS https, and accepts http only on localhost', () => {
    // https anywhere is the production case.
    expect(publicBaseUrlProblem('https://crm.gethomerealty.ca')).toBeNull();
    expect(publicBaseUrlProblem('https://crm.test')).toBeNull();
    // Development and this test suite run over http on localhost; refusing those would mean no
    // campaign could be exercised outside production.
    expect(publicBaseUrlProblem('http://localhost:5173')).toBeNull();
    expect(publicBaseUrlProblem('http://127.0.0.1:8000')).toBeNull();
    // But http to a real host is refused — a mail client may rewrite or block that link.
    expect(publicBaseUrlProblem('http://crm.gethomerealty.ca')).toMatch(/not https/i);
  });

  it('still sends normally when the address is valid', async () => {
    // The guard must not be the thing that stops ordinary campaigns.
    const h = harness('<p>Hello.</p>');
    await runSend(h);
    expect(h.sent).toHaveLength(1);
  });
});

describe('an image-only campaign still reads as something in plain text', () => {
  it('USES THE ALT TEXT, which is what the template author wrote for this', async () => {
    const h = harness('<p><img src="https://cdn.test/b.png" alt="October market update: prices up 3%" /></p>');
    await runSend(h);

    const text = String(h.sent[0].text ?? '');
    expect(text).toContain('October market update: prices up 3%');
    // And it is not merely an unsubscribe line with nothing above it.
    expect(text.replace(/Unsubscribe:.*$/s, '').trim()).not.toBe('');
  });

  it('joins several images, in order', async () => {
    const h = harness('<img src="a.png" alt="First point" /><img src="b.png" alt="Second point" />');
    await runSend(h);

    const text = String(h.sent[0].text ?? '');
    expect(text.indexOf('First point')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Second point')).toBeGreaterThan(text.indexOf('First point'));
  });

  it('FALLS BACK TO THE SUBJECT when the images carry no alt text', async () => {
    const h = harness('<p><img src="https://cdn.test/b.png" /></p>');
    await runSend(h);

    const text = String(h.sent[0].text ?? '');
    // The subject the harness sends is 'ZZ Aug Market Update'.
    expect(text).toContain('ZZ Aug Market Update');
    expect(text).toMatch(/made up of images/i);
  });

  it('leaves a template with real prose alone', async () => {
    // The fallback is reached only when the stripped HTML is empty. A message with words keeps
    // its words, and gains nothing it did not say.
    const h = harness('<p>Prices moved this month.</p><img src="a.png" alt="A chart" />');
    await runSend(h);

    const text = String(h.sent[0].text ?? '');
    expect(text).toContain('Prices moved this month.');
    expect(text).not.toMatch(/made up of images/i);
    expect(text).not.toContain('A chart');
  });

  it('the text part is never empty, whatever the template', async () => {
    for (const html of ['<p><img src="a.png" /></p>', '', '   ', '<div></div>']) {
      const h = harness(html);
      await runSend(h);
      expect(String(h.sent[0].text ?? '').trim()).not.toBe('');
    }
  });
});
