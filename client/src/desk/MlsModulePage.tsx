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

  return (
    <>
      {/* No tab bar here: the sidebar now lists MLS and Favorites as sections, and putting the
          same choice in two places means two things to keep in step and a row of buttons that
          repeats what is already on screen. `go` is still used by the page's own
          "♥ My Favorites" button. */}
      {tab === 'favorites' ? <FavoritesPage /> : <MlsPage onShowFavorites={() => go('favorites')} />}
    </>
  );
}
