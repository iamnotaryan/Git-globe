import './style.css';
import Globe from 'globe.gl';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GitHubApiError, getApiStatus, getEvents, fetchUsers } from './github.js';
import { destinationCandidates } from './events.js';
import { buildCityIndex, matchLocation } from './geo.js';
import { normalizeEvent } from './eventDetails.js';
import { createHoverCard, createSelectedPanel } from './eventCard.js';

// -------------------------
// Constants
// -------------------------

// How often to poll the GitHub Events API for new activity. One request per
// poll, plus profile requests only for actors never seen before.
const BASE_POLL_INTERVAL_MS = 60_000;

// If GitHub reports 401/403 (e.g. rate limit), the interval doubles each
// failed poll until it reaches this ceiling, then resets on the next success.
const MAX_POLL_INTERVAL_MS = 5 * 60_000;

// Keep the newest activities on the globe only.
const MAX_ACTIVITIES = 200;

// Every activity attempts to produce an arc, so arcs can legitimately reach
// the activity cap. Matching the cap means a valid arc is never evicted while
// its activity point is still on display.
const MAX_ARCS = MAX_ACTIVITIES;

// UnrealBloomPass tuning for the cyberpunk glow. Threshold keeps the dark
// globe surface and dim colors from blooming while bright colors/packets pop.
const BLOOM = {
  strength: 0.9,
  radius: 0.7,
  threshold: 0.35
};

// -------------------------
// DOM references
// -------------------------

const overlay = document.getElementById('overlay');
const overlayMessage = document.getElementById('overlayMessage');
const statusEl = document.getElementById('status');
const statusState = document.getElementById('statusState');
const statusDetail = document.getElementById('statusDetail');

// -------------------------
// App state
// -------------------------

let globe = null;
let cityIndex = null;

// username -> location string, or null when the profile was resolved but has
// no location. Profiles are fetched once per page lifetime.
const profileCache = new Map();

// event id -> activity point. A Map is used so keys deduplicate events and
// insertion order tracks recency for the activity limit.
const activityMap = new Map();

// event id -> arc. Shares its key with the matching activity point, so the
// same dedup logic applies; retained separately with its own cap.
const arcMap = new Map();

let pollIntervalMs = BASE_POLL_INTERVAL_MS;
let lastUpdateAt = null;
let updating = false;
let warning = null;
// Persistent, non-blocking setup notice (missing token / missing proxy).
// Never a crash: the globe keeps showing the last known good state.
let setupNotice = null;

// -------------------------
// Event inspection state (centralized rotation + selection)
// -------------------------

// event id -> normalized event record (from eventDetails.normalizeEvent).
// Retained independently of the render caps so a selected event stays
// inspectable even while points/arcs rotate out; pruned lazily.
const eventStore = new Map();

let selectedEventId = null;
let isRotationPaused = false;
let hoverCard = null;
let selectedPanel = null;

// Last known pointer position (globe.gl hover callbacks carry no MouseEvent).
const lastPointer = { x: 0, y: 0 };
// Pointer-down position to distinguish a real click from a globe drag.
let pointerDownPos = null;

function startRotation() {
  isRotationPaused = false;
  if (globe) {
    try {
      globe.controls().autoRotate = true;
    } catch {
      // Controls unavailable (e.g. during teardown) — safe to ignore.
    }
  }
}

function stopRotation() {
  isRotationPaused = true;
  if (globe) {
    try {
      globe.controls().autoRotate = false;
    } catch {
      // Controls unavailable — safe to ignore.
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -------------------------
// Loading overlay
// -------------------------

function showOverlay(message, isError = false) {
  overlay.classList.toggle('error', isError);
  overlayMessage.textContent = message;
  overlay.classList.remove('hidden');
}

function hideOverlay() {
  overlay.classList.add('hidden');
}

// -------------------------
// Data loading
// -------------------------

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url} (${response.status})`);
  }
  return response.json();
}

async function loadGeoData() {
  const [countries, cities] = await Promise.all([
    fetchJson('/countries.geo.json'),
    fetchJson('/world_cities.json')
  ]);
  return { countries, cities };
}

// -------------------------
// Globe
// -------------------------

// Event colors. Everything not listed falls back to white "other" events, so
// arcs keep a varied, cyberpunk palette instead of being all one color.
const EVENT_COLORS = {
  PushEvent: '#00ff88',
  PullRequestEvent: '#00ffff',
  WatchEvent: '#ffff00'
};

function colorForEvent(eventType) {
  return EVENT_COLORS[eventType] || '#ffffff';
}

// Arc color gradient (tail -> head) so the leading edge of the data packet
// glows brighter than the trail. Cached per event type.
const ARC_COLOR_CACHE = new Map();

// Bright white gradient reserved for the selected arc so it pops.
const SELECTED_ARC_COLORS = ['#555555', '#ffffff'];

function arcColorFor(eventType) {
  let colors = ARC_COLOR_CACHE.get(eventType);
  if (!colors) {
    const head = new THREE.Color(colorForEvent(eventType));
    const tail = head.clone().multiplyScalar(0.35);
    colors = [`#${tail.getHexString()}`, `#${head.getHexString()}`];
    ARC_COLOR_CACHE.set(eventType, colors);
  }
  return colors;
}

