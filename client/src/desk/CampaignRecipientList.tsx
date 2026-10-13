import { useMemo, useState } from 'react';
import type { CampaignRecipientRow, CampaignStats } from '../types';

/**
 * Who a campaign went to, what happened to each of them, and a box to find one person.
 *
 * WHY IT IS A COMPONENT RATHER THAN MORE JSX. Two places need this list — the results modal, which
 * always had it, and the sent-email popup, which showed only a recipient count. Writing it twice
 * would mean two renderings of the same five delivery states, and the second copy would be the one
 * that stopped matching when a sixth arrived.
 *
 * THE SEARCH BOX IS THE POINT OF THIS SCREEN AT SCALE. A campaign to six hundred leads renders six
 * hundred rows, and the question somebody actually brings here is about ONE of them: "did Maria get
 * it?" — asked while Maria is on the telephone. Scrolling is not an answer. It searches name and
 * address together because the asker has one or the other, rarely both.
 *
 * NOTHING HERE FETCHES. Both callers already hold the campaign with its recipients, and a list that
 * went to the server on every keystroke would turn a local question into a slow one — and would be
 * a second, narrower definition of who may see these addresses than `CampaignsService.get`, which
 * has already answered it.
 */

type View = 'all' | 'sent' | 'failed' | 'opened' | 'unsubscribed' | 'bounced';

export default function CampaignRecipientList({
  recipients, stats, opensUnmeasured, unmeasuredNote, initialView = 'all', when,
}: {
  recipients: CampaignRecipientRow[];
  stats: CampaignStats;
  /** Whether open tracking is working. Labels the Opened figure as a minimum when it is not. */
  opensUnmeasured: boolean;
  /**
   * Why the figure is not a measurement, when the reason is not "tracking is broken".
   *
   * A Simple Email carries no open pixel by design, which is a different statement from a pixel
   * that failed - one is a choice and the other is a fault, and telling somebody their tracking is
   * broken when they turned it off would send them looking for a problem that does not exist.
   * Omitted keeps the original wording exactly.
   */
  unmeasuredNote?: string;
  initialView?: View;
  /** The page's own date formatter, passed in so both modals read times identically. */
  when: (v: string | null) => string;
}) {
  const [view, setView] = useState<View>(initialView);
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    const byView = view === 'sent' ? recipients.filter((x) => x.status === 'sent')
      /*
       * `failed` is every recipient who did not receive it — a bounce, a send error, or an opt-out
       * recorded after the campaign was built. It therefore OVERLAPS the Bounced filter below
       * rather than excluding it, which is also how the two counters relate: `stats.failed` counts
       * everyone not sent to, `stats.bounced` only the ones a mail server refused.
       */
      : view === 'failed' ? recipients.filter((x) => x.status === 'failed')
        : view === 'opened' ? recipients.filter((x) => x.opened)
          : view === 'unsubscribed' ? recipients.filter((x) => x.unsubscribed)
            : view === 'bounced' ? recipients.filter((x) => x.bounced || x.status === 'failed')
              : recipients;

    const q = query.trim().toLowerCase();
    if (!q) return byView;
    // Name and address in one pass: somebody searching "maria" and somebody searching
    // "maria@" are asking the same question and should not have to know which field holds it.
    return byView.filter((x) => `${x.name ?? ''} ${x.email}`.toLowerCase().includes(q));
  }, [recipients, view, query]);

  const tile = (key: View, value: number, label: string, cls: string, title?: string) => (
    <button type="button" className={`camp-tile ${cls}${view === key ? ' on' : ''}`}
      onClick={() => setView(key)} title={title} data-testid={`camp-tile-${key}`}>
      <strong>{value}</strong><span>{label}</span>
    </button>
  );

  return (
    <>
      <div className="camp-tiles">
        {tile('all', stats.total, 'Recipients', '')}
        {tile('sent', stats.sent, 'Sent', 'good', 'Accepted for delivery by the receiving mail server.')}
        {tile('failed', stats.failed, 'Failed', 'bad', 'Did not receive it — a bounce, a send error, or an opt-out recorded after the campaign was built.')}
        {tile('opened', stats.opened, opensUnmeasured ? 'Opened (not measured)' : 'Opened', opensUnmeasured ? '' : 'info')}
        {tile('bounced', stats.bounced, 'Bounced', 'bad', 'Refused by the receiving mail server.')}
        {tile('unsubscribed', stats.unsubscribed, 'Unsubscribed', 'warn')}
      </div>

      <div className="field" style={{ marginTop: 8, marginBottom: 0 }}>
        <input
          type="search"
          value={query}
          placeholder="Search this list by name or email"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search recipients by name or email"
          data-testid="recipient-search"
        />
      </div>

      <div className="camp-list" data-testid="recipient-list">
        {list.length === 0 ? (
          <div className="help" data-testid="recipient-empty">
            {/* The two empty states are different questions and must not share one answer. */}
            {query.trim()
              ? `No recipient here matches "${query.trim()}".`
              : 'No one in this group yet.'}
          </div>
        ) : list.map((x) => (
          <div key={x.id} className="camp-row">
            <div style={{ minWidth: 0 }}>
              <strong>{x.name || x.email}</strong>
              <div className="muted" style={{ fontSize: 12 }}>{x.email}</div>
              {x.error && <div style={{ color: 'var(--bad)', fontSize: 12 }}>{x.error}</div>}
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {x.opened && <span className="pill info">Opened</span>}
              {x.unsubscribed && <span className="pill warn">Unsub</span>}
              {/*
                The three failures read very differently and must not share one label.
                A hard bounce is a dead mailbox and the address is now suppressed; a soft
                one is queued for another attempt; "unknown" is our own mail server and
                says nothing about the recipient. Calling all three "Bounced" is what once
                made an expired SMTP password look like a dead list.
              */}
              {x.bounce_type === 'hard' ? <span className="pill bad" title="The mailbox does not exist. This address has been added to the suppression list.">Hard bounce</span>
                : x.bounce_type === 'soft' && x.status === 'pending' ? (
                  <span className="pill warn" title={x.next_retry_at ? `Next attempt ${when(x.next_retry_at)}` : 'Queued for another attempt'}>
                    Retrying{x.retry_count ? ` (${x.retry_count})` : ''}
                  </span>
                )
                  : x.bounce_type === 'soft' ? <span className="pill bad" title="The receiving server kept deferring us. The address is not suppressed.">Deferred — gave up</span>
                    : x.bounce_type === 'unknown' ? <span className="pill bad" title="A problem with our mail account or connection, not with this address.">Send error</span>
                      : (
                        <span className={`pill ${x.status === 'sent' ? 'ok' : ''}`}>
                          {x.status === 'sent' ? 'Sent' : x.status === 'failed' ? 'Failed' : 'Pending'}
                        </span>
                      )}
            </div>
          </div>
        ))}
      </div>

      {/* Said once, under the list, rather than on the tile — the figure is a minimum, not a result. */}
      {opensUnmeasured && (
        <div className="help" style={{ color: 'var(--warn-ink-alt)' }} data-testid="opens-unmeasured-note">
          {unmeasuredNote ?? (
            <>
              ⚠ Open tracking is not working, so the Opened figure counts only what happened to
              be recorded. Treat it as a minimum, not a result - and do not compare it with a
              campaign sent while tracking was working.
            </>
          )}
        </div>
      )}
    </>
  );
}
