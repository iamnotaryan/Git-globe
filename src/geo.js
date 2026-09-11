// Location matching for GitHub Globe.
//
// Coordinates always come from world_cities.json — nothing in this module
// hardcodes a lat/lng. We only hardcode *country names* (for hints and the
// country-level fallback) and the *name* of a major city used as a fallback
// target per country.

const DIACRITICS_RE = /[\u0300-\u036f]/g;
const SEPARATORS_RE = /[\s,.\-–——_/\\()]+/g;

export function normalizeLocation(location) {
  return String(location)
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS_RE, '')
    .replace(SEPARATORS_RE, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Normalized country/region names -> ISO 3166-1 alpha-2 code.
// Used to disambiguate cities that share a name (e.g. "Delhi, India" -> IN).
const COUNTRY_CODES = {
  'united states': 'US',
  'usa': 'US',
  'america': 'US',
  'united states of america': 'US',
  'canada': 'CA',
  'india': 'IN',
  'china': 'CN',
  'japan': 'JP',
  'germany': 'DE',
  'deutschland': 'DE',
  'france': 'FR',
  'italy': 'IT',
  'italia': 'IT',
  'spain': 'ES',
  'espana': 'ES',
  'portugal': 'PT',
  'brazil': 'BR',
  'brasil': 'BR',
  'mexico': 'MX',
  'argentina': 'AR',
  'chile': 'CL',
  'colombia': 'CO',
  'peru': 'PE',
  'venezuela': 'VE',
  'united kingdom': 'GB',
  'uk': 'GB',
  'great britain': 'GB',
  'england': 'GB',
  'scotland': 'GB',
  'wales': 'GB',
  'ireland': 'IE',
  'australia': 'AU',
  'new zealand': 'NZ',
  'netherlands': 'NL',
  'holland': 'NL',
  'belgium': 'BE',
  'switzerland': 'CH',
  'sweden': 'SE',
  'norway': 'NO',
  'denmark': 'DK',
  'finland': 'FI',
  'poland': 'PL',
  'austria': 'AT',
  'hungary': 'HU',
  'czech republic': 'CZ',
  'czechia': 'CZ',
  'greece': 'GR',
  'romania': 'RO',
  'bulgaria': 'BG',
  'croatia': 'HR',
  'serbia': 'RS',
  'slovenia': 'SI',
  'slovakia': 'SK',
  'russia': 'RU',
  'ukraine': 'UA',
  'turkey': 'TR',
  'israel': 'IL',
  'united arab emirates': 'AE',
  'uae': 'AE',
  'saudi arabia': 'SA',
  'qatar': 'QA',
  'kuwait': 'KW',
  'bahrain': 'BH',
  'oman': 'OM',
  'jordan': 'JO',
  'lebanon': 'LB',
  'egypt': 'EG',
  'morocco': 'MA',
  'tunisia': 'TN',
  'algeria': 'DZ',
  'south africa': 'ZA',
  'nigeria': 'NG',
  'kenya': 'KE',
  'ghana': 'GH',
  'ethiopia': 'ET',
  'tanzania': 'TZ',
  'cameroon': 'CM',
  'senegal': 'SN',
  'vietnam': 'VN',
  'thailand': 'TH',
  'indonesia': 'ID',
  'philippines': 'PH',
  'malaysia': 'MY',
  'singapore': 'SG',
  'pakistan': 'PK',
  'bangladesh': 'BD',
  'sri lanka': 'LK',
  'south korea': 'KR',
  'korea': 'KR',
  'taiwan': 'TW',
  'hong kong': 'HK'
};

const COUNTRY_HINTS = Object.entries(COUNTRY_CODES)
  .sort((a, b) => b[0].length - a[0].length);

// US state abbreviations, so "San Francisco, CA" can be disambiguated from
// San Francisco, Argentina. Only applied when no country hint is present.
const US_STATES = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga',
  'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md',
  'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
  'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc',
  'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy',
  'dc'
]);

