import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getInboxMessage, listInbox, markInboxSeen,
  type InboxList, type InboxMessage, type InboxMessageRow,
} from '../lib/accountApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';

const stamp = (iso: string): string => iso.replace('T', ' ').slice(0, 16);

/**
 * The user's inbox — mail pulled from their connected accounts over IMAP. Everything is scoped to
 * the signed-in user by the server. Sync itself is configured and triggered under My Settings;
 * this screen reads what has already been pulled.
 */
export default function InboxPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [list, setList] = useState<InboxList | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<InboxMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    try {
      setList(await listInbox({ unread: unreadOnly, page }));
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not load your inbox'), 'bad');
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, [unreadOnly, page, toast]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Keep the list fresh on its own. The server polls the mailboxes in the background, but this
   * page used to fetch once and never again — so mail could arrive, be stored, and still not
   * show until the user navigated away and back. Refreshing here is what makes new mail
   * actually appear without pressing anything.
   *
   * Paused while the tab is hidden (no point polling a page nobody is looking at) and resumed
   * with an immediate fetch when it comes back, so returning to the tab shows current mail
   * rather than a stale list waiting for the next tick.
   */
  useEffect(() => {
    const REFRESH_MS = 30_000;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => {
      if (document.hidden) stop();
      else { void load(); start(); }
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [load]);

  const openMessage = async (row: InboxMessageRow) => {
    try {
      setOpen(await getInboxMessage(row.id));
      // Reading marks it seen server-side; refresh the list so the unread state matches.
      if (!row.seen) void load();
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not open that message'), 'bad');
    }
  };

  const toggleSeen = async (row: InboxMessageRow) => {
    try { await markInboxSeen(row.id, !row.seen); void load(); }
    catch (ex) { toast(apiErrorMessage(ex, 'That did not work'), 'bad'); }
  };

  if (loading) return <div className="card"><p className="help">Loading your inbox…</p></div>;

  const rows = list?.data ?? [];

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 className="lead-title">Inbox</h2>
            <div className="lead-subtitle">
              <span className="muted">Mail pulled from your connected accounts.</span>
              {list && list.unread > 0 && <span className="pill info">{list.unread} unread</span>}
            </div>
          </div>
          <div className="toolbar-row">
            <button className={`btn ghost${unreadOnly ? ' primary' : ''}`} type="button"
              onClick={() => { setUnreadOnly((v) => !v); setPage(1); }}>
              {unreadOnly ? 'Showing unread' : 'All mail'}
            </button>
            <button className="btn ghost" type="button" onClick={() => navigate('/app/account')}>⚙ Email accounts</button>
          </div>
        </div>
      </div>

      <div className="card">
        {rows.length === 0 ? (
          <div className="acct-empty">
            <p className="help">No mail here yet.</p>
            <p className="help">Connect an email account with IMAP under <a onClick={() => navigate('/app/account')} style={{ cursor: 'pointer', textDecoration: 'underline' }}>My Settings</a> and it will sync automatically.</p>
          </div>
        ) : (
          <ul className="inbox-list">
            {rows.map((m) => (
              <li key={m.id} className={m.seen ? '' : 'unread'} onClick={() => void openMessage(m)}>
                <div className="inbox-from">
                  {!m.seen && <span className="inbox-dot" aria-label="Unread" />}
                  <strong>{m.from_name || m.from_email || 'Unknown sender'}</strong>
                  {m.lead_name && <span className="pill type-res-buy" title="Matched to a lead">{m.lead_name}</span>}
                </div>
                <div className="inbox-body">
                  <div className="inbox-subject">{m.subject || '(no subject)'}</div>
                  <div className="muted inbox-snippet">{m.snippet}</div>
                </div>
                <div className="inbox-meta">
                  <span className="muted">{stamp(m.received_at)}</span>
                  <button className="btn ghost sm" type="button" onClick={(e) => { e.stopPropagation(); void toggleSeen(m); }}>
                    {m.seen ? 'Mark unread' : 'Mark read'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {list && list.meta.last_page > 1 && (
          <div className="lead-pager">
            <span className="muted">Page {list.meta.page} of {list.meta.last_page} · {list.meta.total} messages</span>
            <div className="toolbar-row">
              <button className="btn ghost sm" type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <button className="btn ghost sm" type="button" disabled={page >= list.meta.last_page} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        )}
      </div>

      {open && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(null); }}>
          <div className="modal lg">
            <button className="close" type="button" onClick={() => setOpen(null)} aria-label="Close">✕</button>
            <div className="modal-h">{open.subject || '(no subject)'}</div>
            <div className="inbox-open-meta">
              <div><strong>{open.from_name || open.from_email}</strong>{open.from_name && open.from_email ? <span className="muted"> · {open.from_email}</span> : null}</div>
              <div className="muted">{stamp(open.received_at)}{open.to_email ? ` · to ${open.to_email}` : ''}</div>
              {open.lead_id && (
                <button className="btn ghost sm" type="button" onClick={() => navigate(`/app/lead/${open.lead_id}`)}>
                  Open lead: {open.lead_name}
                </button>
              )}
            </div>
            <div className="inbox-open-body">
              {open.body_html
                // The body is rendered as plain text on purpose: showing a stranger's raw HTML
                // email in our own origin would run whatever markup and script it contained.
                ? <pre className="inbox-plain">{open.body_text || stripHtml(open.body_html)}</pre>
                : <pre className="inbox-plain">{open.body_text || '(empty message)'}</pre>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Last-resort readable text when a message only carried HTML — tags removed, never rendered. */
const stripHtml = (html: string): string =>
  html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
