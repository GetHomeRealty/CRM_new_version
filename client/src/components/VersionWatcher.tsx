import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { publishedBundle, runningBundle } from '../lib/appVersion';

const CHECK_EVERY_MS = 5 * 60 * 1000;

/**
 * TD-195 - picks up a new release without anybody being told to reload.
 *
 * Every five minutes, and whenever the tab comes back into view, it compares the main file this tab
 * runs with the one the server now publishes. When they differ it waits for the next page change
 * and reloads then: moving to another screen is the moment nothing half-typed can be lost, and the
 * reload lands on the screen the person just asked for.
 */
export default function VersionWatcher(): null {
  const location = useLocation();
  const outdated = useRef(false);
  const firstRender = useRef(true);

  useEffect(() => {
    const mine = runningBundle();
    if (!mine) return undefined;
    let stopped = false;
    const check = async (): Promise<void> => {
      if (outdated.current) return;
      const live = await publishedBundle();
      if (!stopped && live !== null && live !== mine) outdated.current = true;
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check();
    };
    const timer = window.setInterval(() => { void check(); }, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (outdated.current) window.location.reload();
  }, [location.pathname]);

  return null;
}
