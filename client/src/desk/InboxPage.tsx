import { useArea } from './AreaContext';
import { crmPath } from './area';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listMyMailAccounts, markInboxSeen, type AccountMailAccount,
  listMailbox, getMailboxMessage, getComposePrefill, moveMailboxMessage,
  getMailboxDraft, downloadMailboxAttachment,
  type MailboxList, type MailboxMessage, type MailboxRow, type MailboxFolder,
} from '../lib/accountApi';
import MailComposer, { type ComposerInitial } from './MailComposer';
import MailBody from './MailBody';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';

/**
 * When a message arrived, in the reader's own timezone.
 *
 * This used to be `iso.replace('T', ' ').slice(0, 16)`, which took the UTC instant the server
 * sends, threw away the `Z` that said it was UTC, and printed the digits as if they were local.
 * In Toronto that is four or five hours adrift: mail received at 6pm showed as 22:00, and
 * anything after 8pm was dated the FOLLOWING DAY. The server already refuses to boot in
 * production without TZ set, for exactly this reason — the correction just never reached the
 * screen. Now the string is parsed as the instant it is and rendered in the viewer's locale.
 *
 * A malformed date is shown verbatim rather than as "Invalid Date", so a bad value looks like
 * the data problem it is instead of a broken page.
 */
const stamp = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

const FOLDERS: { key: MailboxFolder; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'sent', label: 'Sent' },
  { key: 'archive', label: 'Archive' },
  { key: 'trash', label: 'Trash' },
];

/**
 * The user's mailbox — read AND write.
 *
 * It was a read-only list of what the IMAP poller had pulled: no reply, no compose, no drafts, no
 * sent mail, no attachments, no archive and no search. All of those now exist, and every one of them
 * is a server call: the folders are query predicates, the search is a database query, the reply
 * recipients are worked out on the server from a message it has confirmed belongs to this user.
 *
 * NOTHING HERE IS A SECURITY CONTROL. The screen shows what the server returns; the scoping — this
 * user, this AREA's connected accounts — is enforced on every route. The CRM and Transaction Desk
 * mailboxes stay separate because `area` travels with each call, not because this component keeps
 * them apart.
 */
