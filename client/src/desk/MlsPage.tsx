import { useArea } from './AreaContext';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { searchMls, mlsStatus, type MlsProperty, type MlsSearchParams } from '../lib/mlsApi';
import { favoriteKeys, toggleFavorite } from '../lib/favoritesApi';
import { snapshotOf, money } from './mlsFields';

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest First' },
  { value: 'price_asc', label: 'Price: Low to High' },
  { value: 'price_desc', label: 'Price: High to Low' },
];
const PROPERTY_TYPES = ['any', 'Residential', 'Condo', 'Townhouse', 'MultiFamily', 'Land'];
const STATUSES = ['any', 'Active', 'Pending', 'Sold'];
const BEDS = ['any', '1', '2', '3', '4', '5'];
const BATHS = ['any', '1', '2', '3', '4'];

const emptyFilters = { search: '', sort: 'newest', priceMin: '', priceMax: '', beds: 'any', baths: 'any', propertyType: 'any', status: 'any' };
type Filters = typeof emptyFilters;

const stPill = (s?: string) => (s === 'Active' ? 'ok' : s === 'Sold' || s === 'Closed' ? 'bad' : s === 'Pending' ? 'warn' : 'info');

/**
 * `onShowFavorites` is supplied when this is mounted inside the MLS shell, where Favorites is a
 * section rather than a route. Without it the button still navigates, so the page keeps working
 * on its own.
 */
