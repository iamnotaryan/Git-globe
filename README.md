# GitHub Globe

A Vite + JavaScript app that visualizes **live** GitHub activity as glowing
source → destination arcs on a 3D globe using [globe.gl](https://globe.gl) and
Three.js.

Pure black background · black globe · neon red country borders · cyan
atmosphere · short green/cyan/yellow activity spikes · animated green rings ·
glowing cyberpunk arcs (animated dashed data-packets with bloom) · live
polling · auto-rotation.

## What GitHub Globe does

- Loads world map borders and a worldwide city dataset once.
- Fetches recent public events from the GitHub Events API (`GET /events`).
- Resolves each event actor's GitHub profile location to a city (the **source**).
- Determines a legitimate **destination** (see "Interaction arcs").
- Draws the activity as short colored spikes with expanding rings.
- Draws an animated, glowing **SOURCE → DESTINATION arc** whenever both
  endpoints resolve — a curved, dashed "data packet" that travels from source
  to destination.
- **Polls** the Events API periodically and keeps adding *new* activity
  without reloading the page or recreating the globe.

## Architecture / data flow

```
vite.config.js  dev-server middleware: same-origin /api/* proxy that injects
                GITHUB_TOKEN server-side (Node only, never the browser)
server/
  githubProxy.mjs  shared server helpers: token lookup, upstream forwarding
api/
  github.js     production serverless template (Vercel/Netlify-style)
src/
  events.js   pure event-payload analysis: destinationCandidates(),
              participantFromPayload(), repoOwnerFromEvent(),
              repoLocationFromEvent()
  main.js     orchestration: globe lifecycle, polling, dedup, retention,
              source→destination resolution, points + arcs, status UI, bloom
  github.js   browser data access: calls OUR /api/* proxy (no secrets, no
              import.meta.env token); batched + cached profile fetching
  geo.js      location matching: normalization, city map index, aliases,
              country/state hints, country fallbacks
  style.css   layout (pure black) + loading overlay + live status bar
```

Data flow:

```
Browser
  ↓  GET /api/events, /api/users/:login, /api/status (same origin, no token)
Local/server API proxy (vite.config.js dev middleware, or api/github.js
serverless function in production — reads GITHUB_TOKEN server-side)
  ↓  GET api.github.com + Authorization: Bearer GITHUB_TOKEN
GitHub API
  ↓  events + profiles (token never leaves the server)
location resolver (src/geo.js, coordinates only from world_cities.json)
  ↓
Globe visualization
```

1. `main.js` loads `countries.geo.json` (borders) and `world_cities.json`
   (cities) from `public/` in parallel.
2. `buildCityIndex()` indexes all ~169k cities by normalized name once
   (including a `"City"`-name alias, e.g. "New York" ↔ "New York City").
3. The Globe is created **once** (black space, borders, atmosphere, controls,
   auto-rotation); from then on only its point/ring/arc data sets are replaced.
4. `getEvents()` fetches one page (100 events) from **our** `/api/events`
   proxy, which forwards to the GitHub Events API with the server-side token.
5. For every fresh event, `destinationCandidates()` (in `events.js`) builds an
   ordered destination list: payload participants, then the repository owner
   from `event.repo.name`.
6. Actors **and** all candidate users are collected into a single set; new
   profiles are fetched via `/api/users/:login` in small concurrent batches
   into the shared cache.
7. Each location is matched to a city via `geo.js` (exact-prefix matching,
   never substring matching). Every event whose source resolves is drawn as an
   activity spike; the **first** destination candidate that resolves to a
   different city becomes the arc's end.
8. The globe renders through a bloom post-processing pipeline
   (UnrealBloomPass + OutputPass) for a luminous cyberpunk glow on bright
   elements, most notably the animated arc dashes and their bright edges.

## Interaction arcs

Every displayed activity **attempts** to produce a SOURCE → DESTINATION arc.

**Source** — the event actor's resolved profile location. If the actor's
profile has no location (or it cannot be matched), no activity spike is drawn.

**Destination** — determined with this priority chain (first to resolve wins):

**1. Payload participant — a meaningful second GitHub user.** The payload
explicitly names another real person who differs from the actor:

- `IssuesEvent` / `IssueCommentEvent` — the issue's author
  (`payload.issue.user`), e.g. a maintainer commenting on a user's bug report.
- `PullRequestReviewEvent` — the reviewer (`payload.review.user`).
- `PullRequestReviewCommentEvent` — the commenter
  (`payload.comment.user`).
- `MemberEvent` — the collaborator the actor just added
  (`payload.member.login`): actor → new collaborator is a real interaction.
- `ReleaseEvent` — the release author (`payload.release.author`).
- `CommitCommentEvent` — the commit's commenter (`payload.comment.user`).

**2. Repository owner fallback.** If there is no payload participant (or the
participant is the actor), the repository owner is extracted from the
event-level `event.repo.name` (`"owner/repo"` — present on **every** event).
The owner is a real GitHub account, so their profile location is a legitimate
destination. This is what gives `PushEvent`, `PullRequestEvent`, `WatchEvent`,
`CreateEvent` and similar events a destination when they have no second user
in the payload:

- `PushEvent` — no second user is exposed (commit author/committer objects
  carry name and email only, no GitHub username), so the destination is the
  repository owner (if they are not the pusher themselves).
- `PullRequestEvent` — the Events API feed **omits** `pull_request.user` (and
  the PR `head` object is only `{ ref, sha, repo }`), so the PR author cannot
  be derived from the payload; the destination is the repository owner. This
  connects contributors to the owners of the projects they open PRs against.
- `IssuesEvent` — when the actor is the issue author and no other participant
  is named, this falls back to the repository owner too.

**3. Repository geographic metadata (investigated: never present).** The task
of deriving a destination from the repository itself was investigated against
the real GitHub API:

- The Events API feed's `repo` object exposes only `{ id, name, url }`.
- The REST `/repos/{owner}/{repo}` document exposes `name`, `full_name`,
  `html_url`, `description`, `topics`, … — but **no location field** exists.

GitHub therefore has **no legitimate geographic metadata for repositories**.
Repo `name`, `full_name`, `url` and search hits for it are **not** locations,
so they are never used as coordinates and no fabricated city is used. Because
a repo has no location, this fallback always resolves to nothing and the
repository owner (priority 2) is the effective repository-level destination.
The code still inspects the payload defensively (`repoLocationFromEvent()`)
and would use a genuinely provided location string if one ever appeared.

**4. No destination.** If the only candidate is the actor themselves (a user
pushing to their own repo, commenting on their own issue, etc.) or no
candidate exists, no arc is drawn and the activity spike/ring stays alone.

### Why some events still have no arc (data limitation, not a bug)

- **Actor has no profile location.** Most public-feed actors are bots or
  users who never set a location — often 70–90% of a page. Such events cannot
  even draw a source spike, let alone an arc. Active bots (`dependabot[bot]`,
  `github-actions[bot]`, `renovate[bot]`, …) dominate the feed.
- **Actor is the repository owner.** Most `PushEvent`s are owners pushing to
  their own repositories; there is no second user on the repo.
- **Destination location is unset or unmatchable.** The destination user is
  identified but their profile has no location.
- **Same resolved city.** Both endpoints resolve to the same city; a
  zero-length arc is meaningless.

Coverage is measured and reported so a shortfall is provably a data artifact:

- Console: `[sync] N fresh events -> A activities, B arcs (source location: …,
  valid destination: …, no destination: …) [noCandidate / locationUnresolved /
  sameLocation]` on every poll, plus a one-shot session
  `[coverage]` report at boot.
- Status bar: `LIVE · last update Xs ago · A activities · B arcs · C no
  destination`.

### Visual treatment

- Arc colour follows the event colour scheme: `PushEvent` **green**, 
  `PullRequestEvent` **cyan**, `WatchEvent` **yellow**, all others **white**
  — never all one colour.
- Each arc is a **gradient** from a dim tail to a bright head (the leading
  edge of the data packet), rendered as a tube with animated dashed gaps that
  travel source → destination (`arcDashLength`, `arcDashGap`,
  `arcDashAnimateTime`).
- A screen-space bloom pass (UnrealBloomPass + OutputPass) makes the bright
  dashes, spikes, rings and borders glow against the black canvas. Only
  pixels brighter than a luminance threshold bloom, so empty space stays pure
  black.
- Arc altitude is derived from the great-circle distance with a floor
  (~0.08 globe-radii) so short connections stay close to Earth but still arch,
  and a cap (0.45) so long connections never balloon far from the globe.

## Black background

The renderer's default clear color is a dark navy (`#000011`) which reads as
"blue space"; we explicitly set all of:

- `backgroundColor('#000000')` on the Globe (the renderer clear color),
- `background: #000000` on `html`, `body` and `#globeViz` in CSS.

The only cyan glow on the page is the intentionally colored atmosphere around
the globe — everything else is pure black.

## Series: source → destination resolution

- A destination is resolved **once per event** in priority order; `main.js`
  walks the candidate list and stops at the first endpoint that resolves to a
  different city. This maximizes **real** arcs: if the highest-priority user
  has no location, the repository owner is still tried.
- No coordinates are ever invented; if nothing resolves, the activity keeps
  its point/ring and simply has no arc.

## Live polling

- Polls `GET /api/events` (proxied to GitHub `GET /events`) every **60 seconds**.
- Polls never overlap: the next poll is scheduled only after the previous one
  finishes.
- Each poll is cheap: one events request, plus profile requests **only** for
  usernames never seen before (actors, participants, and repo owners all use
  the same cache).
- Events already on the globe are skipped by their stable `event.id`, so
  repeated polls don't create duplicates. When a fresh event arrives:
  dedupe → resolve source profile (cache) → pick destination → resolve its
  profile/location (cache) → create point/ring → create arc if valid → update
  the existing Globe instance. The Globe, country polygons and camera are
  never recreated or reset.
- On a 401/403 (e.g. rate limit) the interval doubles up to a 5-minute
  ceiling; on the next success it resets to 60s. Existing activity stays
  visible the whole time.

## Profile caching

- `profileCache` (a `Map`) remembers every resolved user's `location`.
- A profile is fetched **once per page lifetime** — actors, payload
  participants, and repository owners are all fetched through the same cache.
  Recurring users in later polls reuse the cached location with zero network
  cost.
- Profiles without a location are cached as `null` (no point) and never
  refetched, keeping API usage conservative.
- A single failed profile fetch never breaks the pipeline: 404s are cached as
  `null`, other errors are logged (without secrets) and retried naturally on
  the next poll. 401/403 back off the polling interval instead of failing.

## Event deduplication

- Each raw GitHub event has a unique `id` used as the activity's primary key
  (fallback: `login:eventType:created_at`).
- A `Map` keyed by event id ensures a given event can never appear twice, even
  if the API returns it across multiple polls.
- Arc map uses the same event id, so a redelivered event can never create a
  duplicate arc.
- Deduplication is by **event id**, not by username, because one user can
  legitimately generate multiple activities.

## Activity & arc retention

- `MAX_ACTIVITIES` (200) caps how many points/rings the browser holds.
- `MAX_ARCS` (200) matches `MAX_ACTIVITIES` so arcs are never evicted before
  their source activity — every visible point can have an active arc.
- When a cap is exceeded, the **oldest** entries (by `created_at`) are dropped
  and the newest are kept.
- The limits are named constants in `main.js` and easy to change.

## API rate-limit strategy

- Uses a single page of events (no deep pagination).
- Batches profile requests 10 at a time with a small delay between batches.
- Skips profile requests for cached actors entirely.
- Backs off its polling interval on 401/403 and keeps old data on screen.
- One request per poll in steady state.

## Location matching

- Exact city-name matching (longest prefix), **never** substring matching —
  `"New York, NY"` can never resolve to a random city called `York`.
- Normalization: lowercase, accent/diacritic stripping, separator collapsing
  (`"São Paulo"` ↔ `"sao paulo"`).
- `"City"`-name aliases are indexed too, so `"New York, NY"` resolves to the
  canonical `"New York City"` entry in the dataset (same real coordinates).
- Country hints (`"Delhi, India"` → India) and US state hints
  (`"San Francisco, CA"` → US) disambiguate same-named cities.
- Bare ambiguous names prefer a canonical country (`London` → UK,
  `Paris` → FR) without overriding region-specific entries
  (`"London, ON"` still resolves to Canada).
- Country-only locations use a per-country fallback to a major city
  (e.g. `"United States"` → Chicago).
- Coordinates always come from `world_cities.json`; nothing is hardcoded.
- Unresolvable locations are skipped (no point, no arc) — coordinates are
  never invented or approximated.

## Arc tooltip

Hovering an arc shows a concise label:

```
GitHub activity
SOURCE → DESTINATION
EVENT TYPE
```

(e.g. `alice → bob` / `IssuesEvent`)

## Local setup

```bash
npm install

# Create your local server-side token file
cp .env.example .env
# then put your token in .env:
#   GITHUB_TOKEN=your_token_here

npm run dev
```

Scripts:

- `npm run dev` — start the Vite dev server **with** the `/api` GitHub proxy
- `npm run build` — production build (contains no token)
- `npm run preview` — preview the production build locally (note: `preview`
  does not serve `/api`; use `dev` for live data, or deploy `api/github.js`)

Without a token the app still runs: the proxy forwards unauthenticated and
GitHub applies its 60 requests/hour/IP limit, so the globe may stay sparse.
The status bar reports `no GITHUB_TOKEN — unauthenticated limits (60 req/h)`.

## GitHub token setup

Put a token in `.env`:

```
GITHUB_TOKEN=your_token_here
```

- Server-only: read by `vite.config.js` / `server/githubProxy.mjs` from the
  server environment. The browser calls only `/api/*` and never sees it.
- Use a **fine-grained** personal access token with minimum scopes
  (public-read only; no repo/admin permissions needed).
- The token is never logged and never returned to the browser — `/api/status`
  reports only a `hasToken` boolean.
- If you previously used `VITE_GITHUB_TOKEN`, **rotate/revoke that token
  now**: anything with a `VITE_` prefix was inlined into client JavaScript
  and must be assumed compromised.

## Security model (IMPORTANT)

- The browser must NEVER receive the GitHub token.
- `VITE_*` variables are inlined by Vite into the client bundle — never put
  secrets in them. This codebase contains zero `import.meta.env` token reads.
- Local dev: `npm run dev` serves the `/api` proxy from `vite.config.js`;
  the token stays in server process memory.
- Production: deploy `api/github.js` (or an equivalent adapter) on a
  serverless platform and store `GITHUB_TOKEN` in its secrets manager —
  never in the bundle. See "Production deployment" below.
- Verify any build with: no `VITE_GITHUB_TOKEN` in `src/`, and no token
  string in `dist/assets/*.js`.

### Production deployment

This repository is Vite-only; there is no long-lived production backend
checked in. Before any public deployment:

1. Deploy `api/github.js` as a serverless function mapped to `/api/*`:
   - **Vercel:** `api/github.js` is picked up automatically; add a rewrite
     so `/api/:path*` reaches it (or rename/split per your routing).
   - **Netlify:** adapt the handler to a Netlify Function and add a redirect
     from `/api/*` to `/.netlify/functions/github`.
   - **Alternatives:** any tiny Node/Express/Cloudflare-Workers service that
     reuses `server/githubProxy.mjs` (`forwardToGitHub` + `getGithubToken`)
     works the same way.
2. Set `GITHUB_TOKEN` in the platform's secrets manager (never in source).
3. Serve the built frontend (`npm run build` → `dist/`) from the same origin
   so the browser's `/api/*` calls stay same-origin (CORS-restricted by
   default). If the API lives on another origin, set `VITE_API_BASE` to its
   plain origin URL at build time (a URL, never a secret) and allow only your
   frontend origin via CORS.
4. Alternatively, adopt a GitHub OAuth App flow so users authenticate
   themselves and no static token exists at all.

The old client-side `VITE_GITHUB_TOKEN` approach must not be used for public
production deployment.