// Create the Globe once. From then on only pointsData/ringsData/arcsData are
// replaced, so country polygons, atmosphere, controls and auto-rotation are
// preserved.
function createGlobe(countries) {
  const globeInstance = Globe()

    // Pure black space around the globe (the renderer default is a dark navy
    // '#000011' which reads as "blue space" once bloom is enabled).
    .backgroundColor('#000000')

    .pointsData([])

    .pointLat('lat')

    .pointLng('lng')

    // Short, clean activity spikes: pointAltitude is in units of globe radius
    // (default 0.1 creates tall candles), pointRadius in angular degrees.
    .pointAltitude(0.02)

    // Selected point renders slightly larger so selection is visible.
    .pointRadius((d) => (d.eventId && d.eventId === selectedEventId ? 0.55 : 0.3))

    .pointColor((d) =>
      d.eventId && d.eventId === selectedEventId ? '#ffffff' : colorForEvent(d.eventType)
    )

    // Country borders
    .polygonsData(countries.features)

    .polygonCapColor(() => '#000000')

    .polygonSideColor(() => 'rgba(4, 4, 4, 0)')

    .polygonStrokeColor(() => '#f44242b1')

    .polygonAltitude(0.005)

    // Activity rings
    .ringsData([])

    // Preserved green pulse; the selected event pulses white instead.
    .ringColor((d) =>
      d.eventId && d.eventId === selectedEventId ? '#ffffff' : '#00ff88'
    )

    .ringMaxRadius(4)

    .ringPropagationSpeed(3)

    .ringRepeatPeriod(1200)

    // Interaction arcs: SOURCE ● ╲ ╲ ╲ ╲● DESTINATION
    .arcsData([])

    .arcStartLat('startLat')

    .arcStartLng('startLng')

    .arcEndLat('endLat')

    .arcEndLng('endLng')

    .arcColor((d) =>
      d.eventId && d.eventId === selectedEventId
        ? SELECTED_ARC_COLORS
        : arcColorFor(d.eventType)
    )

    .arcAltitude((d) => arcAltitudeFor(d))

    .arcAltitudeAutoScale(false)

    .arcStroke((d) => (d.eventId && d.eventId === selectedEventId ? 1.4 : 0.6))

    .arcCurveResolution(64)

    .arcDashLength(0.35)

    .arcDashGap(0.2)

    .arcDashInitialGap(0.05)

    .arcDashAnimateTime(2800)

    // Built-in globe.gl tooltips are disabled (null = no tooltip); the custom
    // floating hover card below is the single tooltip surface.
    .arcLabel(() => null)

    // Tooltip
    .pointLabel(() => null)

    // Point + arc inspection (hover = temporary card, click = select/freeze).
    .onPointHover(handlePointHover)

    .onPointClick(handlePointClick)

    .onArcHover(handleArcHover)

    .onArcClick(handleArcClick);

  globeInstance.globeMaterial().color.set('#000000');

  globeInstance.atmosphereColor('#1aebe4');

  globeInstance.atmosphereAltitude(0.15);

  globeInstance(document.getElementById('globeViz'));

  globeInstance.controls().autoRotate = true;

  globeInstance.controls().autoRotateSpeed = 0.5;

  setupGlow(globeInstance);

  return globeInstance;
}

