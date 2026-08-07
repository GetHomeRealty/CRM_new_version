import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  SOURCE_LABEL,
  type NotificationFeed,
  type NotificationFilter,
  type NotificationItem,
  type NotificationSource,
} from '../lib/notificationCenterApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';

/**
 * The Notification Centre.
 *
 * One list over the four systems that already produced notifications — agent changes, document
 * reviews, review decisions and scheduled reminders — with the history the bells never had. A bell
 * shows what is outstanding and then forgets it; this is where somebody goes to ask "what was I
 * told last week, and did I act on it?".
 *
 * WHY EACH ROW IS A DEAL RATHER THAN AN EVENT. Every one of the four sources groups its
 * notifications by transaction: six reviewed documents on one deal is one line, not six. That is
 * the existing behaviour of the bells, and splitting it here would have meant a different mental
 * model in two places for the same data.
 */
export default function NotificationCenterPage() {
  const toast = useToast();
  const navigate = useNavigate();

  const [feed, setFeed] = useState<NotificationFeed | null>(null);
  const [filter, setFilter] = useState<NotificationFilter>('unread');
  const [source, setSource] = useState<NotificationSource | ''>('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);

  const limit = 25;

  const load = useCallback(async () => {
    try {
      setFeed(await getNotifications({
        filter,
        source: source || undefined,
        search: search.trim() || undefined,
        limit,
        offset,
      }));
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not load your notifications'), 'bad');
    }
  }, [filter, source, search, offset, toast]);

  useEffect(() => { void load(); }, [load]);

  // Any change of view starts at the first page — staying on page 3 of a list that now has one page
  // shows an empty screen and reads as "nothing here".
  useEffect(() => { setOffset(0); }, [filter, source, search]);

  const open = async (item: NotificationItem) => {
    /*
     * Opening the record is what marks it read, matching what the bells already do ("opening the
     * deal is what marks its document notifications seen"). Doing it here as well would be a second
     * rule for the same thing; doing it INSTEAD of navigating would leave people clicking twice.
     */
    if (item.unread) {
      try {
        await markNotificationRead(item.source, item.transaction_id);
      } catch {
        // Navigation is the point; a failed mark corrects itself when the deal is opened.
      }
    }
    navigate(item.link);
  };

  const markOne = async (item: NotificationItem) => {
    setBusy(true);
    try {
      await markNotificationRead(item.source, item.transaction_id);
      await load();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not mark that read'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const markAll = async () => {
    setBusy(true);
    try {
      const { marked, failed } = await markAllNotificationsRead();
      // Reported honestly rather than as a flat success: a deal the person can no longer open
      // cannot be cleared, and silently saying "all read" while the badge stays lit is worse than
      // saying so.
      toast(
        failed
          ? `Marked ${marked} read. ${failed} could not be cleared — you may no longer have access to those deals.`
          : `Marked ${marked} notification${marked === 1 ? '' : 's'} read.`,
        failed ? 'bad' : 'ok',
      );
      await load();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not mark everything read'), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const pages = useMemo(() => {
    if (!feed) return { from: 0, to: 0, hasPrev: false, hasNext: false };
    const from = feed.total === 0 ? 0 : feed.offset + 1;
    const to = Math.min(feed.offset + feed.limit, feed.total);
    return { from, to, hasPrev: feed.offset > 0, hasNext: to < feed.total };
  }, [feed]);

  const when = (at: string | null): string => {
    if (!at) return '';
    const d = new Date(at.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
  };

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 className="lead-title">Notifications</h2>
            <div className="lead-subtitle">
              <span className="muted">
                Everything you have been told about your deals — document reviews, review decisions,
                agent changes and reminders, in one place.
              </span>
            </div>
          </div>
          <div className="toolbar-row">
            <button className="btn ghost" type="button" onClick={() => void load()}>↻ Refresh</button>
            <button
              className="btn primary"
              type="button"
              disabled={busy || !feed || feed.unread === 0}
              onClick={() => void markAll()}
            >
              {busy ? 'Working…' : 'Mark all as read'}
            </button>
          </div>
        </div>

        <div className="toolbar-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {(['unread', 'all', 'read'] as NotificationFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`btn ${filter === f ? 'primary' : 'ghost'} sm`}
              onClick={() => setFilter(f)}
            >
              {f === 'unread' ? 'Unread' : f === 'all' ? 'All' : 'History'}
              {f === 'unread' && feed && feed.unread > 0 ? ` (${feed.unread})` : ''}
            </button>
          ))}

          <select
            className="input sm"
            value={source}
            onChange={(e) => setSource(e.target.value as NotificationSource | '')}
            aria-label="Filter by kind"
          >
            <option value="">Every kind</option>
            {(Object.keys(SOURCE_LABEL) as NotificationSource[]).map((s) => (
              <option key={s} value={s}>{SOURCE_LABEL[s]}</option>
            ))}
          </select>

          <input
            className="input sm"
            type="search"
            placeholder="Search deal, address or message…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search notifications"
          />
        </div>
      </div>

      {!feed ? (
        <div className="card"><p className="help">Loading your notifications…</p></div>
      ) : feed.items.length === 0 ? (
        <div className="card">
          <p className="help">
            {filter === 'unread'
              ? 'Nothing unread. Anything you have already read is under History.'
              : search.trim()
                ? 'Nothing matches that search.'
                : 'Nothing here yet.'}
          </p>
        </div>
      ) : (
        <div className="card">
          <ul className="notif-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {feed.items.map((item) => (
              <li
                key={item.key}
                style={{
                  display: 'flex', gap: 12, alignItems: 'flex-start',
                  padding: '12px 4px', borderBottom: '1px solid var(--line, #eee)',
                }}
              >
                {/* An unread marker that does not rely on colour alone — the text below says so too. */}
                <span
                  aria-hidden="true"
                  style={{
                    width: 8, height: 8, borderRadius: '50%', marginTop: 6, flex: '0 0 auto',
                    background: item.unread ? 'var(--accent, #2563eb)' : 'transparent',
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>
                    <strong>{item.title}</strong>{' '}
                    <span className="pill">{SOURCE_LABEL[item.source]}</span>{' '}
                    {item.unread && <span className="pill warn">Unread</span>}
                  </div>
                  <div className="muted" style={{ marginTop: 2 }}>
                    {item.trade_no ? <strong>{item.trade_no}</strong> : null}
                    {item.trade_no && item.property ? ' · ' : null}
                    {item.property}
                  </div>
                  {item.summary && <div style={{ marginTop: 4 }}>{item.summary}</div>}
                  <div className="muted" style={{ marginTop: 4, fontSize: '0.85em' }}>{when(item.at)}</div>
                </div>
                <div className="acct-actions" style={{ flex: '0 0 auto' }}>
                  <button className="btn primary sm" type="button" onClick={() => void open(item)}>
                    Open deal
                  </button>
                  {item.unread && (
                    <button className="btn ghost sm" type="button" disabled={busy} onClick={() => void markOne(item)}>
                      Mark read
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <div className="toolbar-row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
            <span className="muted">
              {pages.from}–{pages.to} of {feed.total}
              {feed.unread > 0 ? ` · ${feed.unread} unread` : ''}
            </span>
            <span className="acct-actions">
              <button
                className="btn ghost sm"
                type="button"
                disabled={!pages.hasPrev}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                ← Newer
              </button>
              <button
                className="btn ghost sm"
                type="button"
                disabled={!pages.hasNext}
                onClick={() => setOffset(offset + limit)}
              >
                Older →
              </button>
            </span>
          </div>
        </div>
      )}
    </>
  );
}
