/*
 * Service worker: appointment reminders.
 *
 * This exists only to receive push messages. It deliberately does NOT cache anything — an offline
 * cache for an app whose whole content is live brokerage data would serve yesterday's deals, and
 * every version bump would need a cache-invalidation story. A worker that only shows notifications
 * has neither problem.
 *
 * It is served from the site root because a worker can only receive pushes for pages under its own
 * scope, and the calendar is not the only page an agent will have open when a reminder arrives.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  // A push with no readable body still means something arrived; showing a bare notice beats showing
  // nothing, and on Chrome a push that displays no notification at all costs the site its
  // permission after a few repeats.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || 'Appointment reminder';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/logo.svg',
      badge: '/logo.svg',
      // Same tag for both reminders about one appointment, so the hour-before notice replaces the
      // day-before one rather than leaving two on the lock screen.
      tag: data.tag || 'reminder',
      renotify: true,
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  // Focus a tab that is already open rather than opening a second one — an agent who taps a reminder
  // wants the calendar they were already working in, not a fresh login.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes(target) && 'focus' in w) return w.focus();
      }
      for (const w of wins) {
        if ('navigate' in w && 'focus' in w) return w.navigate(target).then((c) => c && c.focus());
      }
      return self.clients.openWindow(target);
    }),
  );
});
