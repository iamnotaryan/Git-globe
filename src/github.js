const API_ROOT = 'https://api.github.com';
const EVENTS_PER_PAGE = 100;
const PROFILE_BATCH_SIZE = 10;
const BATCH_DELAY_MS = 200;

// NOTE: VITE_GITHUB_TOKEN is inlined into the client bundle by Vite and is
// visible to anyone visiting the site. This is fine for local development
// only — see README.md for the production implications.
const TOKEN = import.meta.env.VITE_GITHUB_TOKEN;

if (!TOKEN) {
  console.warn(
    'No VITE_GITHUB_TOKEN set; falling back to unauthenticated GitHub API (60 requests/hour).'
  );
}

const headers = {
  Accept: 'application/vnd.github+json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
};

const STATUS_MESSAGES = {
  401: 'GitHub API: 401 Unauthorized — the token is missing or invalid.',
  403: 'GitHub API: 403 Forbidden — rate limit exceeded or access denied.',
  422: 'GitHub API: 422 Unprocessable Entity — the request was rejected.'
};

function describeStatus(status) {
  return STATUS_MESSAGES[status] || `GitHub API returned HTTP ${status}.`;
}

// Fetch a single page of public GitHub events (the concurrency feed).
export async function getEvents() {
  const response = await fetch(`${API_ROOT}/events?per_page=${EVENTS_PER_PAGE}`, { headers });

  if (!response.ok) {
    console.error(describeStatus(response.status));
    throw new Error(`GitHub events request failed (${response.status})`);
  }

  return response.json();
}

async function fetchUserProfile(username) {
  try {
    const response = await fetch(
      `${API_ROOT}/users/${encodeURIComponent(username)}`,
      { headers }
    );

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        console.error(describeStatus(response.status));
        return { user: null, fatal: true };
      }

      if (response.status !== 404) {
        console.error(`${describeStatus(response.status)} (user: ${username})`);
      }

      return { user: null, fatal: false };
    }

    const user = await response.json();

    if (!user.location) {
      return { user: null, fatal: false };
    }

    return { user: { login: user.login, location: user.location }, fatal: false };
  } catch (err) {
    console.error(`Failed to fetch GitHub profile for ${username}:`, err);
    return { user: null, fatal: true };
  }
}

// Fetch multiple profiles concurrently in small batches to stay well under
// rate limits. Returns profiles that announced a location.
export async function fetchUsers(usernames) {
  const users = [];

  for (let i = 0; i < usernames.length; i += PROFILE_BATCH_SIZE) {
    const batch = usernames.slice(i, i + PROFILE_BATCH_SIZE);
    const results = await Promise.all(batch.map(fetchUserProfile));

    for (const result of results) {
      if (result.user) users.push(result.user);
    }

    if (results.some((result) => result.fatal)) {
      console.warn('Stopping further profile fetches after a fatal GitHub API error.');
      break;
    }

    if (i + PROFILE_BATCH_SIZE < usernames.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return users;
}