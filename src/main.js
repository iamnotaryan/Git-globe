import './style.css';
import Globe from 'globe.gl';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GitHubApiError, getApiStatus, getEventsPages, fetchUsers } from './github.js';
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

// Event pool sizing: the initial load pulls a few pages so the globe starts
// rich (~300 raw events max); steady-state polls fetch only the newest page
// and deduplicate against everything already seen.
const INITIAL_EVENT_PAGES = 3;
const POLL_EVENT_PAGES = 1;

// Event-type filter shown in the legend. `match` is the raw GitHub event type;
// 'all' shows every retained activity. Filtering is visualization state only —
// filtered-out events stay in the underlying store.
const FILTER_TYPES = {
  all: null,
  push: 'PushEvent',
  pr: 'PullRequestEvent',
  issues: 'IssuesEvent',
  watch: 'WatchEvent',
  fork: 'ForkEvent'
};

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
let updating = false;
// Persistent, non-blocking setup notice (missing token / missing proxy).
// Never a crash: the globe keeps showing the last known good state.
let setupNotice = null;

// -------------------------
// API status (kept separate from globe rendering state)
// -------------------------
//
// 'live'   — last cycle succeeded; shows counters + fresh "Updated …" time.
// 'error'  — last cycle failed; existing globe data is preserved and only a
//            concise warning is shown. The NEXT success flips back to 'live'
//            and clears the error automatically — stale text can never stick.
let apiStatus = 'live';
let lastSuccessfulUpdate = null;
let lastApiError = null; // { message, kind, status, at } or null
let consecutiveFailures = 0;

// -------------------------
// Event inspection state (centralized rotation + selection)
// -------------------------

// event id -> normalized event record (from eventDetails.normalizeEvent).
// Retained independently of the render caps so a selected event stays
// inspectable even while points/arcs rotate out; pruned lazily.
const eventStore = new Map();

// Centralized interaction state. The globe ACTUALLY rotates only when:
//
//   rotationEnabled === true AND hoveredEventId === null AND selectedEventId === null
//
// Manual intent (rotationEnabled, toggled by the Start/Stop button) is kept
// separate from temporary inspection pauses (hover/selection), so a manual
// Stop is never accidentally resumed by a mouse-leave or panel close.
let rotationEnabled = true;
let hoveredEventId = null;
let selectedEventId = null;
let activeFilter = 'all';

let hoverCard = null;
let selectedPanel = null;
let rotationToggleBtn = null;

// Stable ids of every raw event already processed (including location-less
// ones), so polls never re-resolve the same event twice.
const processedIds = new Set();

// Last known pointer position (globe.gl hover callbacks carry no MouseEvent).
const lastPointer = { x: 0, y: 0 };
// Pointer-down position to distinguish a real click from a globe drag.
let pointerDownPos = null;

function isSelected(eventId) {
  return eventId != null && eventId === selectedEventId;
}

// Single place where the effective rotation state is applied. Polling,
// filtering and data updates never touch rotation except through here.
//
// The globe ACTUALLY rotates only when:
//   rotationEnabled === true AND hoveredEventId === null AND selectedEventId === null
function updateRotation() {
  const shouldRotate =
    rotationEnabled &&
    hoveredEventId === null &&
    selectedEventId === null;
  if (globe) {
    try {
      globe.controls().autoRotate = shouldRotate;
    } catch {
      // Controls unavailable (e.g. during teardown) — safe to ignore.
    }
  }
  return shouldRotate;
}

function syncRotationButton() {
  if (!rotationToggleBtn) return;
  rotationToggleBtn.setAttribute('aria-pressed', String(rotationEnabled));
  rotationToggleBtn.setAttribute(
    'aria-label',
    rotationEnabled ? 'Stop globe rotation' : 'Start globe rotation'
  );
  rotationToggleBtn.textContent = rotationEnabled ? '⏸ Stop Rotation' : '▶ Start Rotation';
}

// Single source of truth for "rotation ON": enables rotation, clears ALL
// event inspection state (hover + selection), hides every event dialog,
// removes the selected-event highlight, and resumes auto-rotation
// immediately. Both the main "Start Rotation" button and the dialog's
// "Resume rotation" button funnel through here, so they always agree.
function startRotation() {
  rotationEnabled = true;
  hoveredEventId = null;
  selectedEventId = null;

  hoverCard?.hide();
  selectedPanel?.hide();

  refreshHighlights();
  updateRotation();
  syncRotationButton();
}

