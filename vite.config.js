import { defineConfig, loadEnv } from 'vite';
import { forwardToGitHub, getGithubToken } from './server/githubProxy.mjs';

const LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?(?:\[bot\])?$/;

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v != null) res.setHeader(k, String(v));
  }
  res.end(body);
}

function relayUpstream(res, result) {
  res.statusCode = result.status;
  res.setHeader('Content-Type', result.contentType);
  if (result.rateLimit.limit) res.setHeader('x-ratelimit-limit', result.rateLimit.limit);
  if (result.rateLimit.remaining) res.setHeader('x-ratelimit-remaining', result.rateLimit.remaining);
  if (result.rateLimit.reset) res.setHeader('x-ratelimit-reset', result.rateLimit.reset);
  res.end(result.bodyText);
}

// Local dev API proxy: the browser calls /api/* on the Vite origin; this
// middleware injects GITHUB_TOKEN server-side and forwards to api.github.com.
// The token never reaches client JavaScript.
function githubProxyPlugin() {
  return {
    name: 'github-globe-api-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        let url;
        try {
          url = new URL(req.url, 'http://localhost');
        } catch {
          next();
          return;
        }

        if (req.method !== 'GET') {
          if (url.pathname.startsWith('/api/')) {
            sendJson(res, 405, { error: 'method_not_allowed' });
            return;
          }
          next();
          return;
        }

        // loadEnv() already merged .env into process.env, so the server-side
        // GITHUB_TOKEN (no VITE_ prefix) is available here per request. This
        // picks up .env edits without a dev-server restart for the token.
        const token = getGithubToken(process.env);

        if (url.pathname === '/api/status') {
          sendJson(res, 200, {
            ok: true,
            hasToken: Boolean(token),
            hint: token
              ? undefined
              : 'Set GITHUB_TOKEN in .env (server-only) and restart `npm run dev` for authenticated rate limits.'
          });
          return;
        }

        if (url.pathname === '/api/events') {
          const perPage = url.searchParams.get('per_page') || '100';
          if (!/^\d+$/.test(perPage) || Number(perPage) < 1 || Number(perPage) > 100) {
            sendJson(res, 400, { error: 'invalid_per_page' });
            return;
          }
          try {
            const result = await forwardToGitHub(`/events?per_page=${Number(perPage)}`, token);
            relayUpstream(res, result);
          } catch (err) {
            console.error('[api/events] proxy failure:', err?.message || err);
            sendJson(res, 502, { error: 'proxy_failure', detail: 'Could not reach the GitHub API.' });
          }
          return;
        }

        const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
        if (url.pathname.startsWith('/api/users/')) {
          if (!userMatch) {
            sendJson(res, 404, { error: 'not_found' });
            return;
          }
          const username = decodeURIComponent(userMatch[1]);
          if (!LOGIN_RE.test(username)) {
            sendJson(res, 400, { error: 'invalid_username' });
            return;
          }
          try {
            const result = await forwardToGitHub(`/users/${encodeURIComponent(username)}`, token);
            relayUpstream(res, result);
          } catch (err) {
            console.error('[api/users] proxy failure:', err?.message || err);
            sendJson(res, 502, { error: 'proxy_failure', detail: 'Could not reach the GitHub API.' });
          }
          return;
        }

        // Unknown /api/* path: answer JSON, never fall through to the SPA
        // fallback (which would serve index.html with a 200 status).
        if (url.pathname.startsWith('/api/')) {
          sendJson(res, 404, { error: 'not_found' });
          return;
        }

        next();
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  // Load server-only env (including non-VITE_ vars like GITHUB_TOKEN) from
  // .env files into process.env for the dev middleware above. Client-side
  // exposure is unchanged: only VITE_* vars are inlined into the bundle.
  const env = loadEnv(mode, process.cwd(), '');
  for (const [key, value] of Object.entries(env)) {
    if (!(key in process.env)) process.env[key] = value;
  }

  return {
    plugins: [githubProxyPlugin()]
  };
});