// Add a screen-space bloom pass so every bright element — most importantly
// the animated arc dashes — renders with a luminous glow.
//
// globe.gl always renders through an EffectComposer (a RenderPass exists by
// default) and exposes it via postProcessingComposer(). We append the bloom
// pass and a final color-space pass to that existing composer. The render
// order becomes RenderPass -> UnrealBloomPass -> OutputPass, which is exactly
// the classic three.js bloom pipeline. globe.gl keeps driving composer.render()
// per frame itself — camera, auto-rotation and controls are untouched, and the
// composer is resized automatically by three-render-objects.
function setupGlow(instance) {
  try {
    const composer = instance.postProcessingComposer();
    if (!composer) return;

    const renderer = instance.renderer();
    const resolution = new THREE.Vector2();
    renderer.getDrawingBufferSize(resolution);

    composer.addPass(new UnrealBloomPass(
      resolution,
      BLOOM.strength,
      BLOOM.radius,
      BLOOM.threshold
    ));
    composer.addPass(new OutputPass());
  } catch (err) {
    console.error('Failed to enable bloom glow; continuing without it.', err);
  }
}

// Push the current activity points and arcs onto the existing Globe instance.
function updateGlobe() {
  if (!globe) return;

  const activities = [...activityMap.values()];
  const arcs = [...arcMap.values()];

  globe.pointsData(activities);
  globe.ringsData(activities);
  globe.arcsData(arcs);
}

// Re-apply the same data arrays so globe.gl re-evaluates the selected-aware
// color/radius/stroke accessors. Cheap UI/state update: no refetch, no Globe
// rebuild, no polling restart.
function refreshHighlights() {
  updateGlobe();
}

// -------------------------
// Event inspection: hover vs click/selection
// -------------------------

function normForPoint(d) {
  if (!d) return null;
  if (d.eventId) return eventStore.get(d.eventId) || null;
  if (d.id) return eventStore.get(d.id) || null;
  return null;
}

function normForArc(d) {
  if (!d) return null;
  if (d.eventId) return eventStore.get(d.eventId) || null;
  return null;
}

// True when the native click event looks like the end of a globe drag rather
// than a deliberate tap on a point/arc.
function isDragClick(nativeEvent) {
  if (!nativeEvent || !pointerDownPos) return false;
  const x = nativeEvent.clientX;
  const y = nativeEvent.clientY;
  if (typeof x !== 'number' || typeof y !== 'number') return false;
  const dx = x - pointerDownPos.x;
  const dy = y - pointerDownPos.y;
  return Math.hypot(dx, dy) > 6;
}

// HOVER (temporary, lightweight): show a floating card near the cursor while
// the pointer is over a point. Disappears on leave; never touches selection
// or rotation state.
function handlePointHover(point) {
  const container = globe ? globe.renderer().domElement : null;
  if (!point) {
    hoverCard?.hide();
    if (container) container.style.cursor = '';
    return;
  }
  const norm = normForPoint(point);
  if (!norm || !hoverCard) return;
  hoverCard.show(norm, colorForEvent(norm.eventType), lastPointer.x, lastPointer.y);
  if (container) container.style.cursor = 'pointer';
}

// CLICK (persistent): select the event, freeze rotation, and pin the details
// panel. Clicking another event replaces the selection; the globe stays
// paused until the user closes the panel (or presses Escape).
function handlePointClick(point, nativeEvent) {
  if (!point) return;
  if (isDragClick(nativeEvent)) return;
  const eventId = point.eventId ?? point.id;
  if (!eventId) return;
  selectEvent(eventId);
}

function handleArcHover(arc) {
  const container = globe ? globe.renderer().domElement : null;
  if (!arc) {
    hoverCard?.hide();
    if (container) container.style.cursor = '';
    return;
  }
  const norm = normForArc(arc);
  if (!norm || !hoverCard) return;
  hoverCard.show(norm, colorForEvent(norm.eventType), lastPointer.x, lastPointer.y);
  if (container) container.style.cursor = 'pointer';
}

function handleArcClick(arc, nativeEvent) {
  if (!arc) return;
  if (isDragClick(nativeEvent)) return;
  if (!arc.eventId) return;
  selectEvent(arc.eventId);
}

function selectEvent(eventId) {
  const norm = eventStore.get(eventId);
  if (!norm) return;
  selectedEventId = eventId;
  hoverCard?.hide();
  stopRotation();
  selectedPanel?.show(norm, colorForEvent(norm.eventType));
  refreshHighlights();
}

function clearSelection() {
  selectedEventId = null;
  selectedPanel?.hide();
  hoverCard?.hide();
  startRotation();
  refreshHighlights();
}

