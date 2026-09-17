// Production serverless template (Vercel / Netlify-style).
//
// Deploy note: this repository is Vite-only for local development. For any
// public deployment, host ONE of these adapters on your serverless platform
// and point the built frontend at the same origin (or set VITE_API_BASE to
// the deployed base URL — a plain origin URL, never a secret):
//
//   Browser  ->  /api/events, /api/users/:login, /api/status (this function)
//            ->  api.github.com (with GITHUB_TOKEN injected server-side)
//
// Platform setup:
//   1. Set the `GITHUB_TOKEN` environment variable (no VITE_ prefix) in the
//      platform's secrets manager (Vercel: Project Settings > Environment
//      Variables; Netlify: Site settings > Environment variables).
//   2. Deploy this file as a serverless function mapped to /api/*
//      (Vercel: `api/github.js` with rewrites; Netlify: adapt to a Function
//      and redirect /api/* to it — see README.md).
//   3. Use a fine-grained personal access token with minimum (public-read)
//      permissions. Rotate immediately if a token was ever inlined with a
//      VITE_ prefix — assume it is compromised.
//
// The token is read ONLY from the server environment and is never returned
// to the browser, logged, or inlined into the bundle.

const GITHUB_API_ROOT = 'https://api.github.com';
const LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?(?:\[bot\])?$/;

function token() {
  const t = process.env.GITHUB_TOKEN;
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}

function headers() {
  const t = token();
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'github-globe-proxy',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(t ? { Authorization: `Bearer ${t}` } : {})
  };
}

async function relay(path) {
  const upstream = await fetch(`${GITHUB_API_ROOT}${path}`, { headers: headers() });
  const body = await upstream.text();
  return {
    status: upstream.status,
    body,
    contentType: upstream.headers.get('content-type') || 'application/json'
  };
}

export default async function handler(req, res) {
  try {
    // Vercel Node handler; for Netlify wrap with its event/context adapter
    // and reuse relay()/token() above.
    const url = new URL(req.url, 'http://localhost');
    // Strip the function mount point: /api/github[/...] or direct /api/... via rewrites.
    const path = url.pathname.replace(/^\/api(\/github)?/, '') || '/';

    if (path === '/status') {
      res.status(200).json({ ok: true, hasToken: Boolean(token()) });
      return;
    }

    if (path === '/events') {
      const perPage = url.searchParams.get('per_page') || '100';
      if (!/^\d+$/.test(perPage) || Number(perPage) < 1 || Number(perPage) > 100) {
        res.status(400).json({ error: 'invalid_per_page' });
        return;
      }
      const page = url.searchParams.get('page') || '1';
      if (!/^\d+$/.test(page) || Number(page) < 1 || Number(page) > 10) {
        res.status(400).json({ error: 'invalid_page' });
        return;
      }
      const r = await relay(`/events?per_page=${Number(perPage)}&page=${Number(page)}`);
      res.status(r.status).setHeader('Content-Type', r.contentType).send(r.body);
      return;
    }

    const m = path.match(/^\/users\/([^/]+)$/);
    if (m) {
      const username = decodeURIComponent(m[1]);
      if (!LOGIN_RE.test(username)) {
        res.status(400).json({ error: 'invalid_username' });
        return;
      }
      const r = await relay(`/users/${encodeURIComponent(username)}`);
      res.status(r.status).setHeader('Content-Type', r.contentType).send(r.body);
      return;
    }

    res.status(404).json({ error: 'not_found' });
  } catch (err) {
    // Deliberately generic: never echo env, headers, or upstream internals.
    console.error('[api] proxy failure:', err?.message || err);
    res.status(502).json({ error: 'proxy_failure', detail: 'Could not reach the GitHub API.' });
  }
}
