import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import MlsPage from './MlsPage';
import FavoritesPage from './FavoritesPage';

/**
 * MLS, with Favorites as a section inside it rather than a separate sidebar entry.
 *
 * The two were always one thing wearing two hats: a favourite IS an MLS listing, the Favorites
 * screen's only actions were "Browse MLS" and "open this listing", and MLS carried a button whose
 * whole job was to jump to Favorites. Putting them behind one entry removes that round trip.
 *
 * Neither page was rewritten — this is a shell that mounts one or the other. The section lives in
 * the query string (`?tab=favorites`) so it survives a reload, can be linked to, and the browser's
 * Back button steps between the two.
 */

const TABS = [
  { key: 'listings', label: 'Listings', ico: '\u{1F3F7}' },
  { key: 'favorites', label: 'Favorites', ico: '\u{2665}' },
] as const;

export default function MlsModulePage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();

  // Favorites keeps its own screen permission — merging the navigation must not hand it to
  // someone an administrator had deliberately kept it from.
  const maySeeFavorites = can('favorites', 'view');
  const requested = params.get('tab') === 'favorites' ? 'favorites' : 'listings';
  const tab = requested === 'favorites' && !maySeeFavorites ? 'listings' : requested;

  // replace, not push: switching sections is not a navigation someone wants to unwind one step
  // at a time, and it keeps the Back button pointed at wherever they came from.
  const go = (key: string) => {
    const next = new URLSearchParams(params);
    if (key === 'listings') next.delete('tab'); else next.set('tab', key);
    setParams(next, { replace: true });
  };

  const visible = TABS.filter((t) => t.key !== 'favorites' || maySeeFavorites);

  return (
    <>
      {visible.length > 1 && (
        <div className="toolbar"><div className="toolbar-row">
          {visible.map((t) => (
            <button key={t.key} className={`btn sm ${tab === t.key ? 'primary' : 'ghost'}`} onClick={() => go(t.key)}>
              {t.ico} {t.label}
            </button>
          ))}
        </div></div>
      )}

      {tab === 'favorites' ? <FavoritesPage /> : <MlsPage onShowFavorites={() => go('favorites')} />}
    </>
  );
}
