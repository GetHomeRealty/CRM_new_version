import {
  celebratedOn, classifyNonBounceFailure, emailLogKind, firstNameOf, isImplausibleDate, messageToHtml, occasionKey,
  recipientVars, renderCelebrationHtml, sanitiseAiGreeting, starterMessage, unknownTokens, windowDays, zonedDate,
  zonedTimeToUtc,
} from './celebration';
import { parseRecipientSpec } from './celebration-audience.service';
import { celebrationAiStatus } from './celebration-ai.service';
import { CelebrationFlyerService } from './celebration-flyer.service';

/** Celebration & Wishes — the rules that decide who, when, what and how failures are treated. */

describe('occasions', () => {
  it('counts birthdays, anniversaries and festivals once a year, but not general greetings', () => {
    expect(occasionKey('birthday')).toBe('birthday');
    expect(occasionKey('diwali')).toBe('diwali');
    expect(occasionKey('custom-festival', 'Mid-Autumn Festival')).toBe('festival:mid-autumn-festival');
    expect(occasionKey('general', 'Thank you')).toBeNull();
  });

  it('logs birthdays and anniversaries under the Settings sweep kinds, so the sweep skips them', () => {
    expect(emailLogKind('birthday')).toBe('birthday');
    expect(emailLogKind('anniversary')).toBe('anniversary');
    expect(emailLogKind('christmas')).toBe('campaign');
  });
});

describe('date matching — month and day only', () => {
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

  it('matches the month and day whatever the year', () => {
    expect(celebratedOn(d('1984-10-21'), '2026-10-21')).toBe(true);
    expect(celebratedOn(d('1984-10-22'), '2026-10-21')).toBe(false);
    expect(celebratedOn(null, '2026-10-21')).toBe(false);
  });

  it('applies the Feb 29 rule only in non-leap years', () => {
    const leapling = d('1992-02-29');
    expect(celebratedOn(leapling, '2028-02-29', 'feb28')).toBe(true);   // leap year: on the day
    expect(celebratedOn(leapling, '2027-02-28', 'feb28')).toBe(true);
    expect(celebratedOn(leapling, '2027-03-01', 'feb28')).toBe(false);
    expect(celebratedOn(leapling, '2027-03-01', 'mar1')).toBe(true);
    expect(celebratedOn(leapling, '2027-02-28', 'mar1')).toBe(false);
    expect(celebratedOn(leapling, '2027-02-28', 'skip')).toBe(false);
    expect(celebratedOn(leapling, '2027-03-01', 'skip')).toBe(false);
  });

  it('flags dates that cannot be right', () => {
    expect(isImplausibleDate(d('1850-01-01'))).toBe(true);
    expect(isImplausibleDate(d('2099-01-01'))).toBe(true);
    expect(isImplausibleDate(d('1990-06-15'))).toBe(false);
  });

  it('expands date windows', () => {
    expect(windowDays('today', '2026-10-21')).toEqual(['2026-10-21']);
    expect(windowDays('next7', '2026-12-29')).toEqual(['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04']);
    expect(windowDays('this_month', '2027-02-10')).toHaveLength(28);
    expect(windowDays('on_date', '2026-10-21', '2026-12-25')).toEqual(['2026-12-25']);
  });
});

describe('timezones', () => {
  it('turns a Toronto wall-clock time into the right instant on both sides of DST', () => {
    expect(zonedTimeToUtc('2026-07-01', '09:00', 'America/Toronto')?.toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedTimeToUtc('2026-12-01', '09:00', 'America/Toronto')?.toISOString()).toBe('2026-12-01T14:00:00.000Z');
    expect(zonedTimeToUtc('2026-12-01', '09:00', 'Asia/Kolkata')?.toISOString()).toBe('2026-12-01T03:30:00.000Z');
  });

  it('refuses a zone that does not exist', () => {
    expect(zonedTimeToUtc('2026-12-01', '09:00', 'Mars/Olympus')).toBeNull();
  });

  it('reads the local calendar day in the zone, not in UTC', () => {
    // 02:00 UTC on the 22nd is still the evening of the 21st in Toronto.
    expect(zonedDate(new Date('2026-10-22T02:00:00Z'), 'America/Toronto')).toBe('2026-10-21');
  });
});

describe('merge fields and fallbacks', () => {
  const b = { name: 'Get Home Realty', phone: '905-555-0100', email: 'info@example.test' };

  it('greets by first name, and falls back to "there"', () => {
    expect(recipientVars({ name: 'Priya Sharma' }, b).LEAD_FIRST_NAME).toBe('Priya');
    expect(recipientVars({ name: 'Priya Sharma', first_name: 'Pri' }, b).LEAD_FIRST_NAME).toBe('Pri');
    expect(recipientVars({ name: '' }, b).LEAD_FIRST_NAME).toBe('there');
    // A "name" that is an address or a phone number is not something to greet anyone by.
    expect(firstNameOf({ name: 'someone@example.com' })).toBe('');
    expect(firstNameOf({ name: '+1 416 555 0100' })).toBe('');
  });

  it('names merge fields it cannot fill', () => {
    expect(unknownTokens('Hi {{LEAD_FIRST_NAME}} {{PROPERTY_PRICE}}', '{{AGENT_NAME}}')).toEqual(['PROPERTY_PRICE']);
  });
});