function setupInspectionUi() {
  hoverCard = createHoverCard();
  selectedPanel = createSelectedPanel({ onClose: () => clearSelection() });

  window.addEventListener(
    'mousemove',
    (e) => {
      lastPointer.x = e.clientX;
      lastPointer.y = e.clientY;
      hoverCard?.move(e.clientX, e.clientY);
    },
    { passive: true }
  );

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selectedEventId !== null) {
      clearSelection();
    }
  });
}

function setupClickGuards() {
  if (!globe) return;
  try {
    const el = globe.renderer().domElement;
    el.addEventListener(
      'pointerdown',
      (e) => {
        pointerDownPos = { x: e.clientX, y: e.clientY };
      },
      { passive: true }
    );
    window.addEventListener('pointerup', () => {
      // Cleared on next frame so click handlers still see the drag distance.
      setTimeout(() => {
        pointerDownPos = null;
      }, 0);
    });
  } catch {
    // Renderer unavailable — click-vs-drag guard simply stays inactive.
  }
}

// -------------------------
// Activity resolution
// -------------------------

// Build a stable identifier for a raw GitHub event.
function eventKey(event) {
  return event.id ?? `${event.actor?.login}:${event.type}:${event.created_at}`;
}

// Great-circle distance between two coordinates, in radians on a unit sphere.
// Used to scale arc altitude so short connections stay afloat and long ones
// don't fly too far from the globe.
function greatCircleDistance(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(a));
}

// Arc altitude in units of globe radius. A floor keeps same-country/
// short-distance connections visibly arched instead of hugging the surface; a
// cap stops long arcs from ballooning unrealistically high. Long connections
// naturally rise higher, short ones stay close to Earth.
function arcAltitudeFor(arc) {
  const distanceRad = arc.distance || 0;
  return Math.min(Math.max(0.08 + distanceRad * 0.35, 0.08), 0.45);
}

// Turn fresh GitHub events into activity points and arcs. Locations come from
// the shared profile cache; missing profiles are fetched (once) before matching.
//
// Every displayed activity attempts a real SOURCE -> DESTINATION arc. The
// destination is chosen in priority order (see events.js): a payload
// participant, then the repository owner, then an (always-absent) repository
// location. We take the FIRST candidate that resolves to a location different
// from the source — coordinates never come from invented or arbitrary data.
async function resolveActivity(events) {
  const usernames = new Set();
  for (const event of events) {
    const actor = event.actor?.login;
    if (actor) usernames.add(actor);

    // Gather every candidate user up front so a single batched fetch covers
    // participants, repository owners and actors alike (shared profile cache).
    for (const candidate of destinationCandidates(event)) {
      if (candidate.kind === 'user') usernames.add(candidate.username);
    }
  }

  await fetchUsers([...usernames], profileCache);

  const points = [];
  const arcs = [];
  // Coverage metrics, reported per sync and used for the session report.
  const metrics = { sourceLocated: 0, destinationResolved: 0, noDestination: 0 };
  // Activities resolved into a point but with no drawable arc, by reason.
  const noArcReasons = { noCandidate: 0, locationUnresolved: 0, sameLocation: 0 };

  for (const event of events) {
    const login = event.actor?.login;
    if (!login) continue;

    const location = profileCache.get(login);
    if (!location) continue;

    const point = matchLocation(location, cityIndex);
    if (!point) continue;

    metrics.sourceLocated++;

    const createdAt = Date.parse(event.created_at) || Date.now();
    const id = eventKey(event);

    // Normalized record for hover/click inspection. Stored once per event id
    // so cards render from already-loaded data (zero extra API calls).
    try {
      eventStore.set(id, normalizeEvent(event));
    } catch {
      // A malformed event must never break the sync loop.
    }

    points.push({
      id,
      eventId: id,
      username: login,
      eventType: event.type,
      lat: point.lat,
      lng: point.lng,
      city: point.city,
      createdAt
    });

    // Walk the priority chain and use the first candidate that resolves to a
    // different city. This maximizes legitimate coverage without ever
    // inventing a destination for a source with nobody to connect to.
    const candidates = destinationCandidates(event);
    let destination = null;
    let candidateResolved = false;

    for (const candidate of candidates) {
      let destinationLocation = null;

      if (candidate.kind === 'user') {
        const destinationLocationString = profileCache.get(candidate.username);
        destinationLocation = destinationLocationString
          ? matchLocation(destinationLocationString, cityIndex)
          : null;
      } else {
        destinationLocation = matchLocation(candidate.location, cityIndex);
      }

      if (!destinationLocation) continue;
      candidateResolved = true;

      const distance = greatCircleDistance(
        point.lat,
        point.lng,
        destinationLocation.lat,
        destinationLocation.lng
      );

      if (distance < 1e-6) continue; // same resolved city: zero-length arc

      const destinationUsername =
        candidate.kind === 'user' ? candidate.username : null;

      destination = {
        label: candidate.kind === 'user' ? candidate.username : 'repository',
        username: destinationUsername,
        lat: destinationLocation.lat,
        lng: destinationLocation.lng,
        city: destinationLocation.city,
        distance
      };
      break;
    }

    if (!destination) {
      // The activity point/ring stays visible even though the connection
      // could not be drawn.
      if (candidateResolved) noArcReasons.sameLocation++;
      else noArcReasons[candidates.length ? 'locationUnresolved' : 'noCandidate']++;
      metrics.noDestination++;
      continue;
    }

    metrics.destinationResolved++;

    arcs.push({
      eventId: id,
      eventType: event.type,
      username: login,
      destinationUsername: destination.username,
      destinationLabel: destination.label,
      startLat: point.lat,
      startLng: point.lng,
      endLat: destination.lat,
      endLng: destination.lng,
      distance: destination.distance,
      createdAt,
      city: point.city,
      destinationCity: destination.city
    });
  }

  return { points, arcs, metrics, noArcReasons };
}

