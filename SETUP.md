# God's Eye View — Service Setup Guide

Everything you need to run God's Eye View with full functionality. Services are grouped into tiers — start with **Tier 0** (required), then add tiers as needed.

**Cost legend:** 🟢 Free · 🟡 Free key · 🔴 Paid/metered · ⚫ Local (self-hosted)

---

## Quick Reference

| Tier | Service | Purpose | Cost | Local Alternative |
|------|---------|---------|------|-------------------|
| **0 — Core** | Google Maps | Map tiles, geocoding, places | 🔴 ($200/mo free credit) | ❌ Required (tiles) |
| | Cesium Ion | 3D terrain, Bing imagery | 🟡 (free key) | Re:Earth fallback (keyless) |
| **1 — Inference** | OpenAI API | Voice control, HUD summary | 🔴 (metered) | LM Studio + Whisper + Piper |
| | LM Studio | Local LLM inference | ⚫ | Replaces OpenAI for HUD + voice |
| | Whisper.cpp | Local speech-to-text | ⚫ | Replaces OpenAI Realtime STT |
| | Piper TTS | Local text-to-speech | ⚫ | Replaces OpenAI Realtime TTS |
| **2 — Data (free)** | OpenSky | Civilian flight tracking | 🟢 (anon) / 🟡 (auth) | ❌ Only provider |
| | adsb.lol | Military aircraft | 🟢 | ❌ Only provider |
| | CelesTrak | Satellite TLE data | 🟢 | ❌ Only provider |
| | USGS | Earthquake data | 🟢 | ❌ Only provider |
| | Open-Meteo | Weather data | 🟢 | ⚫ Self-hosted ★★★★★ |
| | Radio Browser | Internet radio | 🟢 | ❌ Only provider |
| | GBFS | Bike-share stations | 🟢 | ❌ Only provider |
| | Overpass/OSM | Road geometry, POI | 🟢 | ⚫ Self-hosted ★★★★☆ |
| | adsbdb | Aircraft enrichment | 🟢 | ❌ Only provider |
| **3 — Data (key)** | AISStream | Live vessel tracking | 🟡 (free tier) | ❌ Only provider |
| | NASA FIRMS | Active fire detections | 🟡 (free key) | ❌ Only provider |
| | TomTom | Live traffic flow | 🟡 (freemium) | Keyless = simulated traffic |
| **4 — Self-hosted** | Nominatim | Geocoding (search/reverse) | ⚫ Local or 🟢 public | ⚫ Self-hosted ★★★★★ |
| | Overpass API | OSM queries | ⚫ Local or 🟢 public | ⚫ Self-hosted ★★★★☆ |
| | OSRM | Route calculation | ⚫ Local or 🟢 public | ⚫ Self-hosted ★★★★☆ |
| | OSM Tiles | Map tile layer | ⚫ Local or 🟢 public | ⚫ Self-hosted ★★★☆☆ |
| | Open-Meteo | Weather data | ⚫ Local or 🟢 public | ⚫ Self-hosted ★★★★★ |

---

## Tier 0: Core Services (Required)

### Google Maps API Key — 🔴 Required

The single most important key. Without it, the 3D globe won't render map tiles.

**What it powers:** Map tiles, satellite imagery, geocoding (place search), Google Places (POI discovery), Street View (CCTV fallback frames).

**Setup:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use existing)
3. Enable these APIs:
   - **Maps JavaScript API** (required)
   - **Static Maps API** (required)
   - **Places API** (optional, for POI features)
   - **Geocoding API** (included with Maps)
   - **Street View Static API** (optional, for CCTV fallback)
4. Create an API key
5. **Restrict the key** (important for security):
   - Application restriction: HTTP referrer (your domain)
   - API restriction: Only the APIs above

**Cost:** Google gives $200/month free credit. A typical session uses ~$0.01-0.03 per map load. Most personal use stays well within free tier.

**Enter in Settings panel** or set in `.env`:
```
GOOGLE_MAPS_API_KEY=your_key_here
```

### Cesium Ion Token — 🟡 Optional (recommended)

Enables Bing world imagery overlays and Cesium World Terrain for better 3D elevation.

**What it powers:** Bing imagery stack, Cesium World Terrain (higher-quality 3D terrain).

