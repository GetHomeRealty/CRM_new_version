import { useEffect, useState, type CSSProperties } from 'react';
import { userPhotoUrl } from '../lib/api';

/**
 * A user's profile picture, with the initial-letter circle as the fallback.
 *
 * No data fetch is needed to decide which to show: the photo lives at a fixed per-user URL,
 * so a 404 simply means "none uploaded" and the initial renders instead. That keeps this
 * usable in a list of fifty users without fifty extra API calls to ask who has a picture.
 *
 * The route requires a session, so the tag is marked crossOrigin="use-credentials" —
 * without it the cookie is not sent in development, where the SPA and API are on different
 * ports, and every avatar would silently fall back to its initial.
 */

/** Bumped after an upload/removal so mounted avatars pick up the new file. */
let photoVersion = 0;

/**
 * Users already known to have no picture, so the 404 is paid once instead of once per mount.
 *
 * The design above is right and is kept: asking the API who has a photo would cost one request per
 * user in a list of fifty, which is worse than one 404 per user. What it did not account for is that
 * the answer was forgotten the moment the component unmounted — so the same missing photo was
 * re-requested on every navigation. Measured during the CRM audit: a 404 and a red console error on
 * EVERY page load for any user without a picture, and five of them on one render of the Users
 * screen.
 *
 * Keyed by user AND cache-buster, not by user alone. `bust` changes exactly when the picture does
 * (it is the user's `photo_version`), so a newly uploaded photo is a different key and gets a fresh
 * attempt — remembering "missing" for ever would mean an upload never appeared.
 */
const noPhoto = new Set<string>();
const missKey = (userId: number, bust: string | number | null): string => `${userId}:${bust ?? ''}`;

export const bumpPhotoVersion = (): number => {
  // An upload or removal invalidates every remembered answer: the version-less callers share one
  // counter, and a user who just gained a picture must stop being remembered as having none.
  noPhoto.clear();
  return ++photoVersion;
};

export interface UserAvatarProps {
  userId?: number | null;
  name?: string | null;
  /** Rendered diameter in pixels. */
  size?: number;
  /** Cache-buster; pass the user's photo_version after a change. */
  version?: string | number | null;
  /**
   * Whether this user has a picture at all, when the caller already knows.
   *
   * THE 404-PER-USER TRADE ABOVE IS ONLY A GOOD ONE WHEN THE ANSWER COSTS A REQUEST. On the Users
   * screen it does not: `GET /api/users` already returns each row's `profile`, and `photo_path`
   * inside it is exactly what `has_photo` is derived from server-side. Measured against production
   * on 2026-09-16: 127 users, ONE of whom had a picture, so the screen issued 126 requests that
   * could only ever 404 — 126 red console errors on a single load, and a cold render of 9.9 s.
   *
   * Pass `false` and the initial renders immediately with no request at all. Leave it undefined and
   * the original behaviour is unchanged, which is what every other caller relies on.
   */
  hasPhoto?: boolean;
  title?: string;
  style?: CSSProperties;
}

export default function UserAvatar({ userId, name, size = 36, version, title, style, hasPhoto }: UserAvatarProps) {
  const bust = version ?? (photoVersion || null);
  // `hasPhoto === false` is the caller stating there is no picture, which settles it without a
  // request. Anything else falls through to the cache, so callers that pass nothing are unaffected.
  const known = hasPhoto === false;
  // Start from what is already known, so a user we have seen 404 renders their initial without
  // issuing the request again.
  const [failed, setFailed] = useState(() => known || (userId ? noPhoto.has(missKey(userId, bust)) : false));

  // A different user, or a new upload, deserves a fresh attempt — unless this exact user at this
  // exact version has already been found to have no picture.
  useEffect(() => {
    setFailed(known || (userId ? noPhoto.has(missKey(userId, bust)) : false));
  }, [userId, bust, known]);

  const remember = () => {
    if (userId) noPhoto.add(missKey(userId, bust));
    setFailed(true);
  };

  const initial = (name || 'U').trim().charAt(0).toUpperCase() || 'U';
  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
    ...style,
  };

  if (!userId || failed) {
    return (
      <div className="avatar" style={{ ...base, fontSize: Math.max(11, Math.round(size * 0.42)) }} title={title ?? name ?? undefined}>
        {initial}
      </div>
    );
  }
  return (
    <img
      src={userPhotoUrl(userId, bust)}
      alt={name ? `${name}'s profile picture` : 'Profile picture'}
      title={title ?? name ?? undefined}
      crossOrigin="use-credentials"
      onError={remember}
      style={{ ...base, objectFit: 'cover' }}
    />
  );
}