// Merge new points into the activity map, dropping the oldest beyond the cap.
function addActivities(newPoints) {
  for (const point of newPoints) {
    activityMap.set(point.id, point);
  }

  if (activityMap.size > MAX_ACTIVITIES) {
    const newest = [...activityMap.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ACTIVITIES);

    activityMap.clear();
    for (const point of newest) activityMap.set(point.id, point);
  }

  pruneEventStore();

  updateGlobe();
}

// Merge new arcs into the arc map, dropping the oldest beyond the cap.
// Arcs are keyed by their event's stable id, so a redelivered event can never
// create a duplicate arc.
function addArcs(newArcs) {
  for (const arc of newArcs) {
    arcMap.set(arc.eventId, arc);
  }

  if (arcMap.size > MAX_ARCS) {
    const newest = [...arcMap.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ARCS);

    arcMap.clear();
    for (const arc of newest) arcMap.set(arc.eventId, arc);
  }

  pruneEventStore();

  updateGlobe();
}

// Keep the inspection store bounded without dropping the selected event: live
// points/arcs stay inspectable immediately, and an evicted selection keeps its
// panel (with stored data) until the user dismisses it.
function pruneEventStore() {
  const live = new Set([...activityMap.keys(), ...arcMap.keys()]);
  if (selectedEventId !== null) live.add(selectedEventId);
  for (const key of [...eventStore.keys()]) {
    if (!live.has(key)) eventStore.delete(key);
  }
  // Hard cap as a backstop (e.g. many location-less events normalizing
  // without ever entering the activity map).
  const HARD_CAP = MAX_ACTIVITIES + MAX_ARCS + 50;
  if (eventStore.size > HARD_CAP) {
    const keys = [...eventStore.keys()];
    for (let i = 0; i < eventStore.size - HARD_CAP; i++) {
      if (keys[i] !== selectedEventId) eventStore.delete(keys[i]);
    }
  }
}

// One full sync: fetch events, drop anything already on the globe, resolve the
// rest into points and arcs. Throws GitHubApiError when GitHub is unreachable.
async function refreshActivity() {
  const events = await getEvents();

  const seen = new Set(activityMap.keys());
  const freshEvents = events.filter((event) => !seen.has(eventKey(event)));

  if (freshEvents.length === 0) return;

  const { points, arcs, metrics, noArcReasons } = await resolveActivity(freshEvents);
  if (points.length) addActivities(points);
  if (arcs.length) addArcs(arcs);

  const reasons = Object.entries(noArcReasons)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');

  console.log(
    `[sync] ${freshEvents.length} fresh events -> ${points.length} activities, ` +
      `${arcs.length} arcs ` +
      `(source location: ${metrics.sourceLocated}, valid destination: ` +
      `${metrics.destinationResolved}, no destination: ${metrics.noDestination})` +
      (reasons ? ` [${reasons}]` : '')
  );
}