export default function MlsPage({ onShowFavorites }: { onShowFavorites?: () => void } = {}) {
  const { link } = useArea();
  const navigate = useNavigate();
  const toast = useToast();

  const [configured, setConfigured] = useState<boolean | null>(null);
  const [properties, setProperties] = useState<MlsProperty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [favs, setFavs] = useState<Set<string>>(new Set());

  // Debounce the free-text search so each keystroke doesn't hit the MLS feed.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(filters.search.trim()), 400);
    return () => clearTimeout(t);
  }, [filters.search]);

  useEffect(() => {
    mlsStatus().then((s) => setConfigured(s.configured)).catch(() => setConfigured(false));
    favoriteKeys().then((k) => setFavs(new Set(k))).catch(() => {});
  }, []);

  const params: MlsSearchParams = useMemo(() => ({
    page,
    search: debouncedSearch,
    sort: filters.sort,
    priceMin: Number(filters.priceMin) || undefined,
    priceMax: filters.priceMax ? Number(filters.priceMax) : undefined,
    beds: filters.beds,
    baths: filters.baths,
    propertyType: filters.propertyType,
    status: filters.status,
  }), [page, debouncedSearch, filters]);

  const load = useCallback(() => {
    if (configured === false) { setLoading(false); return; }
    if (configured === null) return;
    setLoading(true);
    setError(null);
    searchMls(params)
      .then((r) => { setProperties(r.properties); setTotal(r.total); setTotalPages(r.totalPages); })
      .catch((e) => { setError(apiErrorMessage(e, 'Failed to load MLS listings')); setProperties([]); })
      .finally(() => setLoading(false));
  }, [configured, params]);

  useEffect(() => { load(); }, [load]);

  // Reset to page 1 whenever a filter (other than page) changes.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setPage(1);
  }, [debouncedSearch, filters.sort, filters.priceMin, filters.priceMax, filters.beds, filters.baths, filters.propertyType, filters.status]);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  const heart = async (e: MouseEvent, p: MlsProperty) => {
    e.stopPropagation();
    const key = String(p.ListingKey || '');
    if (!key) return;
    // Optimistic toggle.
    setFavs((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
    try {
      const res = await toggleFavorite(key, snapshotOf(p));
      setFavs((prev) => { const n = new Set(prev); res.favorited ? n.add(key) : n.delete(key); return n; });
      toast(res.favorited ? 'Added to favorites' : 'Removed from favorites', 'ok');
    } catch (err) {
      setFavs((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; }); // revert
      toast(apiErrorMessage(err, 'Could not update favorites'), 'bad');
    }
  };

  if (configured === false) {
    return (
      <>
        <h2 style={{ margin: '0 0 12px' }}>MLS Listings</h2>
        <div className="import-error">
          <strong>MLS is not configured.</strong>
          <div style={{ marginTop: 4, fontSize: 13 }}>
            Set <code>MLS_API_URL</code> and <code>MLS_ACCESS_TOKEN</code> in the API environment and restart the server.
            The module and Favorites will start working immediately once the feed credentials are in place.
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>MLS Listings</h2>
          <div className="muted" style={{ fontSize: 13 }}>{loading ? 'Searching…' : `${total.toLocaleString('en-CA')} properties found`}</div>
        </div>
        <button className="btn ghost sm" onClick={() => (onShowFavorites ? onShowFavorites() : navigate(link('favorites')))}>♥ My Favorites</button>
      </div>

      {/* Filter bar */}
      <div className="card" style={{ padding: 12, marginBottom: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, alignItems: 'end' }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <input className="search" style={{ width: '100%' }} placeholder="Search by address, city, or postal code…" value={filters.search} onChange={(e) => set({ search: e.target.value })} />
        </div>
        <Field label="Sort"><select value={filters.sort} onChange={(e) => set({ sort: e.target.value })}>{SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
        <Field label="Min Price"><input type="number" min={0} placeholder="No min" value={filters.priceMin} onChange={(e) => set({ priceMin: e.target.value })} /></Field>
        <Field label="Max Price"><input type="number" min={0} placeholder="No max" value={filters.priceMax} onChange={(e) => set({ priceMax: e.target.value })} /></Field>
        <Field label="Beds"><select value={filters.beds} onChange={(e) => set({ beds: e.target.value })}>{BEDS.map((b) => <option key={b} value={b}>{b === 'any' ? 'Any' : `${b}+`}</option>)}</select></Field>
        <Field label="Baths"><select value={filters.baths} onChange={(e) => set({ baths: e.target.value })}>{BATHS.map((b) => <option key={b} value={b}>{b === 'any' ? 'Any' : `${b}+`}</option>)}</select></Field>
        <Field label="Type"><select value={filters.propertyType} onChange={(e) => set({ propertyType: e.target.value })}>{PROPERTY_TYPES.map((t) => <option key={t} value={t}>{t === 'any' ? 'Any' : t}</option>)}</select></Field>
        <Field label="Status"><select value={filters.status} onChange={(e) => set({ status: e.target.value })}>{STATUSES.map((s) => <option key={s} value={s}>{s === 'any' ? 'Any' : s}</option>)}</select></Field>
      </div>

      {loading ? (
        <div className="centered" style={{ padding: 40 }}>Loading properties…</div>
      ) : error ? (
        <div className="import-error">{error}</div>
      ) : properties.length === 0 ? (
        <div className="card centered" style={{ padding: 40 }}><h3 style={{ margin: 0 }}>No properties found</h3><p className="muted" style={{ marginTop: 6 }}>Try adjusting your filters or search.</p></div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {properties.map((p) => {
              const key = String(p.ListingKey || '');
              const fav = favs.has(key);
              return (
                <div key={key} className="card" style={{ padding: 0, overflow: 'hidden', cursor: 'pointer' }} onClick={() => navigate(link(`mls/${encodeURIComponent(key)}`))}>
                  <div style={{ padding: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                      <div style={{ fontWeight: 700, fontSize: 18 }}>${money(p.ListPrice)}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className={`pill ${stPill(p.StandardStatus)}`}>{p.StandardStatus || 'Unknown'}</span>
                        <button className="btn ghost sm" title={fav ? 'Remove favorite' : 'Add favorite'} style={{ color: fav ? 'var(--bad)' : 'var(--muted)', padding: '2px 6px' }} onClick={(e) => heart(e, p)}>{fav ? '♥' : '♡'}</button>
                      </div>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 13 }}>
                      <div style={{ fontWeight: 600 }}>{String(p.UnparsedAddress || 'No address')}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{[p.City, p.StateOrProvince, p.PostalCode].filter(Boolean).join(', ')}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 13, color: 'var(--text-2, #475569)' }}>
                      <span>🛏 {p.BedroomsTotal ?? 'N/A'} bd</span>
                      <span>🛁 {p.BathroomsTotalInteger ?? 'N/A'} ba</span>
                      <span>▢ {p.LivingArea ? money(p.LivingArea) : 'N/A'} sqft</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 16 }}>
              <button className="btn ghost sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
              <span className="muted" style={{ fontSize: 13 }}>Page {page} of {totalPages}</span>
              <button className="btn ghost sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>{label}</div>
      {children}
    </div>
  );
}
