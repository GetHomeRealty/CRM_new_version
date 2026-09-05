import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAIL_EVENTS } from '../email/mail-event-registry';

/**
 * TD-094 — a deal is not enrolled in client review emails until somebody enrols it.
 *
 * WHAT WAS REPORTED. "Include this transaction in batch review emails" rendered TICKED on a
 * brand-new deal. The stored record is silent — `activity_tracker` carries no `batch_review_email`
 * key at all — and the panel supplied `true` for that silence, so the box showed the form's
 * assumption as though it were somebody's decision, and a no-touch save would have written it in
 * as one.
 *
 * THE QUESTION THE ENTRY SAYS MUST BE ANSWERED BEFORE A MAILBOX IS CONNECTED — does the batch read
 * this control's default for deals nobody has opened? — HAS AN ANSWER: there is no batch. The
 * `agent_faq.batch_review` template is registered and nothing sends it; no server code reads
 * `batch_review_email` except the normalisation on an agent's save, which uses `!!`. So the flag is
 * inert today and the exposure was latent: it would have arrived the day somebody built the sender.
 *
 * THESE TESTS KEEP IT THAT WAY. The first two pin the rule — silence means excluded, on both ends.
 * The third is a tripwire: it fails the moment a sender for that event appears, so whoever builds
 * the batch has to come here and state the inclusion rule deliberately rather than inherit it.
 */

const clientFile = (name: string): string =>
  readFileSync(join(__dirname, '..', '..', '..', 'client', 'src', 'desk', name), 'utf8');

describe('batch review emails are opt-in (TD-094)', () => {
  it('the panel treats a silent record as NOT included', () => {
    const source = clientFile('AgentFaqModal.tsx');
    expect(source).toContain('batch_review_email: !!a.batch_review_email');
    // The initialiser that manufactured consent from an absent key. Checked on the CODE lines only:
    // the comment above the fix quotes the old expression, and a whole-file search would match it.
    const initialisers = source
      .split(/\r?\n/)
      // The line that BUILDS the form value: not the interface's `batch_review_email: boolean;`,
      // and not the comment above the fix, which quotes the old expression verbatim.
      .filter((line) => /batch_review_email:\s*\S/.test(line)
        && !line.trimStart().startsWith('*')
        && !line.includes('boolean'));
    expect(initialisers).toHaveLength(1);
    expect(initialisers[0]).not.toContain('== null ? true');
  });

  it('the server normalises an absent flag to false when an agent saves', () => {
    // `transactions-write` rebuilds the tracker on an agent's save; `!!` is what makes a missing
    // key mean excluded there too, so the two ends cannot disagree about silence.
    const source = readFileSync(join(__dirname, 'transactions-write.service.ts'), 'utf8');
    expect(source).toContain('existing.batch_review_email = !!asObject(data.activity_tracker).batch_review_email');
  });

  it('nothing sends the batch review email yet — and this fails when something does', () => {
    /*
     * A TRIPWIRE, ON PURPOSE. The entry's own instruction is that this must be answered before a
     * mail account is configured. If a sender appears while the inclusion rule is still "whatever
     * the flag happens to say", every deal nobody has opened is a recipient. Whoever wires the
     * batch should replace this test with one that asserts the rule they chose.
     */
    expect(Object.keys(MAIL_EVENTS)).toContain('agent_faq.batch_review');

    const senders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!path.endsWith('.ts') || path.endsWith('.spec.ts')) continue;
        if (path.endsWith(join('email', 'mail-event-registry.ts'))) continue;
        if (readFileSync(path, 'utf8').includes('agent_faq.batch_review')) senders.push(path);
      }
    };
    walk(join(__dirname, '..'));

    expect(senders).toEqual([]);
  });
});