// Print a session-level coverage report so it is clear whether remaining gaps
// are a GitHub data limitation rather than a bug.
function reportCoverage() {
  const activities = activityMap.size;
  const arcs = arcMap.size;
  console.log('[coverage] Activities: ' + activities);
  console.log('[coverage] Activities with source locations: ' + activities);
  console.log('[coverage] Activities with valid destinations: ' + arcs);
  console.log('[coverage] Arcs rendered: ' + arcs);
  console.log('[coverage] Activities without valid destinations: ' + (activities - arcs));
}

// -------------------------
// Polling
// -------------------------

// A single poll attempt. On failure the interval backs off; on success it
// resets. Because startPolling awaits this, polls never overlap.
async function pollOnce() {
  updating = true;
  setStatus();

  try {
    await refreshActivity();
    pollIntervalMs = BASE_POLL_INTERVAL_MS;
    lastUpdateAt = Date.now();
    warning = null;
  } catch (err) {
    console.error('GitHub activity poll failed:', err);
    warning = err instanceof GitHubApiError ? err.message : 'GitHub API unreachable';
    pollIntervalMs = Math.min(pollIntervalMs * 2, MAX_POLL_INTERVAL_MS);
  } finally {
    updating = false;
    setStatus();
  }
}

async function startPolling() {
  // Infinite loop; each iteration waits first, so requests never overlap and
  // the back-off interval is respected automatically.
  for (;;) {
    await sleep(pollIntervalMs);
    await pollOnce();
  }
}

// -------------------------
// Live status UI
// -------------------------

function setStatus() {
  statusEl.classList.toggle('updating', updating);
  statusEl.classList.toggle('warning', Boolean(warning));

  statusState.textContent = warning ? 'TEMPORARY ERROR' : 'LIVE';

  let detail = '';
  if (lastUpdateAt !== null) {
    const seconds = Math.max(0, Math.round((Date.now() - lastUpdateAt) / 1000));
    detail += `last update ${seconds}s ago · `;
  }
  detail += `${activityMap.size} activities · ${arcMap.size} arcs · ${activityMap.size - arcMap.size} no destination`;

  if (warning) detail += ` · retrying`;

  if (setupNotice) detail += ` · ${setupNotice}`;

  statusDetail.textContent = detail;
}

// Check the server proxy configuration once at boot. Never throws: a missing
// token or missing proxy only produces a status hint — the globe keeps
// whatever data it can load (unauthenticated GitHub limits still apply).
async function checkApiStatus() {
  try {
    const status = await getApiStatus();
    if (!status) {
      setupNotice = 'API proxy unreachable — run via `npm run dev` or deploy /api (see README)';
      console.warn('GitHub Globe: ' + setupNotice);
    } else if (!status.hasToken) {
      setupNotice = 'no GITHUB_TOKEN — unauthenticated limits (60 req/h)';
      console.warn(
        'GitHub Globe: no server GITHUB_TOKEN configured; using unauthenticated GitHub rate limits. ' +
          'Set GITHUB_TOKEN in .env (server-only, never VITE_*) and restart `npm run dev`.'
      );
    } else {
      setupNotice = null;
    }
  } catch {
    setupNotice = 'API proxy unreachable — run via `npm run dev` or deploy /api (see README)';
  }
  setStatus();
}

// Keep the "last update Xs ago" figure fresh without any network work.
setInterval(setStatus, 1000);

// -------------------------
// Boot
// -------------------------

async function init() {
  showOverlay('Loading geographic data…');

  let countries;
  let cities;

  try {
    ({ countries, cities } = await loadGeoData());
  } catch (err) {
    console.error('Failed to load geographic data:', err);
    showOverlay('Failed to load geographic data. Check the console for details.', true);
    return;
  }

  cityIndex = buildCityIndex(cities);

  // Show the globe with its country borders immediately.
  globe = createGlobe(countries);

  // Floating hover card + persistent selection panel + click/drag guards.
  setupInspectionUi();
  setupClickGuards();

  showOverlay('Loading GitHub activity…');

  // Report proxy/token configuration without blocking the visualization.
  await checkApiStatus();

  // First sync doubles as the initial data load, exactly like before.
  // A GitHub failure here must NOT destroy the globe: pollOnce() already
  // catches errors into a non-blocking warning, so the globe with its
  // borders stays visible either way.
  try {
    await pollOnce();
    reportCoverage();
  } finally {
    hideOverlay();
    statusEl.classList.remove('hidden');
    setStatus();
  }

  startPolling();
}

init();