describe('the email layout', () => {
  it('escapes the message, so typed or generated text cannot inject markup', () => {
    const html = messageToHtml('Hi <b>there</b>\n\n<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;there&lt;/b&gt;');
    expect((html.match(/<p /g) ?? []).length).toBe(2);
  });

  it('puts the greeting text above the image, gives the image alt text, and carries the preview text', () => {
    const html = renderCelebrationHtml({
      message: 'Hi {{LEAD_FIRST_NAME}},\n\nHappy Diwali!', previewText: 'Warm wishes',
      flyer: { alt: 'Lamps glowing', width: 1080, height: 1080 },
      signature: { name: 'Agent One', email: 'a@x.test', brokerage: 'Get Home Realty' },
    });
    expect(html.indexOf('Happy Diwali')).toBeLessThan(html.indexOf('cid:celebration-flyer'));
    expect(html).toContain('alt="Lamps glowing"');
    expect(html).toContain('max-width:544px');
    expect(html).toContain('Warm wishes');
    expect(html).toContain('{{LEAD_FIRST_NAME}}');
  });
});

describe('AI output is checked before the author sees it', () => {
  it('strips markup, links and unknown merge fields, and says so', () => {
    const raw = JSON.stringify({
      subject: 'Happy Diwali {{LEAD_FIRST_NAME}}', preview_text: 'Light and joy',
      message: 'Hi {{LEAD_FIRST_NAME}},\n\n<b>Wishing</b> you joy. Visit https://spam.example now. {{HOME_VALUE}}',
      flyer_headline: 'Happy Diwali', flyer_greeting: 'Joy to you',
    });
    const { draft, warnings } = sanitiseAiGreeting(`\`\`\`json\n${raw}\n\`\`\``, '');
    expect(draft.message).not.toMatch(/<b>|https?:|HOME_VALUE/);
    expect(draft.message).toContain('{{LEAD_FIRST_NAME}}');
    expect(warnings.join(' ')).toMatch(/link/i);
    expect(warnings.join(' ')).toMatch(/HOME_VALUE/);
  });

  it('warns when a greeting turns into a sales message, unless that was asked for', () => {
    const raw = JSON.stringify({ subject: 'Happy New Year', message: 'Ask me for a free home evaluation and our latest listings!' });
    expect(sanitiseAiGreeting(raw, '').warnings.join(' ')).toMatch(/property, prices or offers/);
    expect(sanitiseAiGreeting(raw, 'mention our new listings').warnings.join(' ')).not.toMatch(/property, prices or offers/);
  });

  it('refuses an answer that is not a usable greeting', () => {
    expect(() => sanitiseAiGreeting('not json at all', '')).toThrow(/usable greeting/);
    expect(() => sanitiseAiGreeting('{"subject":"x"}', '')).toThrow(/incomplete/);
  });

  it('explains exactly what to configure when AI is unavailable', () => {
    const saved = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY;
    delete process.env.AI_CAMPAIGN_DRAFTING;
    try {
      const s = celebrationAiStatus();
      expect(s.available).toBe(false);
      expect(s.reason).toMatch(/ANTHROPIC_API_KEY/);
      expect(s.reason).toMatch(/AI_CAMPAIGN_DRAFTING=on/);
      expect(s.reason).toMatch(/write the message yourself/);
    } finally {
      process.env = saved;
    }
  });

  it('offers a non-AI starting point for every kind of occasion', () => {
    expect(starterMessage('birthday', 'Birthday').subject).toMatch(/Birthday/);
    expect(starterMessage('diwali', 'Diwali').message).toMatch(/Diwali/);
    expect(starterMessage('general', 'Thank you').subject).toMatch(/Thank you/);
  });
});

describe('failures that are not bounces', () => {
  it('only treats a message as not sent when it certainly did not leave', () => {
    expect(classifyNonBounceFailure(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:25'), { code: 'ECONNREFUSED' }))).toBe('not_sent');
    expect(classifyNonBounceFailure(Object.assign(new Error('Invalid login: 535'), { responseCode: 535 }))).toBe('not_sent');
    expect(classifyNonBounceFailure(new Error('No active SMTP account is configured'))).toBe('not_sent');
    expect(classifyNonBounceFailure(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }))).toBe('unknown_outcome');
    expect(classifyNonBounceFailure(new Error('socket hang up'))).toBe('unknown_outcome');
  });
});

describe('recipient spec', () => {
  it('keeps one lead for "one lead" and drops junk', () => {
    const s = parseRecipientSpec({ mode: 'single', lead_ids: [5, 6, 'x', -1], filters: { date_window: 'whenever', feb29_rule: 'nope' } });
    expect(s.lead_ids).toEqual([5]);
    expect(s.filters.date_window).toBeUndefined();
    expect(s.filters.feb29_rule).toBe('feb28');
    expect(parseRecipientSpec({ mode: 'everyone' }).mode).toBe('all');
  });
});

describe('flyer template', () => {
  const svc = new CelebrationFlyerService({} as never);

  it('lays out the author’s words, escaped, in the chosen format', () => {
    const { svg, w, h } = svc.buildSvg({ occasion: 'diwali', headline: 'Happy <Diwali>', greeting: 'Joy & light', style: 'festive', format: 'landscape', alt_text: 'x' }, null);
    expect([w, h]).toEqual([1200, 630]);
    expect(svg).toContain('Happy &lt;Diwali&gt;');
    expect(svg).toContain('Joy &amp; light');
    expect(svg).toContain('GET HOME REALTY');
  });

  it('requires alt text and some words', async () => {
    await expect(svc.renderTemplate({ occasion: 'diwali', headline: 'Hi', greeting: '', style: 'festive', format: 'square', alt_text: '' }, { id: 1 } as never))
      .rejects.toThrow(/alt text/);
  });
});
