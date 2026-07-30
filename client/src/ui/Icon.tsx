/**
 * The application's icon set.
 *
 * Replaces the emoji that were standing in for icons. Emoji render differently on every platform,
 * carry their own colour so they cannot inherit a hover or active state, and sit on the text
 * baseline rather than aligning to a box — which is why the sidebar's glyphs were all slightly
 * different sizes and none of them turned indigo when their row became active.
 *
 * Hand-drawn rather than pulled from a package: this is a fixed, known set of about forty icons, and
 * a dependency would add a build step and a bundle for paths that fit in one file. Every icon is a
 * 24x24 outline on the same grid, 1.75 stroke, `currentColor` — so an icon takes the colour of the
 * text it sits beside, at any size, in any state, with no per-icon styling.
 */

export type IconName = keyof typeof PATHS;

/** Paths only — the wrapper supplies the viewBox, stroke and sizing so they cannot drift apart. */
const PATHS = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  analytics: <><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="m19 9-5 5-4-4-3 3" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></>,
  star: <path d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6.1-5.3-2.9-5.3 2.9 1.1-6.1L3.4 9.4l6-.8z" />,
  package: <><path d="M21 8.4v7.2a2 2 0 0 1-1 1.7l-7 3.9a2 2 0 0 1-2 0l-7-3.9a2 2 0 0 1-1-1.7V8.4a2 2 0 0 1 1-1.7l7-3.9a2 2 0 0 1 2 0l7 3.9a2 2 0 0 1 1 1.7z" /><path d="m3.5 7.5 8.5 4.8 8.5-4.8M12 21v-8.7" /></>,
  inbox: <><path d="M3 12h5l1.5 3h5L16 12h5" /><path d="M5.5 5h13l2.5 7v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6z" /></>,
  lead: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  users: <><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 20a6.4 6.4 0 0 0-2-4.6" /></>,
  megaphone: <><path d="M3 11v2a1 1 0 0 0 1 1h2l6 4V6L6 10H4a1 1 0 0 0-1 1z" /><path d="M16 8.5a4 4 0 0 1 0 7M18.5 6a7 7 0 0 1 0 12" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z" /></>,
  tag: <><path d="M11.6 3H5a2 2 0 0 0-2 2v6.6a2 2 0 0 0 .6 1.4l7.4 7.4a2 2 0 0 0 2.8 0l6.6-6.6a2 2 0 0 0 0-2.8L13 3.6a2 2 0 0 0-1.4-.6z" /><circle cx="8" cy="8" r="1.4" /></>,
  heart: <path d="M12 20s-7-4.4-7-9.3A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7 2.7C19 15.6 12 20 12 20z" />,
  briefcase: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 12.5h18" /></>,
  receipt: <><path d="M5 3.5 6.75 5 8.5 3.5 10.25 5 12 3.5 13.75 5 15.5 3.5 17.25 5 19 3.5v15.9a2.1 2.1 0 0 1-4.2 0V18H5z" /><path d="M8 8h8M8 12h8" /></>,
  report: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 17v-3M12 17v-5M15 17v-2" /></>,
  clipboard: <><rect x="5" y="5" width="14" height="16" rx="2" /><path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" /><path d="M9 11h6M9 15h4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.2-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>,
  zap: <path d="M13 2 4.5 13.2a.6.6 0 0 0 .5 1H11l-1 7.8 8.5-11.2a.6.6 0 0 0-.5-1H12z" />,
  trash: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12.2A2 2 0 0 0 9 21h6a2 2 0 0 0 2-1.8L18 7" /><path d="M9 7V4.8A1.8 1.8 0 0 1 10.8 3h2.4A1.8 1.8 0 0 1 15 4.8V7" /></>,
  logout: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l-5-5 5-5M5 12h11" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></>,
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  download: <><path d="M12 3v12M7.5 10.5 12 15l4.5-4.5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>,
  upload: <><path d="M12 15V3M7.5 7.5 12 3l4.5 4.5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>,
  edit: <><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" /><path d="m14.5 6.5 3 3" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>,
  message: <path d="M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.4A7.5 7.5 0 1 1 20 12z" />,
  bell: <><path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6z" /><path d="M13.7 20a2 2 0 0 1-3.4 0" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 6.5 8.5 6 8.5-6" /></>,
  phone: <path d="M6.5 3h3l1.5 4-2 1.5a12 12 0 0 0 5.5 5.5L16 12l4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4 6.2 2 2 0 0 1 6.5 3z" />,
  alert: <><path d="M12 3.5 21 19H3z" /><path d="M12 10v4M12 16.5v.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8v.5" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4v4.5h-4.5" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>,
  building: <><path d="M4 21V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15" /><path d="M14 10h4a2 2 0 0 1 2 2v9M3 21h18" /><path d="M7.5 8h3M7.5 12h3M7.5 16h3" /></>,
  dollar: <><path d="M12 3v18" /><path d="M16.5 7.5A3.5 3.5 0 0 0 13 5h-1.5a3 3 0 0 0 0 6h1a3 3 0 0 1 0 6H11a3.5 3.5 0 0 1-3.5-2.5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.2 2" /></>,
  doc: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
  /* The financial screens turn on locked and unlocked fields, so the two must read as the same
     padlock in two states rather than as two different pictures — same body, same shackle anchor,
     only the shackle's other leg moves. */
  lock: <><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7.2a4 4 0 0 1 8 0v3.3" /><path d="M12 14.5v2.2" /></>,
  unlock: <><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7.2a4 4 0 0 1 7.6-1.8" /><path d="M12 14.5v2.2" /></>,
  save: <><path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M7.5 3v5.5h7V3M7.5 21v-6h9v6" /></>,
  printer: <><path d="M7 9V3h10v6" /><rect x="3.5" y="9" width="17" height="7" rx="2" /><path d="M7 14h10v7H7z" /></>,
  folder: <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2a1.5 1.5 0 0 1 1.1.5l1.3 1.4a1.5 1.5 0 0 0 1.1.5h6.3A1.5 1.5 0 0 1 20 9.9v8.6a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3 18.5z" />,
  scale: <><path d="M12 4v16M7 20h10M12 6.5 5 9m7-2.5L19 9" /><path d="M2.5 14 5 9l2.5 5a2.5 2.5 0 0 1-5 0zM16.5 14 19 9l2.5 5a2.5 2.5 0 0 1-5 0z" /></>,
  wrench: <path d="M15.5 3.5a5.5 5.5 0 0 0-5 7.7L3.8 17.9a1.8 1.8 0 0 0 2.5 2.5l6.7-6.7a5.5 5.5 0 0 0 6.8-7.3l-3 3-2.6-2.6 3-3a5.5 5.5 0 0 0-1.7-.3z" />,
  arrowLeft: <path d="M19 12H5m0 0 6-6m-6 6 6 6" />,
  undo: <><path d="M4 9h11a5 5 0 0 1 0 10h-6" /><path d="M8 5 4 9l4 4" /></>,
} as const;

interface Props {
  name: IconName | string;
  /** Pixel size for both axes. Icons are square on a 24-unit grid, so they stay on pixel at 16/18/20. */
  size?: number;
  className?: string;
  /** Stroke width in grid units. Lighter reads better at large sizes, heavier at small ones. */
  strokeWidth?: number;
}

/**
 * Decorative by default: `aria-hidden` with no label, because these sit beside their own text almost
 * everywhere. An icon that is the only content of a control needs a label on the CONTROL, which is
 * where a screen reader looks for it — putting one here would announce the name twice.
 */
export default function Icon({ name, size = 18, className, strokeWidth = 1.75 }: Props) {
  const path = PATHS[name as IconName];
  // An unknown name renders nothing rather than throwing: a missing icon should leave a gap in the
  // interface, not take the page down with it.
  if (!path) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0, display: 'block' }}
    >
      {path}
    </svg>
  );
}
