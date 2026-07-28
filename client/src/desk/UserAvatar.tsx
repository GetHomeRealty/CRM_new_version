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
export const bumpPhotoVersion = (): number => ++photoVersion;

export interface UserAvatarProps {
  userId?: number | null;
  name?: string | null;
  /** Rendered diameter in pixels. */
  size?: number;
  /** Cache-buster; pass the user's photo_version after a change. */
  version?: string | number | null;
  title?: string;
  style?: CSSProperties;
}

export default function UserAvatar({ userId, name, size = 36, version, title, style }: UserAvatarProps) {
  const [failed, setFailed] = useState(false);
  const bust = version ?? (photoVersion || null);

  // A different user (or a new upload) deserves a fresh attempt at the image.
  useEffect(() => { setFailed(false); }, [userId, bust]);

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
      onError={() => setFailed(true)}
      style={{ ...base, objectFit: 'cover' }}
    />
  );
}
