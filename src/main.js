import './style.css';
import Globe from 'globe.gl';
import { getEvents, fetchUsers } from './github.js';
import { buildCityIndex, matchLocation } from './geo.js';

const overlay = document.getElementById('overlay');
const overlayMessage = document.getElementById('overlayMessage');

function showOverlay(message, isError = false) {
  overlay.classList.toggle('error', isError);
  overlayMessage.textContent = message;
  overlay.classList.remove('hidden');
}

function hideOverlay() {
  overlay.classList.add('hidden');
}

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

// Fetch events, dedupe by actor, fetch one profile per actor, and match each
// profile location to a city from world_cities.json.
async function loadActivity(cityIndex) {
  const events = await getEvents();

  const eventTypeByUser = new Map();

  for (const event of events) {
    if (event.actor?.login && !eventTypeByUser.has(event.actor.login)) {
      eventTypeByUser.set(event.actor.login, event.type);
    }
  }

  const profiles = await fetchUsers([...eventTypeByUser.keys()]);

  const matchedUsers = [];

  for (const profile of profiles) {
    const point = matchLocation(profile.location, cityIndex);

    if (point) {
      matchedUsers.push({
        username: profile.login,
        eventType: eventTypeByUser.get(profile.login),
        lat: point.lat,
        lng: point.lng
      });
    }
  }

  return matchedUsers;
}

function renderGlobe(matchedUsers, countries) {
  const globe = Globe()

    .pointsData(matchedUsers)

    .pointLat('lat')
    .pointLng('lng')

    .pointRadius(0.5)

    .pointColor((d) => {
      switch (d.eventType) {
        case 'PushEvent':
          return '#00ff88';
        case 'PullRequestEvent':
          return '#00ffff';
        case 'WatchEvent':
          return '#ffff00';
        default:
          return '#ffffff';
      }
    })

    // Country borders
    .polygonsData(countries.features)

    .polygonCapColor(() => '#000000')

    .polygonSideColor(() => 'rgba(4, 4, 4, 0)')

    .polygonStrokeColor(() => '#f44242b1')

    .polygonAltitude(0.005)

    // Activity rings
    .ringsData(matchedUsers)

    .ringColor(() => '#00ff88')

    .ringMaxRadius(4)

    .ringPropagationSpeed(3)

    .ringRepeatPeriod(1200)

    // Tooltip
    .pointLabel((d) => `${d.username}<br>${d.eventType}`);

  globe.globeMaterial().color.set('#000000');

  globe.atmosphereColor('#1aebe4');

  globe.atmosphereAltitude(0.15);

  globe(document.getElementById('globeViz'));

  globe.controls().autoRotate = true;

  globe.controls().autoRotateSpeed = 0.5;
}

async function init() {
  showOverlay('Loading GitHub activity…');

  let countries;
  let cities;

  try {
    ({ countries, cities } = await loadGeoData());
  } catch (err) {
    console.error('Failed to load geographic data:', err);
    showOverlay('Failed to load geographic data. Check the console for details.', true);
    return;
  }

  const cityIndex = buildCityIndex(cities);

  let matchedUsers = [];
  let apiError = null;

  try {
    matchedUsers = await loadActivity(cityIndex);
  } catch (err) {
    apiError = err;
    console.error('Failed to load GitHub activity:', err);
  }

  renderGlobe(matchedUsers, countries);

  if (apiError) {
    showOverlay(`Could not load GitHub activity: ${apiError.message}`, true);
  } else {
    console.log(`Rendered ${matchedUsers.length} activity points.`);
    hideOverlay();
  }
}

init();