// Single source of truth for "rotation OFF": stops the globe regardless of
// whether an event is currently selected. Inspection state is left intact.
function stopRotation() {
  rotationEnabled = false;
  updateRotation();
  syncRotationButton();
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
const SELECTED_ARC_COLOR_CACHE = new Map();

// Selected-arc gradient: the event's own color, brightened toward white so it
// stays event-colored yet clearly stronger than every unselected arc.
function selectedArcColorFor(eventType) {
  let colors = SELECTED_ARC_COLOR_CACHE.get(eventType);
  if (!colors) {
    const base = new THREE.Color(colorForEvent(eventType));
    const head = base.clone().lerp(new THREE.Color('#ffffff'), 0.45);
    const tail = base.clone().multiplyScalar(0.6);
    colors = [`#${tail.getHexString()}`, `#${head.getHexString()}`];
    SELECTED_ARC_COLOR_CACHE.set(eventType, colors);
  }
  return colors;
}

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

    // Selected point renders larger with a hot core so the inspected event
    // is obvious even after the pointer leaves the globe.
    .pointRadius((d) => (isSelected(d.eventId) ? 0.6 : 0.3))

    .pointColor((d) =>
      isSelected(d.eventId) ? '#ffffff' : colorForEvent(d.eventType)
    )

    // Country borders
    .polygonsData(countries.features)

    .polygonCapColor(() => '#000000')

    .polygonSideColor(() => 'rgba(4, 4, 4, 0)')

    .polygonStrokeColor(() => '#f44242b1')

    .polygonAltitude(0.005)

    // Activity rings
    .ringsData([])

    // Preserved green pulse; the selected event keeps its persistent animated
    // ring in its own event color so it stays identifiable while selected.
    .ringColor((d) =>
      isSelected(d.eventId) ? colorForEvent(d.eventType) : '#00ff88'
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
      isSelected(d.eventId) ? selectedArcColorFor(d.eventType) : arcColorFor(d.eventType)
    )

    .arcAltitude((d) => arcAltitudeFor(d))

    .arcAltitudeAutoScale(false)

    .arcStroke((d) => (isSelected(d.eventId) ? 1.6 : 0.6))

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

  setupSpaceBackdrop(globeInstance);

  setupGlow(globeInstance);

  return globeInstance;
}

// -------------------------
// Deep-space backdrop (stars + camera-rigid sun rig)
// -------------------------
//
// Created ONCE for the lifetime of the Globe. Polling and data updates never
// touch these objects: three THREE.Points star layers (no per-star Mesh,
// fixed in the static world scene), plus a sun rig parented to the CAMERA
// (sun disk sprite, halo sprite, directional light + target, fresnel rim
// shell). No extra animation loop — twinkle is a cheap low-frequency opacity
// update, skipped under prefers-reduced-motion; rig re-anchoring is driven
// by the existing controls 'change' events only.
let spaceDecor = null;

// Layer recipe: mostly tiny dim stars, a few slightly larger/brighter ones.
const STAR_LAYERS = [
  { count: 750, size: 1.3, opacity: 0.5, tints: ['#ffffff', '#cdd8ff'], twinkleAmp: 0.10 },
  { count: 350, size: 1.9, opacity: 0.65, tints: ['#ffffff', '#cdd8ff', '#ffe9d6'], twinkleAmp: 0.13 },
  { count: 150, size: 2.6, opacity: 0.8, tints: ['#ffffff', '#ffe9d6'], twinkleAmp: 0.16 }
];

