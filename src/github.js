// GitHub data access for the browser (client code — holds NO secrets).
//
// Architecture: the browser NEVER talks to api.github.com directly and NEVER
// sees the GitHub token. All GitHub traffic goes through our own same-origin
// proxy:
//
//   Browser --GET /api/events, /api/users/:login--> Vite dev middleware
//     (vite.config.js) or the production serverless adapter (api/github.js)
//     --GET api.github.com + Authorization: Bearer GITHUB_TOKEN--> GitHub
//
// GITHUB_TOKEN (no VITE_ prefix) lives ONLY in the server environment. There
// is intentionally zero use of import.meta.env here: any VITE_* variable
// would be inlined into the client bundle and visible to anyone.

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const EVENTS_PER_PAGE = 100;
const PROFILE_BATCH_SIZE = 10;
const BATCH_DELAY_MS = 200;

const apiUrl = (path) => `${API_BASE}/api${path}`;

const STATUS_MESSAGES = {
  400: 'Request rejected by the local API proxy (bad request).',
  401: 'GitHub API: 401 Unauthorized — the server token is missing or invalid.',
  403: 'GitHub API: 403 Forbidden — rate limit exceeded or access denied.',
  404: 'GitHub API: 404 Not Found — the resource does not exist.',
  422: 'GitHub API: 422 Unprocessable Entity — the request was rejected.',
  502: 'Local API proxy could not reach the GitHub API; retrying.',
  503: 'Local API proxy unavailable; retrying.'
};

function describeStatus(status) {
  return STATUS_MESSAGES[status] || `GitHub API returned HTTP ${status}.`;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GitHubApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

// Server proxy health: { ok, hasToken }. hasToken is a boolean only — the
// token itself is never exposed. Returns null when the proxy is unreachable
// (e.g. a static host without /api deployed); callers treat that as a
// non-fatal setup warning and keep the last known globe state.
export async function getApiStatus() {
  try {
    const response = await fetch(apiUrl('/status'));
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// Fetch a single page of public GitHub events via the local proxy (the
// primary recent-event source). Errors carry HTTP status only — no secrets.
export async function getEvents(page = 1, perPage = EVENTS_PER_PAGE) {
  const safePage = Number.isInteger(page) && page >= 1 ? page : 1;
  const safePerPage =
    Number.isInteger(perPage) && perPage >= 1 && perPage <= 100 ? perPage : EVENTS_PER_PAGE;
  let response;
  try {
    response = await fetch(apiUrl(`/events?per_page=${safePerPage}&page=${safePage}`));
  } catch {
    throw new GitHubApiError(503, 'Local API proxy unreachable — is `npm run dev` serving /api?');
  }

  if (!response.ok) {
    console.error(describeStatus(response.status));
    throw new GitHubApiError(response.status, `GitHub events request failed (${response.status})`);
  }

  return response.json();
}

// Fetch up to `maxPages` of events (page 1 first), deduplicated by event id.
// A failed page does not fail the whole batch: successfully retrieved pages
// are used as-is, so a partial outage still enriches the globe. Callers must
// only request a small, controlled number of pages.
export async function getEventsPages(maxPages = 1, perPage = EVENTS_PER_PAGE) {
  const pages = Math.max(1, Math.min(Math.floor(maxPages) || 1, 10));
  const seen = new Set();
  const merged = [];

  for (let page = 1; page <= pages; page++) {
    let events;
    try {
      events = await getEvents(page, perPage);
    } catch (err) {
      // Page 1 failing is fatal (nothing to show for this sync); later pages
      // failing just truncate the batch — keep what already arrived.
      if (page === 1) throw err;
      console.error(`GitHub events page ${page} failed; using pages retrieved so far.`, err);
      break;
    }

    if (!Array.isArray(events) || events.length === 0) break;

    for (const event of events) {
      const id = event?.id ?? `${event?.actor?.login}:${event?.type}:${event?.created_at}`;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(event);
    }

    // A short page means the feed is exhausted — stop early instead of
    // requesting empty follow-ups.
    if (events.length < perPage) break;
  }

  return merged;
}

// Fetch one profile through the proxy and record its outcome in the shared
// `cache` map (username -> location string, or null when the user announced
// no location).
//
// Caching rules:
// - success (with or without location) -> cached, never refetched
// - 404 (account gone)                 -> cached as null, never refetched
// - 401/403                            -> fatal: caller should back off
// - other errors / network failures    -> NOT cached, retried on a later poll
async function fetchUserProfile(username, cache) {
  let response;
  try {
    response = await fetch(apiUrl(`/users/${encodeURIComponent(username)}`));
  } catch (err) {
    console.error(`Failed to fetch GitHub profile for ${username}:`, err);
    return { fatal: false };
  }

  if (response.status === 401 || response.status === 403) {
    console.error(describeStatus(response.status));
    return { fatal: true };
  }

  if (response.status === 404) {
    cache.set(username, null);
    return { fatal: false };
  }

  if (!response.ok) {
    console.error(`${describeStatus(response.status)} (user: ${username})`);
    return { fatal: false };
  }

  let user;
  try {
    user = await response.json();
  } catch (err) {
    console.error(`Failed to parse GitHub profile for ${username}:`, err);
    return { fatal: false };
  }

  cache.set(username, user.location ?? null);
  return { fatal: false };
}

// Fetch profiles for usernames not yet present in `cache`, in small concurrent
// batches. A single bad user must never stop the rest from being fetched.
// Returns `fatal: true` when a 401/403 suggests the caller should back off.
export async function fetchUsers(usernames, cache) {
  const missing = [...new Set(usernames)].filter((username) => !cache.has(username));
  if (missing.length === 0) return { fatal: false };

  for (let i = 0; i < missing.length; i += PROFILE_BATCH_SIZE) {
    const batch = missing.slice(i, i + PROFILE_BATCH_SIZE);
    const results = await Promise.all(batch.map((username) => fetchUserProfile(username, cache)));

    if (results.some((result) => result.fatal)) {
      console.warn('Stopping further profile fetches after a fatal GitHub API error.');
      return { fatal: true };
    }

    if (i + PROFILE_BATCH_SIZE < missing.length) {
      await delay(BATCH_DELAY_MS);
    }
  }

  return { fatal: false };
}
