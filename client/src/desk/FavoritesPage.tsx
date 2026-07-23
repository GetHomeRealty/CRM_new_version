import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { listFavorites, removeFavorite, type Favorite } from '../lib/favoritesApi';
import { getMlsListing } from '../lib/mlsApi';
import { money, downloadPropertyPdf } from './mlsFields';

const SORT_OPTIONS = [
  { value: 'date_desc', label: 'Recently Added' },
  { value: 'price_desc', label: 'Price: High to Low' },
  { value: 'price_asc', label: 'Price: Low to High' },
];
const stPill = (s?: string) => (s === 'Active' ? 'ok' : s === 'Sold' || s === 'Closed' ? 'bad' : s === 'Pending' ? 'warn' : 'info');

export default function FavoritesPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('date_desc');
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    listFavorites()
      .then(setFavorites)
      .catch((e) => toast(apiErrorMessage(e, 'Could not load favorites'), 'bad'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = favorites.filter((f) => {
      if (!q) return true;
      const s = f.snapshot || {};
      return [s.UnparsedAddress, s.City, s.StateOrProvince, s.PostalCode].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
    });
    rows = [...rows].sort((a, b) => {
      if (sort === 'price_desc') return Number(b.snapshot?.ListPrice || 0) - Number(a.snapshot?.ListPrice || 0);
      if (sort === 'price_asc') return Number(a.snapshot?.ListPrice || 0) - Number(b.snapshot?.ListPrice || 0);
      return 0; // date_desc — API already returns newest first
    });
    return rows;
  }, [favorites, search, sort]);

  const remove = async (key: string) => {
    setFavorites((prev) => prev.filter((f) => f.listing_key !== key)); // optimistic
    try {
      await removeFavorite(key);
      toast('Removed from favorites', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not remove favorite'), 'bad');
      load();
    }
  };

  const pdf = async (key: string) => {
    setPdfBusy(key);
    try {
      const full = await getMlsListing(key); // full record for a complete report
      downloadPropertyPdf(full);
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not generate the PDF'), 'bad');
    } finally {
      setPdfBusy(null);
    }
  };

  if (loading) return <div className="centered" style={{ padding: 40 }}>Loading favorites…</div>;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Favorites</h2>
          <div className="muted" style={{ fontSize: 13 }}>Your saved MLS listings</div>
        </div>
        <button className="btn ghost sm" onClick={() => navigate('/app/mls')}>Browse MLS</button>
      </div>

      {favorites.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <input className="search" style={{ flex: 1, minWidth: 220 }} placeholder="Search your favorites…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={sort} onChange={(e) => setSort(e.target.value)}>{SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="card centered" style={{ padding: 40 }}>
          <h3 style={{ margin: 0 }}>{search ? 'No matching favorites' : 'No favorite properties yet'}</h3>
          <p className="muted" style={{ marginTop: 6 }}>{search ? 'Try a different search.' : 'Save properties from MLS listings to see them here.'}</p>
          <button className="btn primary" style={{ marginTop: 10 }} onClick={() => navigate('/app/mls')}>Browse MLS Listings</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {shown.map((f) => {
            const s = f.snapshot || {};
            const key = f.listing_key;
            return (
              <div key={key} className="card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }} onClick={() => navigate(`/app/mls/${encodeURIComponent(key)}`)}>
                  <div style={{ fontWeight: 700, fontSize: 18 }}>${money(s.ListPrice)}</div>
                  <span className={`pill ${stPill(s.StandardStatus)}`}>{s.StandardStatus || 'Unknown'}</span>
                </div>
                <div style={{ marginTop: 8, fontSize: 13, cursor: 'pointer' }} onClick={() => navigate(`/app/mls/${encodeURIComponent(key)}`)}>
                  <div style={{ fontWeight: 600 }}>{String(s.UnparsedAddress || 'No address')}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{[s.City, s.StateOrProvince, s.PostalCode].filter(Boolean).join(', ')}</div>
                </div>
                <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 13, color: 'var(--text-2, #475569)' }}>
                  <span>🛏 {s.BedroomsTotal ?? 'N/A'} bd</span>
                  <span>🛁 {s.BathroomsTotalInteger ?? 'N/A'} ba</span>
                  <span>▢ {s.LivingArea ? money(s.LivingArea) : 'N/A'} sqft</span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                  <button className="btn ghost sm" style={{ flex: 1 }} onClick={() => navigate(`/app/mls/${encodeURIComponent(key)}`)}>View</button>
                  <button className="btn ghost sm" disabled={pdfBusy === key} onClick={() => pdf(key)} title="Download PDF">{pdfBusy === key ? '…' : '⬇'}</button>
                  <button className="btn ghost sm" style={{ color: 'var(--bad)' }} title="Remove from favorites" onClick={() => remove(key)}>♥</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