// Soft round dot so Points don't render as squares.
function makeDotTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// Hot-cored sun disk: bright near-white center falling to warm gold.
function makeSunTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(255,252,244,1)');
  gradient.addColorStop(0.18, 'rgba(255,240,214,0.95)');
  gradient.addColorStop(0.4, 'rgba(255,210,140,0.35)');
  gradient.addColorStop(0.7, 'rgba(255,190,120,0.08)');
  gradient.addColorStop(1, 'rgba(255,180,110,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// Wide soft falloff for the sun halo.
function makeGlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.08)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// Uniform random point in a spherical shell — no grid, no pattern.
function pushShellPoint(positions, minR, maxR) {
  let x = 0;
  let y = 0;
  let z = 0;
  let len = 0;
  do {
    x = Math.random() * 2 - 1;
    y = Math.random() * 2 - 1;
    z = Math.random() * 2 - 1;
    len = Math.sqrt(x * x + y * y + z * z);
  } while (len > 1 || len < 1e-3);
  const radius = minR + Math.random() * (maxR - minR);
  positions.push((x / len) * radius, (y / len) * radius, (z / len) * radius);
}

// Sun placement: spherical orbital coordinates in the SUN RIG's local frame.
// The rig hangs off the camera (see setupSpaceBackdrop) so its local axes
// stay screen-stable: -Z points behind the globe, +Y is screen-up, -X is
// screen-left. Azimuth is measured in the rig XZ plane from +X toward +Z;
// elevation is measured above the rig XZ plane:
//
//   x = R * cos(elevation) * cos(azimuth)
//   y = R * sin(elevation)
//   z = R * cos(elevation) * sin(azimuth)
//
// Azimuth ≈ -90° points directly behind the globe. The defaults sit ~27° off
// that axis — behind, above, screen-left — for an asymmetric warm rim on one
// horizon. Adjust these two numbers to move the sun; the light, halo and rim
// all derive from the same axis, and nothing else needs to change.
//
// Why rig-local instead of world axes: globe.gl rotates by orbiting the
// CAMERA (verified: no object rotation exists anywhere in the stack), so a
// world-fixed sun swings around the frame, disappears behind the camera for
// half of every orbit, and the camera flies straight through its halo.
// A camera-rigid rig is the relative-motion equivalent of a spinning globe
// under a fixed world sun viewed by a fixed camera: the sun stays put on
// screen while geography streams across the disc and transits the fixed
// terminator. Screen position and axis are therefore stable by construction
// with zero per-frame updates.
const SUN_AZIMUTH_DEG = -110;
const SUN_ELEVATION_DEG = 18;
// Sun/halo distances from the globe center, in multiples of the limb radius.
const SUN_DISTANCE = 3.0;
const HALO_DISTANCE = 4.0;

function sunDirectionFromAngles(azDeg, elDeg) {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return new THREE.Vector3(
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
    Math.cos(el) * Math.sin(az)
  ).normalize();
}

// Best-effort globe limb radius: the largest sphere in the scene (globe or
// atmosphere shell). Falls back to a camera-distance estimate.
function estimateLimbRadius(scene, cameraDist) {
  let best = 0;
  try {
    scene.traverse((obj) => {
      const radius = obj?.geometry?.parameters?.radius;
      if (typeof radius === 'number' && Number.isFinite(radius)) {
        const scale = obj?.scale ? Math.max(obj.scale.x, obj.scale.y, obj.scale.z) : 1;
        best = Math.max(best, radius * scale);
      }
    });
  } catch {
    // Traversal hiccup — fall through to the estimate below.
  }
  return best > 0 ? best : cameraDist / 3.5;
}

// Structural self-check (runs once after backdrop setup): proves the sun and
// stars have no transform correlation with anything the rotation path
// touches. Rotation in this stack is OrbitControls camera orbit driven by
// updateRotation(); the check asserts the sun rig hangs directly off the
// camera (screen-rigid by design), the sun sits exactly on its configured
// SUN_* axis, and every star layer is a direct child of the static scene
// root (fixed in world, riding neither the camera nor globe content).
function verifySceneIndependence() {
  try {
    const parts = [];
    let ok = true;

    const { sunRig, sun, camera, expectedSunPos } = spaceDecor || {};
    if (!sunRig || !camera) {
      ok = false;
      parts.push('VIOLATION: sun rig or camera missing');
    } else {
      const chain = [];
      for (let n = sunRig; n; n = n.parent) chain.push(n.type || '?');
      parts.push('sun chain: ' + chain.join(' < '));
      if (sunRig.parent !== camera) {
        ok = false;
        parts.push('VIOLATION: sunRig parent is not the camera');
      }
      if (camera.parent?.type !== 'Scene') {
        ok = false;
        parts.push(`VIOLATION: camera parent is ${camera.parent?.type}, expected Scene`);
      }
      if (sun && expectedSunPos) {
        const drift = sun.position.distanceTo(expectedSunPos);
        parts.push(`sun axis drift: ${drift.toFixed(4)} units`);
        if (!(drift < 0.01)) {
          ok = false;
          parts.push('VIOLATION: sun position diverged from SUN_* axis');
        }
      }
    }

    const stars = (spaceDecor?.twinkleLayers || []).map((l) => l.object).filter(Boolean);
    parts.push(`star layers: ${stars.length}`);
    stars.forEach((star, i) => {
      if (!star.parent || star.parent.type !== 'Scene') {
        ok = false;
        parts.push(`VIOLATION: star layer ${i} parent=${star.parent?.type}`);
      }
    });

    console.log(`[independence] ${ok ? 'OK' : 'FAILED'} — ` + parts.join(' ; '));
  } catch (err) {
    console.warn('[independence] check skipped:', err?.message || err);
  }
}

