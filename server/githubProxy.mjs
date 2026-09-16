// Server-side GitHub proxy helpers (Node only — NEVER imported by the browser).
//
// The GitHub token lives here, in server process memory (`GITHUB_TOKEN` env
// var). It is attached to api.github.com requests server-side and is never
// sent to, logged for, or readable by the browser.

const GITHUB_API_ROOT = 'https://api.github.com';
const USER_AGENT = 'github-globe-proxy';

export function getGithubToken(env = process.env) {
  const token = env.GITHUB_TOKEN;
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

// Sanitize an upstream failure into a body safe to return to the browser.
// Never includes the token, the Authorization header, or upstream internals
// beyond a generic message + status.
export function proxyErrorBody(status, detail) {
  return { error: 'github_upstream_error', status, detail };
}

function safeDetail(status) {
  switch (status) {
    case 401:
      return 'Unauthorized — check the server GITHUB_TOKEN.';
    case 403:
      return 'Forbidden / rate limit exceeded. Try again shortly.';
    case 404:
      return 'Not found.';
    case 422:
      return 'Request rejected as unprocessable.';
    default:
      return `GitHub request failed (HTTP ${status}).`;
  }
}

// Forward one GET to api.github.com and return { status, bodyText, contentType,
// rateLimit } for the caller (dev middleware or serverless adapter) to relay.
export async function forwardToGitHub(path, token) {
  const upstream = await fetch(`${GITHUB_API_ROOT}${path}`, {
    headers: githubHeaders(token)
  });

  const bodyText = await upstream.text();
  const headers = upstream.headers;

  return {
    status: upstream.status,
    bodyText,
    contentType: headers.get('content-type') || 'application/json',
    rateLimit: {
      limit: headers.get('x-ratelimit-limit'),
      remaining: headers.get('x-ratelimit-remaining'),
      reset: headers.get('x-ratelimit-reset')
    },
    // Exposed only so the caller can log a one-line summary WITHOUT the token.
    safeDetail: safeDetail(upstream.status)
  };
}

export { GITHUB_API_ROOT };
