// natsumi dashboard (ADR 0049): refreshes the sections marked data-refresh by polling their URL and putting the
// fragment in place. The fragment is the server's own escaped HTML from this origin. Polling, not SSE: every poll is a
// plain request with the cookie, which renews the session and ends cleanly at a logout or an expiry, and nothing stays
// open through the proxy in front. It waits while the tab is hidden; a 401 reloads the page, which starts the login.
'use strict';

const INTERVAL_MS = 10_000;

async function refresh(section) {
  const url = section.dataset.refresh;
  if (!url || !url.startsWith('/dashboard/')) return;
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  } catch {
    section.classList.add('stale');
    return;
  }
  if (response.status === 401) { window.location.reload(); return; }
  if (!response.ok) { section.classList.add('stale'); return; }
  const fragment = new DOMParser().parseFromString(await response.text(), 'text/html');
  const replacement = fragment.getElementById(section.id);
  if (replacement) section.replaceWith(document.importNode(replacement, true));
}

function tick() {
  if (document.hidden) return;
  for (const section of document.querySelectorAll('[data-refresh][id]')) void refresh(section);
}

setInterval(tick, INTERVAL_MS);
document.addEventListener('visibilitychange', tick);