// For ambiguous city names, prefer the country people most commonly mean.
// Applied ONLY to bare-name matches (the whole location is the city name),
// so "London, ON" still resolves to Canada while bare "London" resolves to
// the UK. No coordinates are hardcoded — only a country preference.
const CANONICAL_COUNTRY = {
  london: 'GB',
  paris: 'FR',
  york: 'GB',
  manchester: 'GB',
  birmingham: 'GB',
  dublin: 'IE',
  auckland: 'NZ',
  melbourne: 'AU',
  sydney: 'AU',
  vancouver: 'CA',
  boston: 'US',
  houston: 'US',
  miami: 'US',
  brooklyn: 'US'
};

// Country code -> name of a major city to fall back to.
// The city must exist in world_cities.json; its coordinates are resolved
// from that dataset (never hardcoded here).
const FALLBACK_BY_CODE = {
  US: { city: 'Chicago' },
  IN: { city: 'Delhi' },
  CN: { city: 'Shanghai' },
  JP: { city: 'Tokyo' },
  BR: { city: 'São Paulo' },
  DE: { city: 'Berlin' },
  GB: { city: 'London' },
  FR: { city: 'Paris' },
  CA: { city: 'Toronto' },
  AU: { city: 'Sydney' },
  MX: { city: 'Mexico City' },
  ES: { city: 'Madrid' },
  IT: { city: 'Rome' },
  RU: { city: 'Moscow' }
};

// Build a name-indexed Map once. Subsequent lookups are O(1) instead of
// scanning all ~169k entries per user.
export function buildCityIndex(cities) {
  const index = new Map();

  for (const city of cities) {
    const key = normalizeLocation(city.name);
    if (!key) continue;

    let bucket = index.get(key);
    if (!bucket) {
      bucket = [];
      index.set(key, bucket);
    }
    bucket.push(city);
  }

  return index;
}

// Detect a country (or US state) hint inside a normalized location,
// e.g. "maua sp brazil" -> BR, or "san francisco ca" -> US.
function detectCountryHint(normalized, tokens) {
  const padded = ` ${normalized} `;

  for (const [name, code] of COUNTRY_HINTS) {
    if (padded.includes(` ${name} `)) return code;
  }

  // State codes conventionally follow the city ("San Francisco, CA"), so only
  // the final token may act as one. This avoids false positives from common
  // words like "in", "or" or "me".
  if (US_STATES.has(tokens[tokens.length - 1])) return 'US';

  return null;
}

function toPoint(city) {
  return {
    lat: Number(city.lat),
    lng: Number(city.lng),
    city: city.name
  };
}

// Prefer a candidate city using, in order: a country/state hint, then a
// canonical country for famous ambiguous bare names.
function preferCity(candidates, hintCode, normalizedName) {
  if (hintCode) {
    const hinted = candidates.find((c) => c.country === hintCode);
    if (hinted) return hinted;
  }

  const preferred = CANONICAL_COUNTRY[normalizedName];
  if (preferred) {
    const canonical = candidates.find((c) => c.country === preferred);
    if (canonical) return canonical;
  }

  return null;
}

// Match a raw GitHub profile location to a city, or null.
export function matchLocation(location, cityIndex) {
  const normalized = normalizeLocation(location);
  if (!normalized) return null;

  const tokens = normalized.split(' ');
  const hintCode = detectCountryHint(normalized, tokens);

  // Longest exact city-name prefix first: never substring matching, so
  // "New York, NY" can never resolve to a city simply called "York".
  for (let end = tokens.length; end >= 1; end--) {
    const key = tokens.slice(0, end).join(' ');
    const candidates = cityIndex.get(key);

    if (!candidates || !candidates.length) continue;

    // Canonical preference only applies to bare city names ("London", not
    // "London, ON"), so it cannot override a region-specific location.
    const picked = preferCity(
      candidates,
      hintCode,
      end === tokens.length ? key : null
    );

    return toPoint(picked || candidates[0]);
  }

  // Country-level fallback: the location names a country (or is one), but no
  // city in the dataset matched. Resolve a major city for it by country code.
  const hint = hintCode || COUNTRY_CODES[normalized];
  const fallback = hint ? FALLBACK_BY_CODE[hint] : null;

  if (fallback) {
    const candidates = cityIndex.get(normalizeLocation(fallback.city));
    const city = candidates?.find((c) => c.country === hint) || candidates?.[0];

    if (city) {
      return toPoint(city);
    }
  }

  return null;
}