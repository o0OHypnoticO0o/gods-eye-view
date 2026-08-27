/**
 * entityEnrichment.js — Client-side automatic entity enrichment.
 *
 * Listens for `gev:entity-selected` events and fetches public API data
 * (flights, satellites, earthquakes, weather) to enrich the selected contact.
 * Stores results on the context record as `__enrichment` and dispatches
 * `gev:entity-enriched` for UI consumption.
 *
 * API routing:
 *   flights / military  → /api/opensky (Vite proxy, CORS-safe)
 *   satellites          → /api/celestrak (Vite proxy, CORS-safe)
 *   earthquakes         → earthquake.usgs.gov (direct, CORS OK)
 *   weather             → api.open-meteo.com (direct, CORS OK)
 *   local-firms         → already loaded in layer, no extra fetch needed
 */

import { getContextStore } from '../data/contextStore.js';

const FETCH_TIMEOUT_MS = 6000;
const DEBOUNCE_MS = 400;

/** Map layerId → enrichment entity type. */
const LAYER_TYPE_MAP = {
  flights: 'flight',
  military: 'military',
  'ais-live-vessels': 'vessel',
  satellites: 'satellite',
  'local-firms': 'fire',
  earthquakes: 'earthquake',
};

let _debounceTimer = null;
let _lastEnrichedId = null;

// ── API fetchers ──────────────────────────────────────────────────────────────

async function fetchFlightEnrichment(record) {
  const id = record.id || '';
  // Try ICAO24 hex first (6-char), then callsign
  const isIcao = /^[0-9a-fA-F]{6}$/.test(id);
  const param = isIcao ? `icao24=${id}` : `callsign=${encodeURIComponent(id)}`;

  // Fetch live telemetry from OpenSky
  let telemetry = null;
  try {
    const res = await fetch(`/api/opensky?${param}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = await res.json();
      const state = data.states?.[0];
      if (state) {
        const altM = state[7] != null ? Math.round(state[7]) : null;
        telemetry = {
          icao24: state[0],
          callsign: (state[1] || '').trim(),
          originCountry: state[2],
          altitudeM: altM,
          altitudeFt: altM != null ? Math.round(altM * 3.28084) : null,
          onGround: state[8],
          velocityMs: state[9],
          velocityKnots: state[9] != null ? Math.round(state[9] * 1.94384) : null,
          headingDeg: state[10] != null ? Math.round(state[10]) : null,
          verticalRateMs: state[11],
          squawk: state[12],
        };
      }
    }
  } catch { /* continue without telemetry */ }

  // Fetch aircraft details + route from adsbdb (free, no auth)
  let aircraft = null;
  let route = null;
  try {
    const callsign = telemetry?.callsign || record.name || '';
    const hexId = telemetry?.icao24 || (isIcao ? id : null);

    // Aircraft type lookup by ICAO24 hex
    if (hexId && /^[0-9a-fA-F]{6}$/.test(hexId)) {
      const typeRes = await fetch(`https://api.adsbdb.com/v0/aircraft/${hexId.toLowerCase()}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (typeRes.ok) {
        const typeData = await typeRes.json();
        aircraft = typeData.response?.aircraft;
      }
    }

    // Route lookup by callsign (airline-style only: 3 letters + digits)
    if (callsign && /^[A-Z]{3}\d/.test(callsign.toUpperCase())) {
      const routeRes = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (routeRes.ok) {
        const routeData = await routeRes.json();
        route = routeData.response?.flightroute;
      }
    }
  } catch { /* continue without adsbdb data */ }

  // Combine all data
  return {
    type: 'flight',
    // Telemetry from OpenSky
    ...telemetry,
    // Aircraft details from adsbdb
    aircraftType: aircraft?.icao_type || aircraft?.type,
    manufacturer: aircraft?.manufacturer,
    registration: aircraft?.registration,
    owner: aircraft?.registered_owner,
    ownerCountry: aircraft?.registered_owner_country_name,
    photo: aircraft?.url_photo,
    // Route from adsbdb
    airline: route?.airline?.name,
    airlineIcao: route?.airline?.icao,
    airlineIata: route?.airline?.iata,
    originAirport: route?.origin?.name || route?.origin?.iata_code,
    originIata: route?.origin?.iata_code,
    originIcao: route?.origin?.icao_code,
    originCity: route?.origin?.municipality,
    originCountry: route?.origin?.country_name,
    destinationAirport: route?.destination?.name || route?.destination?.iata_code,
    destinationIata: route?.destination?.iata_code,
    destinationIcao: route?.destination?.icao_code,
    destinationCity: route?.destination?.municipality,
    destinationCountry: route?.destination?.country_name,
  };
}

