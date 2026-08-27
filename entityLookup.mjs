// entityLookup.mjs — Server-side public data API lookups for entity enrichment.
// Queries free public APIs to return structured metadata about contacts.

const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = 'GodsEyeView/1.0 (local-voice-pipeline)';

// ── Flight lookup via OpenSky Network ──────────────────────────────────────────
// https://openskynetwork.github.io/opensky-api/rest.html
// Free, no auth required for anonymous (rate-limited: ~10 req/min).
async function lookupFlight(query) {
  // If query looks like an ICAO24 hex (6-char hex), use /states endpoint
  const icao24 = /^[0-9a-fA-F]{6}$/.test(query) ? query.toLowerCase() : null;

  if (icao24) {
    const url = `https://opensky-network.org/api/states/all?icao24=${icao24}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const state = data.states?.[0];
    if (!state) return null;
    return formatOpenSkyState(state);
  }

  // Otherwise search by callsign
  const callsign = query.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const url = `https://opensky-network.org/api/states/all?callsign=${callsign}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const state = data.states?.[0];
  if (!state) return null;
  return formatOpenSkyState(state);
}

function formatOpenSkyState(s) {
  // OpenSky state vector fields:
  // 0:icao24, 1:callsign, 2:origin_country, 3:time_position,
  // 4:last_contact, 5:longitude, 6:latitude, 7:baro_altitude,
  // 8:on_ground, 9:velocity, 10:heading, 11:vertical_rate,
  // 12:squawk, 13:spi, 14:position_source
  const callsign = (s[1] || '').trim();
  const altM = s[7] != null ? Math.round(s[7]) : null;
  const altFt = altM != null ? Math.round(altM * 3.28084) : null;
  return {
    type: 'flight',
    icao24: s[0] || null,
    callsign: callsign || null,
    originCountry: s[2] || null,
    longitude: s[5] ?? null,
    latitude: s[6] ?? null,
    altitudeM: altM,
    altitudeFt: altFt,
    onGround: s[8] ?? null,
    velocityMs: s[9] ?? null,
    velocityKmh: s[9] != null ? Math.round(s[9] * 3.6) : null,
    velocityKnots: s[9] != null ? Math.round(s[9] * 1.94384) : null,
    headingDeg: s[10] != null ? Math.round(s[10]) : null,
    verticalRateMs: s[11] ?? null,
    squawk: s[12] || null,
    lastSeen: s[4] || null,
  };
}

// ── adsbdb enrichment (aircraft type, owner, route) ───────────────────────────
// https://api.adsbdb.com — free, no auth, ~5 req/s.
async function enrichFromAdsbdb(result) {
  if (!result || result.type !== 'flight') return result;
  try {
    const callsign = result.callsign || '';
    const hexId = result.icao24;

    // Aircraft type lookup by ICAO24 hex
    if (hexId && /^[0-9a-fA-F]{6}$/.test(hexId)) {
      const typeRes = await fetch(`https://api.adsbdb.com/v0/aircraft/${hexId.toLowerCase()}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (typeRes.ok) {
        const typeData = await typeRes.json();
        const ac = typeData.response?.aircraft;
        if (ac) {
          result.aircraftType = ac.icao_type || ac.type || null;
          result.manufacturer = ac.manufacturer || null;
          result.registration = ac.registration || null;
          result.owner = ac.registered_owner || null;
          result.ownerCountry = ac.registered_owner_country_name || null;
        }
      }
    }

    // Route lookup by callsign (airline-style: 3 letters + digits)
    if (callsign && /^[A-Z]{3}\d/.test(callsign.toUpperCase())) {
      const routeRes = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (routeRes.ok) {
        const routeData = await routeRes.json();
        const fr = routeData.response?.flightroute;
        if (fr) {
          result.airline = fr.airline?.name || null;
          result.airlineIcao = fr.airline?.icao || null;
          result.airlineIata = fr.airline?.iata || null;
          result.originAirport = fr.origin?.name || fr.origin?.iata_code || null;
          result.originIata = fr.origin?.iata_code || null;
          result.originIcao = fr.origin?.icao_code || null;
          result.originCity = fr.origin?.municipality || null;
          result.originCountryName = fr.origin?.country_name || null;
          result.destinationAirport = fr.destination?.name || fr.destination?.iata_code || null;
          result.destinationIata = fr.destination?.iata_code || null;
          result.destinationIcao = fr.destination?.icao_code || null;
          result.destinationCity = fr.destination?.municipality || null;
          result.destinationCountryName = fr.destination?.country_name || null;
        }
      }
    }
  } catch { /* best-effort, fail-silent */ }
  return result;
}

// ── Vessel lookup via AIS (MarineTraffic public) ───────────────────────────────
// No free AIS API exists — fallback to Nominatim for port/harbor context.
async function lookupVessel(query) {
  // Vessels in the system use MMSI or name as ID.
  // We can't query AIS directly (no free API), so return what we know
  // and suggest the user check MarineTraffic/VesselFinder.
  return {
    type: 'vessel',
    identifier: query,
    note: 'Live AIS vessel data requires MarineTraffic or VesselFinder API key. The vessel is tracked via local AIS feed.',
    enrichmentAvailable: false,
  };
}

// ── Satellite lookup via CelesTrak ─────────────────────────────────────────────
// https://celestrak.org/NORAD/documentation/
// Free, no auth, no rate limit for TLE catalog queries.
async function lookupSatellite(query) {
  // Try NORAD catalog number first
  const noradId = /^\d+$/.test(query) ? query : null;

  if (noradId) {
    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=tle`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 3) {
      return {
        type: 'satellite',
        name: lines[0],
        tleLine1: lines[1],
        tleLine2: lines[2],
        noradId,
      };
    }
  }

  // Search by name in the "last 30 days" launch catalog
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=last-30-days&FORMAT=json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const match = data.find((s) =>
    (s.OBJECT_NAME || '').toLowerCase().includes(query.toLowerCase()) ||
    (s.OBJECT_ID || '') === query
  );
  if (!match) return null;
  return {
    type: 'satellite',
    name: match.OBJECT_NAME,
    noradId: match.NORAD_CAT_ID,
    epoch: match.EPOCH,
    meanMotion: match.MEAN_MOTION,
    inclination: match.INCLINATION,
    period: match.PERIOD,
  };
}

// ── Fire lookup via NASA FIRMS ─────────────────────────────────────────────────
// https://firms.modaps.eosdis.nasa.gov/api/area/
// Free with MAP_KEY (open registration at https://firms.modaps.eosdis.nasa.gov/api/area/).
const FIRMS_MAP_KEY = process.env.FIRMS_MAP_KEY || '';

async function lookupFire(query) {
  // If FIRMS API key is configured, query the API directly
  if (FIRMS_MAP_KEY) {
    try {
      // Use country endpoint for US fires (most common), or area endpoint with bbox
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_MAP_KEY}/VIIRS_SNPP_NRT/-180,-90,180,90/1`;
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const csv = await res.text();
        const lines = csv.trim().split('\n');
        if (lines.length > 1) {
          // Parse CSV: latitude,longitude,bright_ti4s,scan,track,acq_date,acq_time,...
          const fires = lines.slice(1, 20).map((line) => {
            const cols = line.split(',');
            return {
              latitude: parseFloat(cols[0]),
              longitude: parseFloat(cols[1]),
              brightness: parseInt(cols[2]) || null,
              acquisitionDate: cols[5],
              acquisitionTime: cols[6],
              satellite: cols[7],
              confidence: cols[8],
              frp: parseFloat(cols[12]) || null,
              dayNight: cols[13],
            };
          });
          return {
            type: 'fire',
            identifier: query,
            source: 'NASA FIRMS VIIRS',
            totalFires: lines.length - 1,
            recentFires: fires,
          };
        }
      }
    } catch (err) {
      console.error(`[EntityLookup] FIRMS API error:`, err.message);
    }
  }

  // Fallback: return FIRMS map link
  return {
    type: 'fire',
    identifier: query,
    note: FIRMS_MAP_KEY
      ? 'No active fires found in FIRMS data for this area.'
      : 'Set FIRMS_MAP_KEY env var to enable live fire data. Register free at https://firms.modaps.eosdis.nasa.gov/api/area/',
    firmsUrl: 'https://firms.modaps.eosdis.nasa.gov/map/',
  };
}

// ── Earthquake lookup via USGS ─────────────────────────────────────────────────
// https://earthquake.usgs.gov/fdsnws/event/1/
// Free, no auth, no rate limit.
async function lookupEarthquake(query) {
  // USGS doesn't have a direct ID lookup — search by place name or return recent
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=5&orderby=magnitude`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.features?.length) return null;

  // Find the most relevant one by place name match
  const q = query.toLowerCase();
  const match = data.features.find((f) =>
    (f.properties?.place || '').toLowerCase().includes(q)
  ) || data.features[0];

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
    latitude: c?.[1],
    longitude: c?.[0],
    depthKm: c?.[2],
    url: p.url,
  };
}

// ── Weather lookup via Open-Meteo (free, no auth, global) ──────────────────────
// https://open-meteo.com/en/docs
async function lookupWeather(lat, lon) {
  if (lat == null || lon == null) return null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code,cloud_cover,precipitation&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
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
      precipitationMm: c.precipitation,
    };
  } catch { return null; }
}