**Without it:** The app falls back to Re:Earth terrain (free, keyless) — functional but lower quality.

**Setup:**
1. Go to [cesium.com/ion](https://cesium.com/ion/tokens)
2. Create a free account
3. Copy your default access token

**Enter in Settings panel** or set in `.env`:
```
CESIUM_ION_TOKEN=your_token_here
```

---

## Tier 1: Inference & Voice

You have two paths: **cloud (OpenAI)** or **local (self-hosted)**. You can mix — use local for HUD summary and OpenAI for voice, or go fully local.

### Option A: Cloud — OpenAI API 🔴

**What it powers:** Realtime voice control (speech-to-speech), HUD text summaries, debug logging.

**Setup:**
1. Go to [platform.openai.com](https://platform.openai.com/)
2. Create an API key
3. Set billing (required for Realtime API)

**Voice models (metered):**
| Model | Use | Cost |
|-------|-----|------|
| `gpt-realtime-2` | Standard voice | ~$0.06/min input, $0.24/min output |
| `gpt-realtime-2.1-mini` | Budget voice (MINI toggle) | ~$0.01/min input, $0.04/min output |

**Enter in Settings panel:**
- OpenAI API Key: your key
- OpenAI Base URL: `https://api.openai.com` (default)

**HUD Summary model:** Uses `gpt-5-nano` by default (cheap, fast). Configurable in settings.

### Option B: Local — LM Studio + Whisper + Piper ⚫

**What it powers:** Same as OpenAI option, but runs entirely on your hardware. No API keys needed.

**Requirements:**
- A machine with a GPU (AMD ROCm or NVIDIA CUDA) for Whisper and LLM
- Node.js ≥ 18 for the voice server

**Components:**

| Component | Purpose | Default Port |
|-----------|---------|-------------|
| LM Studio | LLM inference (chat completions) | `http://localhost:1234/v1` |
| Whisper.cpp | Speech-to-text (GPU-accelerated) | `http://localhost:8080` |
| Piper TTS | Text-to-speech (CPU, fast) | Local binary |
| Voice Server | WebSocket orchestrator | `ws://localhost:8765` |

**Quick start:**
```bash
# 1. Install LM Studio, load a model (e.g. qwen3.6-35b), start server

# 2. Build whisper.cpp (see LOCAL-VOICE-SETUP.md for GPU-specific instructions)
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp && cmake -B build && cmake --build build -j$(nproc)
bash models/download-ggml-model.sh large-v3

# 3. Install Piper TTS (see LOCAL-VOICE-SETUP.md)
# Download from https://github.com/rhasspy/piper/releases

# 4. Start the voice server
node voice-server.mjs
```

**Full instructions:** See [LOCAL-VOICE-SETUP.md](LOCAL-VOICE-SETUP.md)

**Enter in Settings panel:**
- Local Voice WebSocket: `ws://your-host:8765`
- OpenAI Base URL: `http://your-host:1234/v1` (for HUD summary via LM Studio)
- HUD Reasoning Effort: `none` (required for LM Studio — it returns reasoning-only output when reasoning is enabled)

**Recommended local models:**
| Model | VRAM | Quality | Speed |
|-------|------|---------|-------|
| `qwen3.6-35b-a3b-mtp` | ~20 GB | Excellent | ~45s cold load |
| `qwen3.6-27b-mtp` | ~16 GB | Very good | ~30s cold load |
| `qwen3.8-27b` | ~16 GB | Very good | ~30s cold load |
| `google/gemma-4-12b` | ~8 GB | Good | ~15s cold load |

### Option C: Hybrid

Use local for HUD summary (free, no rate limits) and OpenAI for voice (when you need it).

**Settings:**
- OpenAI API Key: your key (for voice)
- OpenAI Base URL: `http://localhost:1234/v1` (local LM Studio for HUD)
- Local Voice WebSocket: leave empty (uses OpenAI voice)

---

## Tier 2: Data Layers (Free, No Keys Required)

These services are all free and require no registration. They work out of the box.

### OpenSky Network — Civilian Flights 🟢

**What it powers:** Live civilian aircraft state vectors (position, altitude, speed, heading).

**Auth modes:**
- `anon` (default) — Works immediately, but rate-limited (~few requests/minute)
- `oauth` — Free account at [opensky-network.org](https://opensky-network.org), higher rate limits

**To get higher rates:**
1. Register at opensky-network.org
2. Get Client ID and Secret from account dashboard
3. Set in Settings: OpenSky Auth Mode → `oauth`, enter credentials

### adsb.lol — Military Aircraft 🟢

**What it powers:** Military aircraft tracking (ADS-B transponders on military flights).

**No key needed.** Works out of the box via the server proxy.

### CelesTrak — Satellites 🟢

**What it powers:** Satellite TLE (Two-Line Element) data for orbital tracking.

**No key needed.** Free public data from CelesTrak.

### USGS Earthquakes 🟢

**What it powers:** Real-time earthquake data (magnitude, depth, location).

**No key needed.** USGS provides free GeoJSON feeds.

### Open-Meteo — Weather 🟢

**What it powers:** Current weather conditions for camera positions, regional briefings.

**No key needed.** Free, open-source weather API.

### Radio Browser — Internet Radio 🟢

**What it powers:** Internet radio station directory and streaming.

**No key needed.** Public domain data.

### GBFS — Bike Share 🟢

**What it powers:** Real-time bike-share station availability (12 cities).

**No key needed.** Proxied through the server.

### Overpass API — Road Geometry 🟢

**What it powers:** Road geometry for traffic layer, POI queries, boundary detection.

**No key needed.** Uses public Overpass API mirrors (with fallback).

### adsbdb — Aircraft Enrichment 🟢

**What it powers:** Aircraft type, owner, and route data for flight details.

**No key needed.** Free API with 5 req/s limit.

---

## Tier 3: Data Layers (Key Required)

### AISStream — Live Vessel Tracking 🟡

**What it powers:** Real-time AIS vessel positions (ships, boats, tankers).

**Setup:**
1. Go to [aisstream.io](https://www.aisstream.io/)
2. Register for a free account
3. Get your API key
4. Enter in Settings panel

**Free tier:** Limited subscription area. Paid plans for global coverage.

### NASA FIRMS — Active Fires 🟡

**What it powers:** Real-time fire/thermal anomaly detections (VIIRS satellite).

**Setup:**
1. Go to [firms.modaps.eosdis.nasa.gov/api/map_key/](https://firms.modaps.eosdis.nasa.gov/api/map_key/)
2. Request a free API key (instant)
3. Enter in Settings panel

**Without it:** The fire/heat map layer shows "KEY REQUIRED" and is empty.

### TomTom — Live Traffic 🟡

**What it powers:** Live traffic flow vector tiles (congestion data).

**Without a key:** Traffic layer runs in **simulation mode** (white dots, hardcoded speeds) — functional but not real-time.

**Setup (optional):**
1. Go to [developer.tomtom.com](https://developer.tomtom.com/)
2. Register for a free account (50,000 tile requests/day free)
3. Enter in Settings panel

---

## Tier 4: Self-Hosted Services

These services can be replaced with self-hosted alternatives. Each has a quality rating comparing it to the cloud version. Configure endpoints in the **Settings panel** (gear icon ⚙️) or in `.env`.

**Quality rating legend:**
- ★★★★★ Excellent — near-identical to cloud
- ★★★★☆ Very Good — minor feature differences
- ★★★☆☆ Good — functional but reduced features
- ★★☆☆☆ Fair — works but significant tradeoffs

---

### Nominatim Geocoder — ★★★★★ Excellent

**Replaces:** Google Geocoding API
**What it powers:** Place search (forward geocoding), reverse geocoding for voice context and cockpit briefings.
**Quality note:** Full geocoding with OpenStreetMap data. Near-identical to Google for most use cases. No structured name extraction (returns raw OSM labels instead of Google's formatted address components).

**How it works:** All geocoding requests route through a server-side `/api/nominatim` proxy. The proxy reads the `NOMINATIM_URL` setting to determine which Nominatim instance to use.

**Options:**

| Option | Setup | Rate Limit | Data Coverage |
|--------|-------|------------|---------------|
| **Public Nominatim** | No setup needed (default) | 1 req/s, no key | Global (OpenStreetMap) |
| **Self-hosted (region)** | Docker, minutes to import | Unlimited | Regional extract |
| **Self-hosted (global)** | Docker, 2-4 hr import | Unlimited | Full planet |

#### Option A: Public Nominatim (zero setup)

No configuration needed. The app uses `https://nominatim.openstreetmap.org` by default. Rate-limited to 1 request/second — fine for individual searches, but the voice system's rapid reverse geocoding may hit limits.

#### Option B: Self-Hosted Nominatim (recommended)

```bash
cd ~/nominatim  # or any directory
```

Create `docker-compose.yml`:

```yaml
services:
  nominatim:
    image: mediagis/nominatim:4.4
    container_name: nominatim
    restart: unless-stopped
    ports:
      - "8900:8080"
    environment:
      # Change PBF_URL for your region (see table below)
      PBF_URL: https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf
      IMPORT_LANGS: en
      FLATNODES: "true"
      NUM_THREADS: 4
      POSTGRES_SHARED_BUFFERS: "2GB"
      POSTGRES_MAINTENANCE_WORK_MEM: "1GB"
      POSTGRES_WORK_MEM: "50MB"
    volumes:
      - nominatim-data:/var/lib/postgresql
    shm_size: "2gb"
    deploy:
      resources:
        limits:
          memory: 10G

volumes:
  nominatim-data:
```

```bash
docker compose up -d          # first run imports data
docker compose logs -f        # watch progress
# Wait for "Nominatim is ready to accept requests"
```

**Available extracts** (edit `PBF_URL` in docker-compose.yml):

| Region | PBF URL | Raw Size | Import Time | Disk (indexed) | RAM |
|--------|---------|----------|-------------|----------------|-----|
| Texas | `north-america/us/texas-latest.osm.pbf` | ~700 MB | ~5 min | ~2 GB | ~2 GB |
| UK | `europe/great-britain-latest.osm.pbf` | ~800 MB | ~5 min | ~2 GB | ~2 GB |
| US | `north-america/us-latest.osm.pbf` | ~12 GB | ~50 min | ~30 GB | ~4 GB |
| Germany | `europe/germany-latest.osm.pbf` | ~1 GB | ~8 min | ~3 GB | ~2 GB |
| Full planet | `planet-latest.osm.pbf` | ~80 GB | ~4 hr | ~200 GB | ~8 GB |

**To switch regions:**
```bash
docker compose down -v   # delete old data
# Edit docker-compose.yml PBF_URL
docker compose up -d     # re-import
```

**After import**, configure in Settings panel:
- **Nominatim Geocoder URL**: `http://localhost:8900`

Or in `.env`:
```
NOMINATIM_URL=http://localhost:8900
```

**Verify:** Click the **Test** button next to the Nominatim URL field in Settings, or:
```bash
curl "http://localhost:8900/search?q=Austin+Texas&format=json&limit=1"
```

---

### Overpass API — ★★★★☆ Very Good

**Replaces:** Public overpass-api.de
**What it powers:** OSM queries for road geometry, POI discovery, place enrichment in annotations.
**Quality note:** Full OSM query support. Self-hosted instance has no rate limits and faster response times.

**Docker setup:**
```bash
docker run -d --name overpass \
  -p 12345:80 \
  -e OVERPASS_META=yes \
  -e OVERPASS时代中国限购areas=yes \
  -e OVERPASS_FLUSH=true \
  -e OVERPASS_MODE=init \
  -e OVERPASS_PLANET=/nominatim/data.osm.pbf \
  -v /path/to/data.osm.pbf:/nominatim/data.osm.pbf \
  -v overpass-db:/var/lib/overpass \
  wiktorn/overpass-api
```

**Or use the quick-start script:**
```bash
# Download the planet extract first
wget https://download.geofabrik.de/planet-latest.osm.pbf

docker run -d --name overpass \
  -p 12345:80 \
  -v $(pwd)/planet-latest.osm.pbf:/nominatim/data.osm.pbf \
  -v overpass-db:/var/lib/overpass \
  -e OVERPASS_MODE=init \
  -e OVERPASS_PLANET=/nominatim/data.osm.pbf \
  wiktorn/overpass-api
```

**Regional extracts** (smaller = faster import):
- Texas: ~700 MB → import in minutes
- US: ~12 GB → import in ~30 min
- Planet: ~80 GB → import in hours

**Configure in Settings:**
- **Overpass API URL**: `http://localhost:12345`

**Verify:**
```bash
curl "http://localhost:12345/interpreter?data=[out:json];node(30.26,-97.75,30.28,-97.73);out+5;"
```

---

### OSRM Routing — ★★★★☆ Very Good

**Replaces:** Public routing.openstreetmap.de
**What it powers:** Route calculations for annotations and navigation features.
**Quality note:** Fast car/bicycle/pedestrian routing. No traffic-aware routing (use TomTom for that).

**Docker setup:**
```bash
# Download a regional extract
wget https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf

# Extract and prepare
docker run -t -v "$(pwd):/data" ghcr.io/project-osrm/osrm-backend osrm-extract \
  -p /opt/car.lua /data/texas-latest.osm.pbf

docker run -t -v "$(pwd):/data" ghcr.io/project-osrm/osrm-backend osrm-partition \
  /data/texas-latest.osrm

docker run -t -v "$(pwd):/data" ghcr.io/project-osrm/osrm-backend osrm-customize \
  /data/texas-latest.osrm

# Run the server
docker run -d --name osrm \
  -p 5000:5000 \
  -v "$(pwd):/data" \
  ghcr.io/project-osrm/osrm-backend osrm-routed \
  --algorithm mld /data/texas-latest.osrm
```

**Configure in Settings:**
- **OSRM Routing URL**: `http://localhost:5000`

**Verify:**
```bash
curl "http://localhost:5000/route/v1/driving/-97.7431,30.2672;-97.7341,30.2702?overview=false"
```

---

### OSM Tile Server — ★★★☆☆ Good

**Replaces:** Public tile.openstreetmap.org
**What it powers:** Basic map tile layer (fallback when Google tiles unavailable).
**Quality note:** Standard OSM mapnik rendering. No 3D, no photorealistic. Functional but visually basic compared to Google.

**Docker setup:**
```bash
docker run -d --name osm-tiles \
  -p 8080:80 \
  -v osm-data:/var/lib/postgresql \
  -e DOWNLOAD_PBF=https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf \
  -e DOWNLOAD_POLY=https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf.poly \
  overv/openstreetmap-tile-server
```

**Configure in Settings:**
- **OSM Tile Server URL**: `http://localhost:8080`

**Note:** Without this setting, the app uses public `tile.openstreetmap.org` tiles directly. Self-hosting is mainly useful for high-volume usage or air-gapped deployments.

---

### Open-Meteo Weather — ★★★★★ Excellent

**Replaces:** Public api.open-meteo.com
**What it powers:** Weather data for entity enrichment and regional briefings.
**Quality note:** Open-source weather API. Near-identical to the cloud version. Uses the same underlying weather models (ECMWF, GFS, DWDICON, etc.).

**Docker setup:**
```bash
# Open-Meteo provides an official Docker image
docker run -d --name open-meteo \
  -p 8090:8080 \
  ghcr.io/open-meteo/open-meteo
```

**For the full weather API with historical data:**
```bash
git clone https://github.com/open-meteo/open-meteo.git
cd open-meteo
docker compose up -d
```

**Configure in Settings:**
- **Open-Meteo Weather URL**: `http://localhost:8090`

**Verify:**
```bash
curl "http://localhost:8090/v1/forecast?latitude=30.2672&longitude=-97.7431&current_weather=true"
```

---

### Cloud API Quick Setup

For services you prefer to use from the cloud, here are direct signup links:

| Service | Purpose | Free Tier | Signup Link |
|---------|---------|-----------|-------------|
| Google Maps | Map tiles, geocoding, places | $200/mo credit | [console.cloud.google.com](https://console.cloud.google.com/) |
| Cesium Ion | 3D terrain, Bing imagery | 100k tiles/mo | [ion.cesium.com](https://ion.cesium.com/) |
| OpenAI | Voice control, HUD summary | Pay-per-use | [platform.openai.com](https://platform.openai.com/api-keys) |
| OpenSky Network | Civilian flight tracking | Anonymous (rate-limited) | [opensky-network.org](https://opensky-network.org/api) |
| adsb.lol | Military aircraft tracking | Free (community) | [adsb.lol](https://adsb.lol/) |
| AISStream | Live vessel tracking | 100 free messages | [aisstream.io](https://aisstream.io/register) |
| NASA FIRMS | Active fire detections | Free key | [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/api/map_key) |
| TomTom | Live traffic flow | 50k tiles/day | [developer.tomtom.com](https://developer.tomtom.com/) |
| CelesTrak | Satellite TLE data | Free (public) | [celestrak.org](https://celestrak.org/) |
| adsbdb | Aircraft enrichment | Free (community) | [adsbdb.com](https://adsbdb.com/) |

---

---

## Network Architecture (Multi-Machine Setup)

If you're running components across machines (e.g., Linux dev server + Windows inference host):

```
┌─────────────────────────┐     ┌─────────────────────────────┐
│ Linux VM (10.100.100.34)│     │ Windows Desktop (10.10.10.253)│
│                         │     │                               │
│  Vite dev server :5176  │     │  LM Studio :1234             │
│  Caddy HTTPS :5445  ────┼─────│  Whisper.cpp :8080            │
│  Caddy WSS :5446   ─────┼─────│  Voice Server :8765 (WS)     │
│                         │     │  Piper TTS (local binary)     │
└─────────────────────────┘     └─────────────────────────────┘
```

**Settings for this layout:**
- Local Voice WebSocket: `wss://10.100.100.34:5446` (Caddy proxies to Windows)
- OpenAI Base URL: `http://10.10.10.253:1234/v1` (direct to LM Studio)
- Whisper URL: `http://10.10.10.253:8080` (voice server uses this)

**HTTPS requirement:** Browsers require HTTPS for microphone access on non-localhost origins. The Caddy proxy on port 5445 handles this with a self-signed cert.

---

## Settings Persistence

Settings are stored server-side at `~/.gods-eye-view/settings.json`. They:

- **Survive browser clears** — stored on disk, not in localStorage
- **Override .env values** — settings panel values take priority over `.env`
- **Are masked in the UI** — sensitive keys show `AIza•••••••••••tR7k` format
- **Are private** — never sent to the client in full (only masked versions)

You can also edit `~/.gods-eye-view/settings.json` directly if needed:
```json
{
  "googleMapsApiKey": "AIza...",
  "openaiBaseUrl": "http://10.10.10.253:1234/v1",
  "localVoiceWsUrl": "wss://10.100.100.34:5446"
}
```

---

## Troubleshooting

### "Map won't load"
- Check `GOOGLE_MAPS_API_KEY` is set and valid
- Verify the Maps JavaScript API is enabled in Google Cloud Console
- Check browser console for API quota errors

### "Voice button does nothing"
- If using local voice: verify voice server is running (`node voice-server.mjs`)
- Check `LOCAL_VOICE_WS_URL` is set correctly
- For HTTPS: ensure you're accessing via `https://` (not `http://`) on non-localhost

### "HUD summary returns empty or errors"
- If using LM Studio: set HUD Reasoning Effort to `none` (LM Studio returns reasoning-only output when reasoning is enabled)
- Verify LM Studio is running and model is loaded
- Check `OPENAI_BASE_URL` points to the correct endpoint

### "Layer shows 'KEY REQUIRED'"
- That layer needs an API key — check the Settings panel under DATA LAYERS
- Some layers (TomTom traffic) work without keys in simulation mode

### "Whisper is slow"
- Ensure GPU acceleration is enabled (ROCm for AMD, CUDA for NVIDIA)
- Use a smaller model: `medium` or `small` instead of `large-v3`
- Check GPU utilization: `rocm-smi` (AMD) or `nvidia-smi` (NVIDIA)

### "Can't find ffmpeg on Windows"
- WinGet-installed executables are NOT in Node.js PATH
- Use full absolute path or add to system PATH (not just PowerShell user PATH)
- See voice-server.mjs for the workaround pattern

---

## Further Reading

- [LOCAL-VOICE-SETUP.md](LOCAL-VOICE-SETUP.md) — Complete local voice pipeline guide
- [SECURITY.md](SECURITY.md) — API key security and exposure analysis
- [README.md](README.md) — Project overview and quick start