function setupSpaceBackdrop(instance) {
  if (spaceDecor) return;
  let scene = null;
  let camera = null;
  try {
    scene = instance.scene();
    camera = instance.camera();
  } catch {
    return;
  }
  if (!scene || !camera) return;

  const cameraDist = camera.position.length();
  // Shell comfortably beyond the globe but inside the camera far plane.
  const minR = cameraDist * 1.6;
  const maxR = Math.min(cameraDist * 3.5, 1800);

  const dotTexture = makeDotTexture();
  const twinkleLayers = [];

  for (const layer of STAR_LAYERS) {
    const positions = [];
    const colors = [];
    const tintColor = new THREE.Color();
    for (let i = 0; i < layer.count; i++) {
      pushShellPoint(positions, minR, maxR);
      tintColor.set(layer.tints[Math.floor(Math.random() * layer.tints.length)]);
      // Slight per-star intensity variation.
      tintColor.multiplyScalar(0.55 + Math.random() * 0.45);
      colors.push(tintColor.r, tintColor.g, tintColor.b);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: layer.size,
      sizeAttenuation: false,
      map: dotTexture,
      transparent: true,
      opacity: layer.opacity,
      vertexColors: true,
      depthWrite: false
    });

    const points = new THREE.Points(geometry, material);
    // Static world scene: the camera orbits around it, so stars show a
    // gentle parallax. Never blocks raycasts for events.
    points.raycast = () => {};
    scene.add(points);

    twinkleLayers.push({
      object: points,
      material,
      baseOpacity: layer.opacity,
      amp: layer.twinkleAmp,
      speed: 0.25 + Math.random() * 0.25,
      phase: Math.random() * Math.PI * 2
    });
  }

  // Layered cinematic sun on a camera-rigid axis (sunRig hangs off the
  // camera, so the sun is fixed on screen while geography streams across the
  // disc — the relative-motion equivalent of a spinning globe under a fixed
  // world sun viewed by a fixed camera):
  //
  //   camera (orbits via existing controls.autoRotate — the app's rotation)
  //   └── sunRig (STATIC local offsets; re-anchored to the globe center only
  //                 when camera distance changes, i.e. user zoom)
  //       ├── sun disk sprite + halo sprite (occluded by the Earth)
  //       ├── directional light + target (same axis as the visible sun)
  //       └── fresnel rim shell (same axis, see below)
  //
  //   scene (static root, never rotated)
  //   ├── stars (static world objects)
  //   └── globe content (globe.gl-owned: Earth, borders, points, rings, arcs;
  //                      positions managed by the library — never reparented,
  //                      because its digest lifecycle removes objects from the
  //                      scene root and reparenting would leak GPU resources)
  //
  // There is deliberately NO earthRotationGroup: globe.gl exposes no
  // per-frame hook to drive rotation.y (verified: customThreeObjectUpdate is
  // digest-driven, not per-frame), and moving digest-managed objects would
  // break their root-targeted removal. Rotation stays on the existing
  // controls.autoRotate path with identical pause/resume semantics.
  //
  // Layers (intensities already at the reduced ~0.75× tuning):
  //   1. Warm directional light along the sun axis (subtle physical lift on
  //      lit surfaces; unlit event materials are unaffected).
  //   2. Bright sun disk on the SUN_AZIMUTH/SUN_ELEVATION axis, so a crescent
  //      peeks past the limb while the hot core stays occluded by the Earth.
  //   3. Wide warm halo along the same axis for scattering-like atmosphere.
  //   4. Sun-modulated fresnel rim shell just outside the cyan atmosphere,
  //      formulated in rig-local space with a CONSTANT sun direction: warm
  //      gold only on the sun-facing limb, fading to nothing elsewhere so
  //      cyan dominates everywhere else.
  //
  // The Earth occludes the sun (depth-tested sprites + shell); nothing is
  // drawn on top of the globe disc.
  const limbR = estimateLimbRadius(scene, cameraDist);

  // The camera must be part of the scene for its children to render.
  // setupSpaceBackdrop runs once (spaceDecor guard), so this happens once.
  try {
    scene.add(camera);
  } catch {
    return;
  }
  camera.updateMatrixWorld(true);

  // Globe center in camera-local coordinates; the rig lives here.
  const rigOrigin = camera.worldToLocal(new THREE.Vector3(0, 0, 0));
  // Sun axis in rig-local orbital coordinates (constant by construction).
  const sunDirLocal = sunDirectionFromAngles(SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG);

  const sunRig = new THREE.Group();
  sunRig.position.copy(rigOrigin);
  camera.add(sunRig);

  const sunLight = new THREE.DirectionalLight(0xfff1dd, 0.26);
  sunLight.position.copy(sunDirLocal).multiplyScalar(1000);
  const sunTarget = new THREE.Object3D();
  sunTarget.position.set(0, 0, 0);
  sunRig.add(sunTarget);
  sunLight.target = sunTarget;
  sunRig.add(sunLight);

  const sunMaterial = new THREE.SpriteMaterial({
    map: makeSunTexture(),
    color: 0xffe7c4,
    transparent: true,
    opacity: 0.71,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const sun = new THREE.Sprite(sunMaterial);
  const sunSize = limbR * 1.8;
  sun.scale.set(sunSize, sunSize, 1);
  sun.position.copy(sunDirLocal).multiplyScalar(limbR * SUN_DISTANCE);
  // Never intercept event hover raycasts.
  sun.raycast = () => {};
  sunRig.add(sun);

  // Wide warm halo along the same axis for scattering-like atmosphere.
  const haloMaterial = new THREE.SpriteMaterial({
    map: makeGlowTexture(),
    color: 0xffd9a8,
    transparent: true,
    opacity: 0.26,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const halo = new THREE.Sprite(haloMaterial);
  const haloSize = limbR * 4.6;
  halo.scale.set(haloSize, haloSize, 1);
  halo.position.copy(sunDirLocal).multiplyScalar(limbR * HALO_DISTANCE);
  // Never intercept event hover raycasts.
  halo.raycast = () => {};
  sunRig.add(halo);

  // Warm rim shell just outside the existing cyan atmosphere. Formulated in
  // rig-local space: the sun direction is constant and the camera sits at a
  // fixed rig-local offset, so no per-frame updates are needed.
  let rimMaterial = null;
  try {
    rimMaterial = new THREE.ShaderMaterial({
      uniforms: {
        sunDirection: { value: sunDirLocal.clone() },
        // Rig-local offset from the rim center to the camera (constant
        // until the user zooms; refreshed by syncRigToCamera below).
        camPos: { value: rigOrigin.clone().negate() },
        rimColor: { value: new THREE.Color(0xffc98a) },
        intensity: { value: 0.75 }
      },
      vertexShader: `
        varying vec3 vLocalNormal;
        varying vec3 vLocalPos;
        void main() {
          vLocalNormal = normal;
          vLocalPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 sunDirection;
        uniform vec3 camPos;
        uniform vec3 rimColor;
        uniform float intensity;
        varying vec3 vLocalNormal;
        varying vec3 vLocalPos;
        void main() {
          vec3 normal = normalize(vLocalNormal);
          vec3 viewDir = normalize(camPos - vLocalPos);
          float fresnel = pow(1.0 - abs(dot(normal, viewDir)), 2.5);
          float sunFace = pow(clamp(dot(normal, normalize(sunDirection)), 0.0, 1.0), 1.5);
          float alpha = fresnel * sunFace * intensity;
          gl_FragColor = vec4(rimColor, alpha * 0.9);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide
    });
    const rim = new THREE.Mesh(new THREE.SphereGeometry(limbR * 1.03, 64, 64), rimMaterial);
    rim.raycast = () => {};
    sunRig.add(rim);
  } catch {
    // Rim shell is an enhancement; the sprites alone still carry the effect.
    rimMaterial = null;
  }

  // Keep the rig glued to the globe center across user zoom. Orbit
  // (auto-rotate or drag) is a rigid motion about the target, so rig-local
  // geometry is exactly invariant while rotating: this handler no-ops then
  // and only re-anchors when the camera distance changes. Event-driven on
  // the existing controls lifecycle — not a new animation loop.
  let rigDist = camera.position.distanceTo(instance.controls().target);
  const syncRigToCamera = () => {
    try {
      const dist = camera.position.distanceTo(instance.controls().target);
      if (Math.abs(dist - rigDist) <= Math.max(0.5, dist * 0.002)) return;
      rigDist = dist;
      camera.updateMatrixWorld(true);
      const center = camera.worldToLocal(new THREE.Vector3(0, 0, 0));
      sunRig.position.copy(center);
      if (rimMaterial) rimMaterial.uniforms.camPos.value.copy(center).negate();
      sunTarget.position.set(0, 0, 0);
    } catch {
      // Controls unavailable — rig simply stays at its setup pose.
    }
  };
  try {
    instance.controls().addEventListener('change', syncRigToCamera);
  } catch {
    // Older controls without events — static setup pose still applies.
  }

  spaceDecor = {
    twinkleLayers,
    twinkleTimer: null,
    sunRig,
    sun,
    camera,
    sunDirLocal: sunDirLocal.clone(),
    expectedSunPos: sunDirLocal.clone().multiplyScalar(limbR * SUN_DISTANCE)
  };
  verifySceneIndependence();
  // TEMP-DEBUG-ONLY: expose rig snapshot for headless verification.
  // MUST BE REVERTED before finishing.
  window.__sunDebug = () => {
    try {
      const v = new THREE.Vector3();
      sun.getWorldPosition(v);
      const chain = [];
      for (let n = sunRig; n; n = n.parent) chain.push(n.type);
      return JSON.stringify({
        sunWorld: v.toArray().map((n) => (Number.isFinite(n) ? +n.toFixed(1) : String(n))),
        sunLocal: sun.position.toArray().map((n) => (Number.isFinite(n) ? +n.toFixed(1) : String(n))),
        camPos: camera.position.toArray().map((n) => (Number.isFinite(n) ? +n.toFixed(1) : String(n))),
        rigChain: chain.join('<'),
        camInScene: !!camera.parent,
        sunVisible: sun.visible,
        sunOpacity: sunMaterial.opacity,
        rigChildren: sunRig.children.length
      });
    } catch (e) {
      return 'HOOK-ERR ' + (e?.message || e);
    }
  };

  // Very slow, very subtle twinkle: a low-frequency opacity wobble per
  // layer with different phases, so only a fraction of stars visibly
  // change at once. No extra rAF loop — one cheap interval.
  try {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion) {
      spaceDecor.twinkleTimer = setInterval(() => {
        const t = performance.now() / 1000;
        for (const layer of twinkleLayers) {
          layer.material.opacity =
            layer.baseOpacity * (1 + layer.amp * Math.sin(t * layer.speed + layer.phase));
        }
      }, 200);
    }
  } catch {
    // Timers unavailable — static stars remain, which is the priority.
  }
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
// The active event-type filter is applied here: filtering is visualization
// state only, the underlying stores keep every retained event.
function matchesFilter(eventType) {
  const wanted = FILTER_TYPES[activeFilter];
  return wanted == null || eventType === wanted;
}

function visibleActivities() {
  return [...activityMap.values()].filter((a) => matchesFilter(a.eventType));
}

function visibleArcs() {
  return [...arcMap.values()].filter((a) => matchesFilter(a.eventType));
}

function updateGlobe() {
  if (!globe) return;

  const activities = visibleActivities();
  const arcs = visibleArcs();

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
// the pointer is over a point. Pauses rotation WITHOUT changing the manual
// rotationEnabled intent; leaving resumes only if nothing else holds it.
function handlePointHover(point) {
  const container = globe ? globe.renderer().domElement : null;
  if (!point) {
    hoveredEventId = null;
    hoverCard?.hide();
    if (container) container.style.cursor = '';
    updateRotation();
    return;
  }
  const norm = normForPoint(point);
  if (!norm || !hoverCard) return;
  hoveredEventId = norm.eventId;
  hoverCard.show(norm, colorForEvent(norm.eventType), lastPointer.x, lastPointer.y);
  if (container) container.style.cursor = 'pointer';
  updateRotation();
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
    hoveredEventId = null;
    hoverCard?.hide();
    if (container) container.style.cursor = '';
    updateRotation();
    return;
  }
  const norm = normForArc(arc);
  if (!norm || !hoverCard) return;
  hoveredEventId = norm.eventId;
  hoverCard.show(norm, colorForEvent(norm.eventType), lastPointer.x, lastPointer.y);
  if (container) container.style.cursor = 'pointer';
  updateRotation();
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
  hoveredEventId = null;
  hoverCard?.hide();
  selectedPanel?.show(norm, colorForEvent(norm.eventType));
  updateRotation();
  refreshHighlights();
}

function clearSelection() {
  selectedEventId = null;
  selectedPanel?.hide();
  hoverCard?.hide();
  updateRotation();
  refreshHighlights();
}

// Switch the visualization filter. If the selected event is filtered out of
// view, its selection is safely cleared (panel closes, rotation resumes per
// rotationEnabled). Stored events are never deleted by filtering.
function setFilter(name) {
  if (!(name in FILTER_TYPES)) return;
  activeFilter = name;

  document.querySelectorAll('#filters .filter-button').forEach((btn) => {
    const on = btn.dataset.filter === name;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
  });

  if (selectedEventId !== null) {
    const norm = eventStore.get(selectedEventId);
    if (!norm || !matchesFilter(norm.eventType)) {
      clearSelection();
    }
  }

  updateGlobe();
  updateStatusUI();
}

function setupInspectionUi() {
  // Both dialog buttons (× and "Resume rotation") funnel into startRotation,
  // so the dialog control always agrees with the main rotation button.
  hoverCard = createHoverCard();
  selectedPanel = createSelectedPanel({ onClose: () => startRotation() });

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
      startRotation();
    }
  });
}

// Bottom-center controls: manual Start/Stop rotation toggle + event-type
// filter legend. Wired once at boot; never duplicated. The toggle is the
// single source of truth: Start always performs a full startRotation (which
// also clears any open event dialog), Stop always halts via stopRotation.
function setupControls() {
  rotationToggleBtn = document.getElementById('rotationToggle');
  if (rotationToggleBtn) {
    syncRotationButton();
    rotationToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (rotationEnabled) stopRotation();
      else startRotation();
    });
  }

  document.querySelectorAll('#filters .filter-button').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setFilter(btn.dataset.filter);
    });
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

// One full sync: fetch events, drop anything already processed, resolve the
// rest into points and arcs. `pages` controls the pool size: the initial load
// uses INITIAL_EVENT_PAGES for a rich globe, steady-state polls use
// POLL_EVENT_PAGES. Throws GitHubApiError when GitHub is unreachable; on any
// failure the existing globe state is preserved untouched.
async function refreshActivity(pages = POLL_EVENT_PAGES) {
  const events = await getEventsPages(pages);

  const freshEvents = events.filter((event) => !processedIds.has(eventKey(event)));
  if (freshEvents.length === 0) return;

  const { points, arcs, metrics, noArcReasons } = await resolveActivity(freshEvents);

  // The cycle fully succeeded — only now mark ids and counts, so a failed
  // cycle leaves everything unmarked and the next poll retries it in full.
  for (const event of events) {
    processedIds.add(eventKey(event));
  }
  // Bound the dedup set (insertion-ordered): forget the oldest far beyond any
  // realistic retention window.
  while (processedIds.size > 5000) {
    const oldest = processedIds.values().next().value;
    processedIds.delete(oldest);
  }

  if (points.length) addActivities(points);
  if (arcs.length) addArcs(arcs);

  const reasons = Object.entries(noArcReasons)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');

  console.log(
    `[sync] ${events.length} raw events (${freshEvents.length} fresh) -> ${points.length} activities, ` +
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
// resets and any previous error state is cleared. Because startPolling awaits
// this, polls never overlap. A failed cycle never mutates globe data and
// never touches rotation — the next cycle recovers on its own.
async function pollOnce(pages = POLL_EVENT_PAGES) {
  updating = true;
  updateStatusUI();

  try {
    await refreshActivity(pages);
    pollIntervalMs = BASE_POLL_INTERVAL_MS;
    recordApiSuccess();
  } catch (err) {
    console.error('GitHub activity poll failed:', err);
    recordApiError(err);
    pollIntervalMs = Math.min(pollIntervalMs * 2, MAX_POLL_INTERVAL_MS);
  } finally {
    updating = false;
    updateStatusUI();
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
// Live status UI — updateStatusUI() is the ONLY function that writes to the
// status DOM. Polling, event processing, globe rendering and interaction
// handlers only mutate the apiStatus state above, then call this.
// -------------------------

// Classify a poll failure into a concise, user-facing warning. Messages are
// fixed strings (never echo tokens, headers, or upstream internals).
function classifyApiError(err) {
  const status = err instanceof GitHubApiError ? err.status : null;
  if (status === 401) return { kind: 'auth', message: 'GitHub auth failed — check server token' };
  if (status === 403) return { kind: 'rate-limit', message: 'GitHub rate limit reached' };
  if (status === 404) return { kind: 'not-found', message: 'GitHub resource not found' };
  return { kind: 'network', message: 'GitHub update failed' };
}

function recordApiError(err) {
  consecutiveFailures += 1;
  apiStatus = 'error';
  const { kind, message } = classifyApiError(err);
  lastApiError = {
    kind,
    // Repeated non-auth failures escalate to a calmer persistent notice
    // instead of repeating the same line; auth stays specific (it's config).
    message:
      consecutiveFailures >= 3 && kind !== 'auth'
        ? 'GitHub API temporarily unavailable'
        : message,
    status: err instanceof GitHubApiError ? err.status : null,
    at: Date.now()
  };
}

// SUCCESS: immediately clear any previous error, restore LIVE, stamp the
// update time. Stale error text can never survive a successful cycle.
function recordApiSuccess() {
  consecutiveFailures = 0;
  apiStatus = 'live';
  lastApiError = null;
  lastSuccessfulUpdate = Date.now();
}

function updateStatusUI() {
  statusEl.classList.toggle('updating', updating);
  const isError = apiStatus === 'error';
  statusEl.classList.toggle('warning', isError);

  statusState.textContent = isError ? 'TEMPORARY ERROR' : 'LIVE';

  // Counts reflect the currently visible (filtered) view and are preserved
  // through errors — a failed poll never replaces them with an error dump.
  const activities = visibleActivities();
  const arcs = visibleArcs();

  let detail = '';
  if (isError) {
    detail += `${lastApiError?.message || 'GitHub update failed'} · retrying · `;
  } else if (lastSuccessfulUpdate !== null) {
    const seconds = Math.max(0, Math.round((Date.now() - lastSuccessfulUpdate) / 1000));
    detail += seconds < 10 ? 'Updated just now · ' : `Updated ${seconds}s ago · `;
  }
  detail += `${activities.length} activities · ${arcs.length} arcs · ${activities.length - arcs.length} no destination`;

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
  updateStatusUI();
}

// Keep the "Updated Xs ago" figure fresh without any network work.
setInterval(updateStatusUI, 1000);

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
  setupControls();

  showOverlay('Loading GitHub activity…');

  // Report proxy/token configuration without blocking the visualization.
  await checkApiStatus();

  // Initial load pulls a few pages for a rich globe; later polls fetch only
  // the newest page (see startPolling). A GitHub failure here must NOT destroy
  // the globe: pollOnce() already funnels errors into the non-blocking status
  // state, so the globe with its borders stays visible either way.
  try {
    await pollOnce(INITIAL_EVENT_PAGES);
    reportCoverage();
  } finally {
    hideOverlay();
    statusEl.classList.remove('hidden');
    updateStatusUI();
  }

  startPolling();
}

init();