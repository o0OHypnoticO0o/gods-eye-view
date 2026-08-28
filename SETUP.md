# God's Eye View — Service Setup Guide

Everything you need to run God's Eye View with full functionality. Services are grouped into tiers — start with **Tier 0** (required), then add tiers as needed.

**Cost legend:** 🟢 Free · 🟡 Free key · 🔴 Paid/metered · ⚫ Local (self-hosted)

---

## Quick Reference

| Tier | Service | Purpose | Cost | Local Alternative |
|------|---------|---------|------|-------------------|
| **0 — Core** | Google Maps | Map tiles, geocoding, places | 🔴 ($200/mo free credit) | ❌ Required |
| | Cesium Ion | 3D terrain, Bing imagery | 🟡 (free key) | Re:Earth fallback (keyless) |
| **1 — Inference** | OpenAI API | Voice control, HUD summary | 🔴 (metered) | LM Studio + Whisper + Piper |
| | LM Studio | Local LLM inference | ⚫ | Replaces OpenAI for HUD + voice |
| | Whisper.cpp | Local speech-to-text | ⚫ | Replaces OpenAI Realtime STT |
| | Piper TTS | Local text-to-speech | ⚫ | Replaces OpenAI Realtime TTS |
| **2 — Data (free)** | OpenSky | Civilian flight tracking | 🟢 (anon) / 🟡 (auth) | ❌ Only provider |
| | adsb.lol | Military aircraft | 🟢 | ❌ Only provider |
| | CelesTrak | Satellite TLE data | 🟢 | ❌ Only provider |
| | USGS | Earthquake data | 🟢 | ❌ Only provider |
| | Open-Meteo | Weather data | 🟢 | ❌ Only provider |
| | Radio Browser | Internet radio | 🟢 | ❌ Only provider |
| | GBFS | Bike-share stations | 🟢 | ❌ Only provider |
| | Overpass/OSM | Road geometry, POI | 🟢 | Self-hosted Overpass |
| | adsbdb | Aircraft enrichment | 🟢 | ❌ Only provider |
| **3 — Data (key)** | AISStream | Live vessel tracking | 🟡 (free tier) | ❌ Only provider |
| | NASA FIRMS | Active fire detections | 🟡 (free key) | ❌ Only provider |
| | TomTom | Live traffic flow | 🟡 (freemium) | Keyless = simulated traffic |
| **4 — Self-hosted** | Nominatim | Geocoding (search/reverse) | ⚫ Local or 🟢 public | Self-hosted Docker or public API |

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

### Nominatim Geocoder — ⚫ Local or 🟢 Public

**What it powers:** Place search (forward geocoding), reverse geocoding for voice context and cockpit briefings. Replaces the Google Geocoding API for these tasks.

**How it works:** All geocoding requests route through a server-side `/api/nominatim` proxy. The proxy reads the `NOMINATIM_URL` setting to determine which Nominatim instance to use.

**Options:**

| Option | Setup | Rate Limit | Data Coverage |
|--------|-------|------------|---------------|
| **Public Nominatim** | No setup needed (default) | 1 req/s, no key | Global (OpenStreetMap) |
| **Self-hosted (US)** | Docker, ~10 min import | Unlimited | US only |
| **Self-hosted (global)** | Docker, ~2-4 hr import | Unlimited | Global |

#### Option A: Public Nominatim (zero setup)

No configuration needed. The app uses `https://nominatim.openstreetmap.org` by default. Rate-limited to 1 request/second — fine for individual searches, but the voice system's rapid reverse geocoding may hit limits.

#### Option B: Self-Hosted Nominatim (recommended)

The included Docker Compose setup imports the US extract from Geofabrik. First-time import takes 5-10 minutes.

```bash
cd /path/to/nominatim   # or create ~/nominatim/
docker compose up -d     # starts import (check: docker compose logs -f)
# Wait for "Listening on 0.0.0.0:8080" in logs
```

**Available extracts** (edit `docker-compose.yml` to change):

| Region | PBF URL | Raw Size | Import Time |
|--------|---------|----------|-------------|
| US | `north-america/us-latest.osm.pbf` | ~12 GB | ~10 min |
| Texas | `north-america/us/texas-latest.osm.pbf` | ~600 MB | ~1 min |
| UK | `europe/great-britain-latest.osm.pbf` | ~800 MB | ~1 min |
| Full planet | `planet-latest.osm.pbf` | ~80 GB | ~2-4 hr |

**After import completes**, configure in the Settings panel:

- Nominatim Geocoder URL: `http://localhost:8900` (Docker maps to port 8900)

Or set in `.env`:
```
NOMINATIM_URL=http://localhost:8900
```

**Resource requirements:**
- Disk: ~30 GB for US extract (indexed database)
- RAM: ~8 GB during import, ~2 GB steady-state
- CPU: 4+ threads recommended for import

**Stopping/starting:**
```bash
docker compose stop     # stop (data persists in volume)
docker compose start    # restart (instant, no re-import)
docker compose down     # stop and remove container (data persists in volume)
docker compose down -v  # stop and DELETE all data
```

### What replaces Google Geocoding?

With Nominatim configured, the following call sites use Nominatim instead of (or as fallback to) Google:

| Call Site | Without Nominatim URL | With Nominatim URL |
|-----------|----------------------|-------------------|
| Location search bar | Google → Nominatim fallback | Google → Nominatim fallback |
| Voice `fly_to_location` | Google → Nominatim fallback | Google → Nominatim fallback |
| Voice radio location | Google only (no fallback) | Google → Nominatim fallback |
| Voice reverse geocode | Google only (no fallback) | Google → Nominatim fallback |
| Annotation resolver | Google only (no fallback) | Google → Nominatim fallback |

**Note:** Google Maps API key is still required for map tiles and imagery — the geocoding fallback only affects place-name-to-coordinates resolution.

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