// ── Main entry point ───────────────────────────────────────────────────────────
export async function lookupEntity(entityType, identifier, coords = {}) {
  const type = (entityType || '').toLowerCase();
  try {
    let result;
    switch (type) {
      case 'flight':
      case 'aircraft':
      case 'military':
        result = await lookupFlight(identifier);
        // Enrich with adsbdb data (aircraft type, owner, route)
        result = await enrichFromAdsbdb(result);
        break;
      case 'vessel':
      case 'ship':
      case 'ais':
        result = await lookupVessel(identifier);
        break;
      case 'satellite':
        result = await lookupSatellite(identifier);
        break;
      case 'fire':
      case 'firms':
        result = await lookupFire(identifier);
        break;
      case 'earthquake':
        result = await lookupEarthquake(identifier);
        break;
      default:
        result = { type, identifier, note: `No public data API available for type: ${type}` };
    }

    // Enrich with weather data if coordinates are available
    if (result && !result.error && (coords.latitude || result.latitude)) {
      const weather = await lookupWeather(coords.latitude || result.latitude, coords.longitude || result.longitude);
      if (weather) result.weather = weather;
    }

    return result;
  } catch (err) {
    console.error(`[EntityLookup] ${type} lookup failed:`, err.message);
    return { type, identifier, error: err.message };
  }
}