export default function InboxPage() {
  const { area, link } = useArea();
  const toast = useToast();
  const navigate = useNavigate();
  const [list, setList] = useState<MailboxList | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<MailboxMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [folder, setFolder] = useState<MailboxFolder>('inbox');
  /** The box the user is typing in; `search` is what has actually been asked for. */
  const [term, setTerm] = useState('');
  const [search, setSearch] = useState('');
  const [composing, setComposing] = useState<ComposerInitial | null>(null);
  /**
   * Whether this area has any mail account at all.
   *
   * `list.mailbox` cannot answer this — it is only the account marked PRIMARY, and is null both
   * when nothing is connected and when several are connected with none marked. Undefined while the
   * answer is still unknown, so the toggle is not flashed on screen and then withdrawn.
   */
  const [hasMailAccount, setHasMailAccount] = useState<boolean | undefined>(undefined);

  /*
   * WHICH MAILBOX IS ON SCREEN.
   *
   * `null` means "the default one", and that is deliberately not the same as an id: the server
   * resolves the default itself, so the unswitched Inbox asks for no account and cannot drift from
   * whatever Settings has marked as default. Picking an account sends its id and nothing else —
   * there is no option that merges mailboxes, which is the behaviour this replaced.
   */
  const [accounts, setAccounts] = useState<AccountMailAccount[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    try {
      setList(await listMailbox(area, { folder, page, q: search, unread: unreadOnly && folder === 'inbox', accountId }));
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not load your inbox'), 'bad');
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, [unreadOnly, page, folder, search, toast, area, accountId]);

  useEffect(() => { void load(); }, [load]);

  /*
   * Asked per area, because a mailbox connected under the CRM is not connected under the
   * Transaction Desk. A failure leaves the toggle hidden rather than showing a control that may do
   * nothing — the safer way round for a button whose whole purpose is filtering mail that is not
   * there.
   */
  useEffect(() => {
    let live = true;
    listMyMailAccounts(area === 'crm' ? 'crm' : 'desk')
      .then((accts) => {
        if (!live) return;
        setHasMailAccount(accts.length > 0);
        setAccounts(accts);
        // Switching area is switching mailboxes; carrying a CRM account id into the Desk would ask
        // for an account that area cannot see, which the server answers with an empty list.
        setAccountId(null);
      })
      .catch(() => { if (live) { setHasMailAccount(false); setAccounts([]); } });
    return () => { live = false; };
  }, [area]);

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
    /*
     * STILL THIRTY SECONDS, AND IT STAYS THAT WAY UNTIL THE STREAM IS PROVEN.
     *
     * The intention is that the SSE stream below becomes the primary route and this becomes a
     * fallback that can be lengthened. It is NOT lengthened yet: the stream does not currently
     * survive this application's global request-logging interceptor (see the note on the effect
     * below), so slowing this timer would trade a working thirty-second refresh for a broken push
     * and a two-minute one. The interval moves when the stream is measured working, not before.
     */
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

  /**
   * New mail, as it arrives.
   *
   * The server pushes a one-line event when a sync stores messages for one of THIS user's accounts;
   * the list is then refetched through the ordinary endpoint. The event carries no mail — only that
   * something arrived — so nothing here needs to be trusted beyond "ask again".
   *
   * `withCredentials`, because the stream is authenticated by the same session cookie as every other
   * request. Without it the browser opens the connection anonymously and the server closes it.
   *
   * NOT RECONNECTED BY HAND. `EventSource` retries on its own, with its own backoff, which is most
   * of why this is SSE and not a socket — a laptop that sleeps drops the connection constantly and
   * the reconnect is the part nobody wants to write twice.
   *
   * A refresh is skipped while the tab is hidden: the visibility handler above already refetches on
   * return, so waking a background tab to redraw a list nobody is looking at buys nothing.
   */
  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    const url = `${import.meta.env.VITE_API_URL ?? 'http://localhost:8000'}/api/account/inbox/stream`;
    let es: EventSource | null = null;
    try {
      es = new EventSource(url, { withCredentials: true });
    } catch {
      // A browser that refuses to open it keeps the polling fallback above and loses nothing else.
      return undefined;
    }
    const onInbox = () => { if (!document.hidden) void load(); };
    es.addEventListener('inbox', onInbox);
    return () => { es?.removeEventListener('inbox', onInbox); es?.close(); };
  }, [load]);

  const openMessage = async (row: MailboxRow) => {
    try {
      if (row.kind === 'received') {
        setOpen(await getMailboxMessage(area, row.id));
        // Reading marks it seen server-side; refresh the list so the unread state matches.
        if (!row.seen) void load();
        return;
      }
      // A draft or a failed send reopens in the composer rather than a reader — the point of
      // clicking it is to finish it.
      const d = await getMailboxDraft(area, row.id);
      setComposing({
        draft_id: d.id, to: d.to ?? '', cc: d.cc ?? '', bcc: d.bcc ?? '',
        subject: d.subject ?? '', body_html: d.body_html ?? '', attachments: d.attachments,
      });
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not open that message'), 'bad');
    }
  };

  const toggleSeen = async (row: MailboxRow) => {
    try { await markInboxSeen(area, row.id, !row.seen); void load(); }
    catch (ex) { toast(apiErrorMessage(ex, 'That did not work'), 'bad'); }
  };

  /** Archive, restore, trash or untrash — the server decides what each means. */
  const move = async (id: number, action: 'archive' | 'unarchive' | 'trash' | 'restore') => {
    try {
      await moveMailboxMessage(area, id, action);
      setOpen(null);
      void load();
    } catch (ex) { toast(apiErrorMessage(ex, 'That did not work'), 'bad'); }
  };

  /**
   * Open the composer prefilled for a reply, reply-all or forward.
   *
   * The prefill is fetched rather than assembled here: who a reply-all copies depends on the
   * original's recipients, and the server will only hand those back for a message it has confirmed
   * belongs to this user.
   */
  const respond = async (id: number, mode: 'reply' | 'reply_all' | 'forward') => {
    try {
      const p = await getComposePrefill(area, id, mode);
      setComposing({
        to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject,
        body_html: p.body_html, in_reply_to_id: p.in_reply_to_id, attachments: p.attachments,
      });
    } catch (ex) { toast(apiErrorMessage(ex, 'Could not start that message'), 'bad'); }
  };

  const runSearch = () => { setPage(1); setSearch(term); };

  if (loading) return <div className="card"><p className="help">Loading your inbox…</p></div>;

  const rows = list?.data ?? [];

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 className="lead-title">Inbox</h2>
            <div className="lead-subtitle">
              {/* Which mailbox this is. The list is one account's mail, so saying nothing would make a
                  shorter list read as lost mail rather than a narrower view. */}
              {list?.mailbox
                ? <span className="muted">
                    Mail for <strong>{list.mailbox.address}</strong> — the primary account for this area.
                    {list.mailbox.auto_sync ? ' Syncing automatically.' : ' Automatic sync is off for this account.'}
                  </span>
                : <span className="muted">Mail from every account connected to this area — mark one primary in Integrations to read just that mailbox.</span>}
              {list && list.unread > 0 && <span className="pill info">{list.unread} unread</span>}
            </div>
          </div>
          <div className="toolbar-row">
            {/*
              Only offered once a mailbox exists. With nothing connected there is no mail to filter,
              so the toggle switched an empty list for an empty list — and read as a broken control
              rather than an inapplicable one. `list.mailbox` is not the test: it names the PRIMARY
              account and is null both when nothing is connected and when several are with none
              marked, so it would have hidden the toggle from people who do have mail.
            */}
            {hasMailAccount && folder === 'inbox' && (
              <button className={`btn ghost${unreadOnly ? ' primary' : ''}`} type="button"
                onClick={() => { setUnreadOnly((v) => !v); setPage(1); }}>
                {unreadOnly ? 'Showing unread' : 'All mail'}
              </button>
            )}
            {/*
              THE ACCOUNT SWITCHER. Offered only with more than one mailbox — with a single account
              a selector that can only pick that account is noise.

              "Default mailbox" is a real choice, not a placeholder for "all": it asks the server to
              resolve whichever account Settings marks default, so the Inbox follows that setting
              instead of pinning an id that could later stop being the default. There is deliberately
              no "All accounts" option; merging mailboxes is the behaviour this replaced.
            */}
            {accounts.length > 1 && (
              <select value={accountId ?? ''} aria-label="Mailbox"
                onChange={(e) => { setAccountId(e.target.value ? Number(e.target.value) : null); setPage(1); }}>
                <option value="">Default mailbox</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.from_email}{a.is_default ? ' (default)' : ''}</option>
                ))}
              </select>
            )}
            {hasMailAccount && (
              <button className="btn primary" type="button" onClick={() => setComposing({})}>✉ New message</button>
            )}
            <button className="btn ghost" type="button" onClick={() => navigate(link('account'))}>⚙ Email accounts</button>
          </div>
        </div>

        {/* Folders and search. Both are server-side: the folder is a query predicate and the search
            is a database query, so neither depends on how much of the mailbox is on screen. */}
        <div className="toolbar-row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {FOLDERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`btn ghost sm${folder === f.key ? ' primary' : ''}`}
              onClick={() => { setFolder(f.key); setPage(1); setOpen(null); }}
            >
              {f.label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <input
            value={term}
            placeholder="Search sender, subject or text…"
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
            style={{ minWidth: 240 }}
          />
          <button className="btn sm" type="button" onClick={runSearch}>Search</button>
          {search !== '' && (
            <button className="btn ghost sm" type="button" onClick={() => { setTerm(''); setSearch(''); setPage(1); }}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="card">
        {rows.length === 0 ? (
          <div className="acct-empty">
            <p className="help">No mail here yet.</p>
            <p className="help">Connect an email account with IMAP under <a onClick={() => navigate(link('account'))} style={{ cursor: 'pointer', textDecoration: 'underline' }}>My Settings</a> and it will sync automatically.</p>
          </div>
        ) : (
          <ul className="inbox-list">
            {rows.map((m) => (
              <li key={`${m.kind}-${m.id}`} className={m.kind === 'received' && !m.seen ? 'unread' : ''} onClick={() => void openMessage(m)}>
                <div className="inbox-from">
                  {m.kind === 'received' && !m.seen && <span className="inbox-dot" aria-label="Unread" />}
                  <strong>
                    {/* A received message is FROM somebody; a draft or a sent one is TO somebody. */}
                    {m.kind === 'received' ? (m.from_name || m.from_email || 'Unknown sender') : (m.to_email || '(no recipient)')}
                  </strong>
                  {m.has_attachments && <span className="pill info" title="Has attachments">📎</span>}
                  {m.status === 'failed' && <span className="pill bad" title={m.error ?? 'Not sent'}>Not sent</span>}
                </div>
                <div className="inbox-body">
                  <div className="inbox-subject">{m.subject || '(no subject)'}</div>
                  <div className="muted inbox-snippet">{m.snippet}</div>
                </div>
                <div className="inbox-meta">
                  <span className="muted">{m.date ? stamp(m.date) : ''}</span>
                  {m.kind === 'received' && (
                    <>
                      <button className="btn ghost sm" type="button" onClick={(e) => { e.stopPropagation(); void toggleSeen(m); }}>
                        {m.seen ? 'Mark unread' : 'Mark read'}
                      </button>
                      {folder === 'inbox' && (
                        <button className="btn ghost sm" type="button" onClick={(e) => { e.stopPropagation(); void move(m.id, 'archive'); }}>Archive</button>
                      )}
                      {folder === 'archive' && (
                        <button className="btn ghost sm" type="button" onClick={(e) => { e.stopPropagation(); void move(m.id, 'unarchive'); }}>Move to Inbox</button>
                      )}
                      {folder === 'trash'
                        ? <button className="btn ghost sm" type="button" onClick={(e) => { e.stopPropagation(); void move(m.id, 'restore'); }}>Restore</button>
                        : <button className="btn ghost sm" type="button" onClick={(e) => { e.stopPropagation(); void move(m.id, 'trash'); }}>Delete</button>}
                    </>
                  )}
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
              <div className="muted">{open.date ? stamp(open.date) : ''}{open.to_email ? ` · to ${open.to_email}` : ''}</div>
              {open.lead_id && (
                <button className="btn ghost sm" type="button" onClick={() => navigate(crmPath(`lead/${open.lead_id}`))}>
                  Open lead: {open.lead_name}
                </button>
              )}
              <div className="toolbar-row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                <button className="btn sm" type="button" onClick={() => void respond(open.id, 'reply')}>Reply</button>
                <button className="btn ghost sm" type="button" onClick={() => void respond(open.id, 'reply_all')}>Reply all</button>
                <button className="btn ghost sm" type="button" onClick={() => void respond(open.id, 'forward')}>Forward</button>
                {open.archived
                  ? <button className="btn ghost sm" type="button" onClick={() => void move(open.id, 'unarchive')}>Move to Inbox</button>
                  : <button className="btn ghost sm" type="button" onClick={() => void move(open.id, 'archive')}>Archive</button>}
                {open.deleted
                  ? <button className="btn ghost sm" type="button" onClick={() => void move(open.id, 'restore')}>Restore</button>
                  : <button className="btn ghost sm" type="button" onClick={() => void move(open.id, 'trash')}>Delete</button>}
              </div>
              {(open.attachments ?? []).length > 0 && (
                <div className="toolbar-row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {(open.attachments ?? []).map((a) => (
                    <button key={a.id} className="btn ghost sm" type="button"
                      onClick={() => void downloadMailboxAttachment(area, 'received', a.id, a.filename)}>
                      📎 {a.filename}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="inbox-open-body">
              {open.body_html
                /*
                 * Rendered, not flattened. The concern the old code was answering — a stranger's
                 * HTML must not run in our origin — is real, and `MailBody` answers it with a
                 * sandboxed frame that grants neither scripts nor same-origin access instead of by
                 * deleting the markup. Flattening cost every image in every message and turned
                 * every link into a bare URL.
                 */
                ? <MailBody area={area} message={open} />
                : <pre className="inbox-plain">{open.body_text || '(empty message)'}</pre>}
            </div>
          </div>
        </div>
      )}

      {composing && (
        <MailComposer
          area={area}
          initial={composing}
          onClose={() => setComposing(null)}
          onDone={() => void load()}
        />
      )}
    </>
  );
}
