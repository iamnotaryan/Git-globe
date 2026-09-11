# GitHub Globe

A Vite + JavaScript app that visualizes live GitHub activity as glowing points
on a 3D globe using [globe.gl](https://globe.gl) and Three.js.

## How it works

1. Fetches one page of recent public events from the GitHub Events API
   (`GET /events`, up to 100 events).
2. Deduplicates actors so each GitHub user is fetched only once, then fetches
   their profiles concurrently in small batches.
3. Matches each profile's free-text `location` to a city in
   `public/world_cities.json` using **exact city-name matching** (longest
   prefix, accent/diacritic normalization), with a country-level fallback.
4. Renders the matched users on the globe with per-event-type colors, neon
   country borders, and activity rings.

## Getting started

```bash
npm install

# Optional: create your local token file
cp .env.example .env

npm run dev
```

If no token is set, the app still runs but GitHub will apply the
unauthenticated rate limit (60 requests/hour / IP), so the globe may end up
empty.

## Scripts

- `npm run dev` — start the Vite dev server
- `npm run build` — production build
- `npm run preview` — preview the production build locally

## Security limitation (IMPORTANT)

The GitHub token is read from `VITE_GITHUB_TOKEN`. Vite inlines every `VITE_*`
environment variable into the client-side JavaScript bundle, which means the
token is **visible to anyone who opens the page** — it is exposed to the
browser by design.

This project deliberately targets local development only:

- Use a **fine-grained** token with the **minimum scopes** the app needs.
- NEVER deploy this app as-is with a real token; assume the token is public.
- Before shipping to production, rotate the token and move API calls behind a
  server (e.g. a serverless function / proxy) that injects the token
  server-side, or switch to an OAuth app flow. The client should never hold
  credentials.

## Location matching notes

- Matching is exact, never substring-based, so `"New York, NY"` cannot resolve
  to a city merely called `York`.
- Names are normalized (lowercase, accents stripped, separators collapsed).
- When several cities share a name, a country hint in the location (e.g.
  `"Delhi, India"`) prefers the matching country.
- If no city matches, a small per-country fallback maps the country name to a
  major city (e.g. `"United States"` → Chicago). Coordinates always come from
  `world_cities.json`, never hardcoded.
- Locations whose city is not in `world_cities.json` are skipped.