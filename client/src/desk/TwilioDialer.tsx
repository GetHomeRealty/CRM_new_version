import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Device, Call } from '@twilio/voice-sdk';   // types only — erased at build time
import { loadTwilioVoice } from './heavyLibs';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { voiceToken, startBrowserCall } from '../lib/leadsApi';

type Phase = 'loading' | 'ready' | 'connecting' | 'in-call' | 'ended' | 'error';

/**
 * In-browser Twilio dialer — talk to the lead through the computer's mic/speakers (WebRTC), the
 * same experience as the standalone "Twilio Voice App". Fetches a Voice access token, registers a
 * Device, then places the call; the server's TwiML bridges to the lead and records it.
 */
export default function TwilioDialer({ lead, onClose, onLogged }: {
  lead: { id: number; name: string; phone: string | null };
  onClose: () => void;
  onLogged: () => void;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [retryKey, setRetryKey] = useState(0);

  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loggedRef = useRef(false);

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { callRef.current?.disconnect(); } catch { /* already gone */ }
    try { deviceRef.current?.destroy(); } catch { /* already gone */ }
    callRef.current = null;
    deviceRef.current = null;
  }, []);

  // Build the Device once the modal opens. Mic permission is requested up front so its own
  // failure is reported clearly rather than surfacing as an opaque call error later.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('This browser blocks microphone access here. Open the app at http://localhost:5173 (a secure context), not an IP address.');
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop()); // we only needed the permission
        } catch (micErr) {
          const name = (micErr as { name?: string })?.name;
          throw new Error(
            name === 'NotAllowedError' || name === 'SecurityError'
              ? 'Microphone blocked. Click the microphone / lock icon in the address bar → Allow, then Retry.'
              : name === 'NotFoundError' || name === 'DevicesNotFoundError'
                ? 'No microphone was found on this device.'
                : name === 'NotReadableError'
                  ? 'The microphone is in use by another app. Close it and Retry.'
                  : `Could not access the microphone (${name || (micErr as Error)?.message || 'unknown'}).`,
          );
        }
        const { token } = await voiceToken();
        if (cancelled) return;
        // The Voice SDK (~43 kB gzipped) is fetched only when the dialer is actually opened —
        // it is already behind a mic-permission prompt and a token request, so one more await
        // costs nothing perceptible. See heavyLibs.
        const { Device } = await loadTwilioVoice();
        if (cancelled) return;
        const device = new Device(token, { logLevel: 'error' });
        device.on('error', (e: { message?: string; code?: number }) => {
          setError(`${e?.message || 'Voice device error'}${e?.code ? ` (code ${e.code})` : ''}`);
          setPhase('error');
        });
        deviceRef.current = device;
        setPhase('ready');
      } catch (ex) {
        if (!cancelled) {
          // Surface the real reason: axios errors carry a server message; plain Errors (mic, SDK)
          // carry their own. The generic fallback only shows when neither yields anything.
          const server = apiErrorMessage(ex, '');
          setError(server || (ex instanceof Error ? ex.message : String(ex)) || 'In-browser calling could not start');
          setPhase('error');
        }
      }
    })();
    return () => { cancelled = true; cleanup(); };
  }, [cleanup, retryKey]);

  const startTimer = () => {
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  };

  const dial = async () => {
    const device = deviceRef.current;
    if (!device || phase === 'connecting' || phase === 'in-call') return;
    setPhase('connecting');
    setError(null);
    try {
      const { callId, to } = await startBrowserCall(lead.id);
      const call = await device.connect({ params: { To: to, CallId: String(callId) } });
      callRef.current = call;
      call.on('accept', () => { setPhase('in-call'); startTimer(); });
      call.on('disconnect', () => { if (!loggedRef.current) { loggedRef.current = true; onLogged(); } if (timerRef.current) clearInterval(timerRef.current); setPhase('ended'); });
      call.on('cancel', () => { setPhase('ended'); });
      call.on('error', (e: { message?: string }) => { setError(e?.message || 'Call error'); setPhase('error'); });
    } catch (ex) {
      setError(apiErrorMessage(ex, 'Could not place the call'));
      setPhase('error');
      toast('Could not place the call', 'bad');
    }
  };

  const hangup = () => { try { callRef.current?.disconnect(); } catch { /* ignore */ } };
  const toggleMute = () => {
    const call = callRef.current;
    if (!call) return;
    const next = !muted;
    call.mute(next);
    setMuted(next);
  };

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const status = phase === 'loading' ? 'Initializing…'
    : phase === 'ready' ? 'Ready to call'
    : phase === 'connecting' ? 'Connecting…'
    : phase === 'in-call' ? `In call · ${mmss}`
    : phase === 'ended' ? 'Call ended'
    : 'Error';

  return createPortal((
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 4000 }}>
      <div className="modal" style={{ maxWidth: 420, margin: 0, background: '#0f172a', color: '#e2e8f0', textAlign: 'center' }}>
        <button className="close" style={{ color: '#94a3b8' }} onClick={onClose}>✕</button>
        <div style={{ padding: '8px 8px 4px' }}>
          <div style={{ width: 60, height: 60, borderRadius: '50%', background: phase === 'in-call' ? '#16a34a' : '#dc2626', display: 'grid', placeItems: 'center', margin: '6px auto 12px', fontSize: 26 }}>📞</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Call {lead.name}</div>
          <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>{lead.phone || 'No number'}</div>
          <div style={{ fontSize: 13, marginTop: 10, color: phase === 'error' ? '#f87171' : phase === 'in-call' ? '#4ade80' : '#cbd5e1', fontWeight: 600 }}>{status}</div>

          {error && (
            <div style={{ background: 'rgba(220,38,38,.15)', border: '1px solid rgba(248,113,113,.4)', color: '#fca5a5', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, marginTop: 12, textAlign: 'left' }}>{error}</div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18 }}>
            {phase === 'in-call' ? (
              <>
                <button className="btn sm" style={{ background: muted ? '#334155' : '#1e293b', color: '#e2e8f0', border: '1px solid #334155' }} onClick={toggleMute}>{muted ? '🔇 Unmute' : '🎙 Mute'}</button>
                <button className="btn sm" style={{ background: '#dc2626', color: '#fff', border: 'none' }} onClick={hangup}>📵 Hang up</button>
              </>
            ) : phase === 'connecting' ? (
              <button className="btn sm" style={{ background: '#dc2626', color: '#fff', border: 'none' }} onClick={hangup}>Cancel</button>
            ) : phase === 'ended' ? (
              <button className="btn sm" onClick={onClose}>Close</button>
            ) : phase === 'error' ? (
              <button className="btn primary sm" onClick={() => { setError(null); setMuted(false); setPhase('loading'); setRetryKey((k) => k + 1); }}>↻ Retry</button>
            ) : (
              <button className="btn primary sm" disabled={phase !== 'ready'} onClick={dial}>
                {phase === 'loading' ? 'Preparing…' : `📞 Call ${lead.name}`}
              </button>
            )}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 14 }}>Talk through your computer’s mic &amp; speakers. The call is recorded and logged.</div>
        </div>
      </div>
    </div>
  ), document.body);
}
