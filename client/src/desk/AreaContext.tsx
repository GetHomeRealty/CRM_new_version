import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_AREA, areaPath, type Area } from './area';

/**
 * Which area the screen currently on display belongs to.
 *
 * Provided by the shell, which is given its area by the router, so a page never has to parse the
 * URL to find out — and cannot disagree with the sidebar rendered around it.
 *
 * `link()` is here because it is the operation pages actually need: building a path that stays
 * inside the current area. Hard-coding `/desk/...` inside a shared screen is how a link ends up
 * dragging a CRM user into the Transaction Desk.
 */

interface AreaContextValue {
  area: Area;
  /** A path inside the current area: `link('transactions/12')` → `/desk/transactions/12`. */
  link: (screen?: string) => string;
}

const AreaContext = createContext<AreaContextValue>({
  area: DEFAULT_AREA,
  link: (screen) => areaPath(DEFAULT_AREA, screen),
});

export function AreaProvider({ area, children }: { area: Area; children: ReactNode }) {
  return (
    <AreaContext.Provider value={{ area, link: (screen) => areaPath(area, screen) }}>
      {children}
    </AreaContext.Provider>
  );
}

export function useArea(): AreaContextValue {
  return useContext(AreaContext);
}