async function fetchSatelliteEnrichment(record) {
  const id = record.id || '';
  const noradId = /^\d+$/.test(id) ? id : null;
  if (!noradId) return null;
  try {
    const res = await fetch(`/api/celestrak?CATNR=${noradId}&FORMAT=json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const sat = Array.isArray(data) ? data[0] : data;
    if (!sat) return null;
    return {
      type: 'satellite',
      name: sat.OBJECT_NAME,
      noradId: sat.NORAD_CAT_ID,
      epoch: sat.EPOCH,
      meanMotion: sat.MEAN_MOTION,
      inclination: sat.INCLINATION,
      period: sat.PERIOD,
    };
  } catch { return null; }
}

async function fetchEarthquakeEnrichment(record) {
  try {
    const res = await fetch(
      'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=5&orderby=magnitude',
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.features?.length) return null;
    // Match by place name or proximity to record coordinates
    const q = (record.name || '').toLowerCase();
    const match = data.features.find((f) => {
      const place = (f.properties?.place || '').toLowerCase();
      return q && place.includes(q);
    }) || data.features.find((f) => {
      const c = f.geometry?.coordinates;
      return c && record.latitude != null && record.longitude != null
        && Math.abs(c[1] - record.latitude) < 0.5
        && Math.abs(c[0] - record.longitude) < 0.5;
    });
    if (!match) return null;
    const p = match.properties;
    const c = match.geometry?.coordinates;
    return {
      type: 'earthquake',
      place: p.place,
      magnitude: p.mag,
      magType: p.magType,
      time: p.time ? new Date(p.time).toISOString() : null,
      tsunami: p.tsunami ? 1 : 0,
      felt: p.felt,
      depthKm: c?.[2],
    };
  } catch { return null; }
}

async function fetchWeather(lat, lon) {
  if (lat == null || lon == null) return null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code,cloud_cover&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    const c = data.current;
    if (!c) return null;
    return {
      temperatureF: c.temperature_2m,
      humidity: c.relative_humidity_2m,
      windMph: c.wind_speed_10m,
      windDirectionDeg: c.wind_direction_10m,
      weatherCode: c.weather_code,
      cloudCover: c.cloud_cover,
    };
  } catch { return null; }
}

// ── Main enrichment flow ──────────────────────────────────────────────────────

async function enrichEntity(record) {
  if (!record) return;
  const layerId = record.layerId;
  const entityType = LAYER_TYPE_MAP[layerId];
  if (!entityType) {
    console.log('[EntityEnrichment] No enrichment for layer:', layerId);
    return;
  }

  // Don't re-enrich the same entity
  const entityId = record.id;
  if (entityId === _lastEnrichedId && record.__enrichment) return;
  _lastEnrichedId = entityId;

  console.log(`[EntityEnrichment] Enriching ${entityType} id=${entityId} layer=${layerId}`);

  let enrichment = null;

  switch (entityType) {
    case 'flight':
    case 'military':
      enrichment = await fetchFlightEnrichment(record);
      break;
    case 'satellite':
      enrichment = await fetchSatelliteEnrichment(record);
      break;
    case 'earthquake':
      enrichment = await fetchEarthquakeEnrichment(record);
      break;
    case 'fire':
      // Fire data is already loaded in the FIRMS layer — no extra fetch needed
      enrichment = { type: 'fire', source: 'FIRMS layer data' };
      break;
    default:
      return;
  }

  // Append weather data if coordinates are available
  if (enrichment && record.latitude != null && record.longitude != null) {
    const weather = await fetchWeather(record.latitude, record.longitude);
    if (weather) enrichment.weather = weather;
  }

  if (enrichment) {
    record.__enrichment = enrichment;
    record.__enrichedAt = Date.now();
    console.log('[EntityEnrichment] Result:', enrichment);
    window.dispatchEvent(new CustomEvent('gev:entity-enriched', {
      detail: { record, enrichment },
    }));
  } else {
    console.log('[EntityEnrichment] No enrichment data returned');
  }
}

function formatEnrichment(enrichment) {
  if (!enrichment) return '';
  const parts = [];
  if (enrichment.type === 'flight') {
    // Route info (most important)
    if (enrichment.originAirport && enrichment.destinationAirport) {
      const orig = enrichment.originIata || enrichment.originAirport;
      const dest = enrichment.destinationIata || enrichment.destinationAirport;
      parts.push(`${orig} → ${dest}`);
    }
    if (enrichment.airline) parts.push(enrichment.airline);
    // Aircraft info
    if (enrichment.registration) parts.push(enrichment.registration);
    if (enrichment.aircraftType) parts.push(enrichment.aircraftType);
    if (enrichment.owner) parts.push(enrichment.owner);
    // Telemetry
    if (enrichment.callsign) parts.push(`CS: ${enrichment.callsign}`);
    if (enrichment.altitudeFt != null) parts.push(`${enrichment.altitudeFt.toLocaleString()} ft`);
    if (enrichment.velocityKnots != null) parts.push(`${enrichment.velocityKnots} kts`);
    if (enrichment.headingDeg != null) parts.push(`Hdg ${enrichment.headingDeg}°`);
    if (enrichment.squawk) parts.push(`Sq ${enrichment.squawk}`);
  } else if (enrichment.type === 'satellite') {
    if (enrichment.name) parts.push(enrichment.name);
    if (enrichment.period) parts.push(`Period: ${Number(enrichment.period).toFixed(1)} min`);
    if (enrichment.inclination) parts.push(`Incl: ${Number(enrichment.inclination).toFixed(1)}°`);
  } else if (enrichment.type === 'earthquake') {
    if (enrichment.place) parts.push(enrichment.place);
    if (enrichment.magnitude != null) parts.push(`M${enrichment.magnitude}`);
    if (enrichment.depthKm != null) parts.push(`Depth: ${enrichment.depthKm} km`);
  }
  if (enrichment.weather) {
    const w = enrichment.weather;
    if (w.temperatureF != null) parts.push(`${Math.round(w.temperatureF)}°F`);
    if (w.windMph != null) parts.push(`Wind: ${Math.round(w.windMph)} mph`);
  }
  return parts.join(' · ');
}

let _badgeEl = null;

function showEnrichmentBadge(text) {
  if (!_badgeEl) {
    _badgeEl = document.createElement('div');
    _badgeEl.id = 'entity-enrichment-badge';
    Object.assign(_badgeEl.style, {
      position: 'fixed',
      bottom: '180px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0, 20, 40, 0.85)',
      border: '1px solid rgba(0, 212, 255, 0.3)',
      borderRadius: '8px',
      padding: '6px 14px',
      fontFamily: 'var(--font-mono, monospace)',
      fontSize: '10px',
      letterSpacing: '0.8px',
      color: '#bdefff',
      zIndex: '200',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      maxWidth: '600px',
      textAlign: 'center',
      transition: 'opacity 0.3s',
      pointerEvents: 'none',
    });
    document.body.appendChild(_badgeEl);
  }
  _badgeEl.textContent = text;
  _badgeEl.style.opacity = '1';
  clearTimeout(_badgeEl._hideTimer);
  _badgeEl._hideTimer = setTimeout(() => { _badgeEl.style.opacity = '0'; }, 8000);
}

function hideEnrichmentBadge() {
  if (_badgeEl) _badgeEl.style.opacity = '0';
}

// ── Initialization ────────────────────────────────────────────────────────────

export function initEntityEnrichment() {
  // Non-tracking layers (satellites, earthquakes, installations, etc.)
  window.addEventListener('gev:entity-selected', (event) => {
    const record = event.detail;
    if (!record) return;
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => enrichEntity(record), DEBOUNCE_MS);
  });

  // Tracking layers (flights, military) — awareness subject selected
  window.addEventListener('gev:awareness-subject-selected', (event) => {
    const detail = event.detail;
    if (!detail) return;
    // Event fires before selectTrackedSubjectContext stores entity, so build
    // a minimal record directly from the event detail for enrichment.
    const id = detail.icao24 || detail.id;
    if (!id) return;
    const record = {
      id,
      layerId: detail.layerId || 'flights',
      name: detail.label || id,
    };
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => enrichEntity(record), DEBOUNCE_MS);
  });

  // Show enrichment badge when data arrives
  window.addEventListener('gev:entity-enriched', (event) => {
    const { enrichment } = event.detail || {};
    const text = formatEnrichment(enrichment);
    if (text) showEnrichmentBadge(text);
  });

  // Clear on selection cleared
  window.addEventListener('gev:entity-selection-cleared', () => {
    _lastEnrichedId = null;
    hideEnrichmentBadge();
  });
  window.addEventListener('gev:awareness-subject-cleared', () => {
    _lastEnrichedId = null;
    hideEnrichmentBadge();
  });

  console.log('[EntityEnrichment] Initialized');
}
