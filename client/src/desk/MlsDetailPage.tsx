import { useArea } from './AreaContext';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { getMlsListing, type MlsProperty } from '../lib/mlsApi';
import { favoriteKeys, toggleFavorite } from '../lib/favoritesApi';
import { PROPERTY_GROUPS, fmtValue, money, snapshotOf, downloadPropertyPdf } from './mlsFields';

const stPill = (s?: string) => (s === 'Active' ? 'ok' : s === 'Sold' || s === 'Closed' ? 'bad' : s === 'Pending' ? 'warn' : 'info');

export default function MlsDetailPage() {
  const { link } = useArea();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [property, setProperty] = useState<MlsProperty | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fav, setFav] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getMlsListing(id)
      .then(setProperty)
      .catch((e) => setError(apiErrorMessage(e, 'Failed to load property details')))
      .finally(() => setLoading(false));
    favoriteKeys().then((k) => setFav(k.includes(id))).catch(() => {});
  }, [id]);

  const heart = async () => {
    if (!property) return;
    setFav((v) => !v); // optimistic
    try {
      const res = await toggleFavorite(id, snapshotOf(property));
      setFav(res.favorited);
      toast(res.favorited ? 'Added to favorites' : 'Removed from favorites', 'ok');
    } catch (e) {
      setFav((v) => !v);
      toast(apiErrorMessage(e, 'Could not update favorites'), 'bad');
    }
  };

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: String(property?.UnparsedAddress || 'Property'), url });
      else { await navigator.clipboard.writeText(url); toast('Link copied to clipboard', 'ok'); }
    } catch { /* user cancelled */ }
  };

  if (loading) return <div className="centered" style={{ padding: 40 }}>Loading property details…</div>;
  if (error || !property) {
    return (
      <div className="card centered" style={{ padding: 40 }}>
        <h3 style={{ margin: 0 }}>{error || 'Property not found'}</h3>
        <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => navigate(link('mls'))}>Back to Listings</button>
      </div>
    );
  }

  const p = property as Record<string, unknown>;
  const features = (v: unknown): string[] => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

  return (
    <>
      <button className="btn ghost sm" style={{ marginBottom: 12 }} onClick={() => navigate(link('mls'))}>← Back to Listings</button>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(220px, 1fr)', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Header */}
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
              <div>
                <div style={{ fontSize: 26, fontWeight: 800 }}>${money(property.ListPrice)}</div>
                <div style={{ marginTop: 4, fontSize: 14 }}>{String(property.UnparsedAddress || '')}</div>
                <div className="muted" style={{ fontSize: 13 }}>{[property.City, property.StateOrProvince, property.PostalCode].filter(Boolean).join(', ')}</div>
              </div>
              <span className={`pill ${stPill(property.StandardStatus)}`}>{property.StandardStatus || 'Unknown'}</span>
            </div>
            <div style={{ display: 'flex', gap: 18, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)', fontSize: 14 }}>
              <span>🛏 {fmtValue(property.BedroomsTotal)} beds</span>
              <span>🛁 {fmtValue(property.BathroomsTotalInteger)} baths</span>
              <span>▢ {property.LivingArea ? money(property.LivingArea) : 'N/A'} sqft</span>
              <span>🏠 {fmtValue(property.PropertyType)}</span>
            </div>
          </div>

          {/* Description */}
          {typeof p.PublicRemarks === 'string' && p.PublicRemarks && (
            <div className="card" style={{ padding: 16 }}>
              <h3 style={{ margin: '0 0 8px' }}>Description</h3>
              <p style={{ margin: 0, whiteSpace: 'pre-line', color: 'var(--text-2, var(--text-3))', fontSize: 14 }}>{p.PublicRemarks}</p>
            </div>
          )}

          {/* Detail groups */}
          <div className="card" style={{ padding: 16 }}>
            <h3 style={{ margin: '0 0 12px' }}>Property Details</h3>
            {Object.entries(PROPERTY_GROUPS).map(([group, fields]) => {
              const shown = fields.filter((f) => p[f.key] !== undefined && p[f.key] !== null && p[f.key] !== '');
              if (shown.length === 0) return null;
              return (
                <div key={group} style={{ marginBottom: 16 }}>
                  <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 8 }}>{group}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px 16px' }}>
                    {shown.map((f) => (
                      <div key={f.key}>
                        <div className="muted" style={{ fontSize: 12 }}>{f.label}</div>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{f.prefix || ''}{f.key.toLowerCase().includes('price') ? money(p[f.key]) : fmtValue(p[f.key])}{f.suffix ? ` ${f.suffix}` : ''}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Features */}
          {(features(p.InteriorFeatures).length > 0 || features(p.ExteriorFeatures).length > 0) && (
            <div className="card" style={{ padding: 16 }}>
              <h3 style={{ margin: '0 0 12px' }}>Features</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {(['InteriorFeatures', 'ExteriorFeatures'] as const).map((k) => features(p[k]).length > 0 && (
                  <div key={k}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{k === 'InteriorFeatures' ? 'Interior' : 'Exterior'}</div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5 }}>{features(p[k]).map((ft) => <li key={ft}>{ft}</li>)}</ul>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, position: 'sticky', top: 12 }}>
          <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className={`btn ${fav ? 'primary' : 'ghost'}`} onClick={heart}>{fav ? '♥ Saved to Favorites' : '♡ Save to Favorites'}</button>
            <button className="btn ghost" onClick={share}>↗ Share Property</button>
            <button className="btn ghost" onClick={() => { void downloadPropertyPdf(property).catch((e) => toast(apiErrorMessage(e, 'Could not generate the PDF'), 'bad')); }}>⬇ Download PDF</button>
          </div>

          {!!(property.ListAgentFullName || property.ListAgentEmail || property.ListAgentPhone) && (
            <div className="card" style={{ padding: 16 }}>
              <h3 style={{ margin: '0 0 10px' }}>Contact</h3>
              {!!property.ListAgentFullName && <Row label="Listing Agent" value={String(property.ListAgentFullName)} />}
              {!!property.ListAgentEmail && <Row label="Email" value={String(property.ListAgentEmail)} href={`mailto:${property.ListAgentEmail}`} />}
              {!!property.ListAgentPhone && <Row label="Phone" value={String(property.ListAgentPhone)} href={`tel:${property.ListAgentPhone}`} />}
              {!!property.ListOfficeName && <Row label="Office" value={String(property.ListOfficeName)} />}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      {href ? <a href={href} style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--brand)' }}>{value}</a> : <div style={{ fontWeight: 600, fontSize: 13.5 }}>{value}</div>}
    </div>
  );
}
