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
const FLAG: Record<Market, string> = { CA: '\u{1F1E8}\u{1F1E6}', IN: '\u{1F1EE}\u{1F1F3}' };

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
        <span className="market-option active">{FLAG[current]} {MARKET_NAME[current]}</span>
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
          {FLAG[m]} {MARKET_NAME[m]}
        </button>
      ))}
    </div>
  );
}
