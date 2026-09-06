/**
 * Revive Aesthetics - Meta Pixel loader + event helper.
 *
 * ONE shared file. Never inline a pixel snippet into a page, and never add a
 * second copy of this logic - the pixel id and the event names must only ever
 * be defined in one place.
 *
 * ---------------------------------------------------------------------------
 * TO SWITCH TRACKING ON: put the Pixel ID in PIXEL_ID below and push.
 * ---------------------------------------------------------------------------
 * Until then this file is a deliberate no-op: it loads nothing, sends nothing,
 * and sets no cookies. Every page can safely include it now so that the day
 * Stefani creates her Meta Business account it is a one-line change to go live.
 *
 * Get the id from Meta Events Manager -> Data sources -> your pixel (15-16 digits).
 *
 * ASCII quotes only in this file. A commit once pasted curly quotes into
 * admin.html and the whole script block stopped parsing, which took the Studio
 * Hub down silently for two days. Run `node scripts/check-pages.js` before
 * committing any page.
 */
(function () {
  'use strict';

  // Empty string = tracking disabled. This is the only line to change.
  var PIXEL_ID = '';

  // Pages that must NEVER be tracked, even once a pixel id is set.
  // These collect medical history or are Stefani's own admin tooling. Firing a
  // marketing pixel on a page where a client discloses health information is
  // both a privacy problem and the kind of health-inference signal Meta's own
  // policies push advertisers away from.
  var BLOCKED = [
    'admin.html',
    'intake.html',
    'face-consent.html',
    'body-consent.html',
    'lash-consent.html',
    'pdrn-consent.html',
    'lash-survey.html',
    'skin-consult-prep.html',
    'lash-prep.html',
    'lymphatic-prep.html',
    'microneedling-prep.html',
    'lash-lift-aftercare.html',
    'session-lauren.html'
  ];

  function onBlockedPage() {
    var path = (location.pathname || '').toLowerCase();
    for (var i = 0; i < BLOCKED.length; i++) {
      if (path.indexOf(BLOCKED[i]) !== -1) return true;
    }
    return false;
  }

  var active = !!PIXEL_ID && !onBlockedPage();

  // Always define the helper, whether or not tracking is on, so call sites in
  // book.html never need to guard and can never throw.
  // eventId is the deduplication key. The booking worker sends the same
  // event_id server-side via the Conversions API, so Meta counts ONE conversion
  // instead of two. If you change the id on one side, change it on the other.
  window.reviveTrack = function (event, params, eventId) {
    try {
      if (!active || typeof window.fbq !== 'function') return;
      if (eventId) window.fbq('track', event, params || {}, { eventID: String(eventId) });
      else window.fbq('track', event, params || {});
    } catch (e) {
      // Tracking must never break a booking. Swallow everything.
    }
  };

  if (!active) return;

  // Standard Meta pixel bootstrap.
  /* eslint-disable */
  (function (f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
    t = b.createElement(e); t.async = true; t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */

  try {
    window.fbq('init', PIXEL_ID);
    window.fbq('track', 'PageView');
  } catch (e) {
    // ignore
  }
})();
