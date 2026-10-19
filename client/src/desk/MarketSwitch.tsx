import { useState } from 'react';
import api from '../lib/axios';
import { useAuth } from '../context/AuthContext';
import type { Market } from '../types/auth';
import { useToast } from './toast';

/**
 * THE COUNTRY SWITCH IN THE TOP BAR (India desk, stage 2, 17 Oct 2026).
 *
 * Canada and India deals are kept apart (the server narrows every screen to one country). This is
 * where a person who works in both chooses which one they are in. It asks the server to remember
 * the choice for this sign-in, then reloads the page, so every screen - lists, dashboard, reports,
 * invoices, downloads - starts again in the chosen country rather than half of it being stale.
 *
 * Shown only where it means something:
 *   - Canada only (everyone today): nothing at all - the app looks exactly as it did.
 *   - India only: a fixed "India" label, so the person always knows where they are.
 *   - Both: the two-way switch.
 */
export const MARKET_NAME: Record<Market, string> = { CA: 'Canada', IN: 'India' };
/**
 * Drawn flags (19 Oct 2026). Flag emojis are not drawn on Windows - it shows the letters "CA" / "IN"
 * instead - so the flags are small pictures that look the same on every computer.
 */
function CanadaFlag() {
  return (
    <svg className="market-flag" viewBox="0 0 9600 4800" aria-hidden="true">
      <rect width="9600" height="4800" fill="#d52b1e" />
      <rect x="2400" width="4800" height="4800" fill="#fff" />
      <path fill="#d52b1e" d="m4890 4430-45-863a95 95 0 0 1 111-98l859 151-116-320a65 65 0 0 1 20-73l941-762-212-99a65 65 0 0 1-34-79l186-572-542 115a65 65 0 0 1-73-38l-105-247-423 454a65 65 0 0 1-111-57l204-1052-327 189a65 65 0 0 1-91-27l-332-652-332 652a65 65 0 0 1-91 27l-327-189 204 1052a65 65 0 0 1-111 57l-423-454-105 247a65 65 0 0 1-73 38l-542-115 186 572a65 65 0 0 1-34 79l-212 99 941 762a65 65 0 0 1 20 73l-116 320 859-151a95 95 0 0 1 111 98l-45 863z" />
    </svg>
  );
}

function IndiaFlag() {
  const spokes = Array.from({ length: 24 }, (_, i) => i * 15);
  return (
    <svg className="market-flag" viewBox="0 0 900 600" aria-hidden="true">
      <rect width="900" height="200" fill="#ff9933" />
      <rect y="200" width="900" height="200" fill="#fff" />
      <rect y="400" width="900" height="200" fill="#138808" />
      <g transform="translate(450 300)" stroke="#000080" fill="none">
        <circle r="88" strokeWidth="14" />
        {spokes.map((a) => <line key={a} x1="0" y1="0" x2="0" y2="-82" strokeWidth="6" transform={`rotate(${a})`} />)}
        <circle r="16" fill="#000080" stroke="none" />
      </g>
    </svg>
  );
}

export function Flag({ market }: { market: Market }) {
  return market === 'IN' ? <IndiaFlag /> : <CanadaFlag />;
}

export default function MarketSwitch() {
  const { user } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const markets = (user?.markets ?? ['CA']) as Market[];
  const current: Market = (user?.market ?? 'CA') as Market;

  if (markets.length === 1 && markets[0] === 'CA') return null;

  if (markets.length === 1) {
    return (
      <div className="market-switch single" title={`You work on ${MARKET_NAME[current]} deals only`}>
        <span className="market-option active"><Flag market={current} /> {MARKET_NAME[current]}</span>
      </div>
    );
  }

  const choose = async (m: Market) => {
    if (m === current || busy) return;
    setBusy(true);
    try {
      await api.post('/api/user/market', { market: m });
      // A full reload: every screen fetches again, in the new country. A page about ONE record
      // (/desk/transactions/812) is the other country's record, so it lands on that list instead.
      const path = window.location.pathname;
      const one = path.match(/^(.*?)\/\d+(?:\/|$)/);
      if (one) window.location.assign(one[1]);
      else window.location.reload();
    } catch {
      toast(`Could not switch to ${MARKET_NAME[m]}`, 'bad');
      setBusy(false);
    }
  };

  return (
    <div className="market-switch" role="group" aria-label="Country">
      {markets.map((m) => (
        <button
          key={m}
          type="button"
          className={`market-option ${m === current ? 'active' : ''} m-${m}`}
          aria-pressed={m === current}
          disabled={busy}
          title={m === current ? `You are working in ${MARKET_NAME[m]}` : `Switch to ${MARKET_NAME[m]} deals`}
          onClick={() => choose(m)}
        >
          <Flag market={m} /> {MARKET_NAME[m]}
        </button>
      ))}
    </div>
  );
}
