#!/usr/bin/env node
/**
 * God's Eye View — Local Voice Server
 *
 * WebSocket server that chains:
 *   Browser mic → Whisper.cpp (STT) → LM Studio (LLM) → Piper TTS → Browser speaker
 *
 * Usage:
 *   node voice-server.mjs [--port 8765]
 *
 * Environment:
 *   WHISPER_URL       — Whisper server URL (default: http://localhost:8080)
 *   LM_STUDIO_URL     — LM Studio /v1 endpoint (default: http://localhost:1234/v1)
 *   PIPER_BIN         — Path to piper binary (default: piper)
 *   VOICE_MODEL       — Piper voice model name (default: en_US-amy-medium)
 *   LLM_MODEL         — Model ID for LM Studio (default: qwen3.6-35b-a3b-mtp)
 *   PORT              — WebSocket server port (default: 8765)
 */

import { WebSocketServer } from 'ws';
import { spawn, exec } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { lookupEntity } from './entityLookup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ──────────────────────────────────────────────────────────────
const WHISPER_URL = process.env.WHISPER_URL || 'http://localhost:8080';
const LM_STUDIO_URL = process.env.LM_STUDIO_URL || 'http://localhost:1234/v1';
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://10.100.100.34:8080';
const PIPER_DIR = join(__dirname, 'piper');
const PIPER_BIN_ABS = process.env.PIPER_BIN || join(PIPER_DIR, 'piper.exe');
const VOICE_MODEL_ABS = join(PIPER_DIR, process.env.VOICE_MODEL || 'en_US-amy-medium.onnx');
const LLM_MODEL = process.env.LLM_MODEL || 'qwen3.6-35b-a3b-mtp';
const PORT = parseInt(process.env.PORT || '8765', 10);

const SYSTEM_PROMPT = `You are the voice interface for God's Eye View, a real-time geospatial intelligence dashboard. You control the map via function calls.

AVAILABLE TOOLS (call via the [TOOL] tag — the system executes them automatically):

NAVIGATION:
  fly_to_location latitude longitude — Fly camera to coordinates
  fly_to_preset name — Fly to any city or place name (e.g., "detroit", "tokyo", "golden gate bridge"). Default zoom ~40k ft.
  fly_to_globe — Zoom out to full globe view
  adjust_camera_zoom direction amount — Zoom in/out (direction: "in"/"out", amount: "little"/"medium"/"lot")
  move_camera heading pitch rangeM — Pan/tilt camera precisely (heading in degrees, pitch -90 to 0, rangeM in meters)
  frame_overhead — Top-down overhead view of current area
  fly_route routeId — Fly along a predefined route

LAYERS:
  set_layer_visibility layerId enabled — Enable/disable a data layer (enabled: true/false)
  toggle_layer layerId — Toggle a data layer on/off
  set_map_stack mapId — Change base map (satellite, street, terrain, dark)

TRACKING:
  track_entity query layerId — Track an aircraft, vessel, satellite, or fire by name/ID/callsign. layerId optional (flights, military, ais-live-vessels, satellites). Example: "track Delta 1234"
  select_nearest_aircraft locationQuery layerId — Fly to a location, enable flights, select nearest aircraft (layerId: "flights" or "military")
  stop_tracking — Stop tracking current entity

PANELS:
  open_panel panelId — Open a UI panel (data, locations, control, cctv, radio, scenes, voice-commands-panel, nav-controls-panel)
  close_panel panelId — Close a UI panel
  toggle_panel panelId — Toggle a UI panel

CONTEXT & INFO:
  get_current_view_state — Get camera position, active layers, and view details
  get_entity_context — Get details about the currently selected entity
  set_hud element visible — Show/hide HUD elements (altitude, coordinates, compass, speed, etc.)
  set_context_mode mode — Switch context/analysis mode

CAMERA & STYLE:
  set_visual_style style — Change visual style (normal, retro, surveillance, thermal, anime, noir, snow)
  set_post_processing effect enabled — Toggle post-processing (bloom, ambient, etc.)
  control_cockpit action — Cockpit view controls

CCTV & SCENES:
  control_cctv action — Control CCTV cameras (action: "next"/"previous"/"select"/"stop")
  control_scene action — Scene playback control

ANNOTATIONS:
  annotate_map latitude longitude label — Drop a pin/annotation on the map
  clear_annotations — Remove all annotations

RADIO:
  control_radio action — Control radio (action: "play"/"pause"/"stop"/"status"/"next"/"previous")

SPECIAL:
  next_iss_pass — Get next ISS overpass time
  analyst_query query — Query the analyst engine for data analysis

WEB SEARCH (for current information):
  search_web query — Search the web via SearXNG for current information (flights, news, data)

ENTITY ENRICHMENT (for detailed contact data):
  enrich_entity entityType identifier [latitude longitude] — Look up public data for a tracked contact.
    entityType: flight, aircraft, military, vessel, ship, satellite, fire, earthquake
    identifier: ICAO24 hex, callsign, NORAD catalog number, or entity name
    latitude/longitude: optional — enables weather data at entity location
    Returns: altitude, speed, squawk, origin/destination (flights), orbital data (satellites),
             magnitude/depth (earthquakes), weather conditions (when coords provided).
    USE WHEN: User asks about a specific flight, ship, satellite, or fire details.
    Example: [TOOL] enrich_entity {"entityType":"flight","identifier":"UAL456","latitude":41.97,"longitude":-87.9}

IMPORTANT — USE search_web WHEN:
  - User asks about current flights, ships, satellites, or traffic
  - User asks "what's happening" or "what's going on" at a location
  - User asks about weather, news, or live data
  - User asks about incoming/outgoing flights at an airport
  - Any question about real-time or current information

RESPONSE FORMAT:
1. First, speak your response naturally (1-2 sentences).
2. If a tool call is needed, add it on a NEW LINE after your spoken response using this exact format:
   [TOOL] tool_name {"arg1": "value1", "arg2": "value2"}

EXAMPLES:
  User: "Show me Detroit and enable flights"
  Response: Flying to Detroit with flight tracking on.
  [TOOL] fly_to_preset {"name": "detroit"}
  [TOOL] set_layer_visibility {"layerId": "flights", "enabled": true}

  User: "Track United 456"
  Response: Tracking United 456 now.
  [TOOL] track_entity {"query": "UAL456", "layerId": "flights"}

  User: "What's near me?"
  Response: Let me check what's visible.
  [TOOL] get_current_view_state {}

  User: "Drop a pin on the White House"
  Response: Pin dropped on the White House.
  [TOOL] annotate_map {"latitude": 38.8977, "longitude": -77.0365, "label": "White House"}

  User: "Switch to satellite view"
  Response: Switching to satellite map.
  [TOOL] set_map_stack {"mapId": "satellite"}

CRITICAL RULES:
- Keep spoken responses BRIEF (1-2 sentences max). Never ramble.
- You MAY call multiple tools in one response when the user asks for multiple things (e.g., "fly to Detroit and show flights" → two tool calls). List each on its own line.
- If no tool is needed, just respond with spoken text (no [TOOL] tag).
- NEVER proactively do things the user didn't ask for. Do NOT play music, open panels, or enable layers unless explicitly asked.
- Do NOT introduce yourself or give long greetings. Just respond to what the user says.
- Do NOT give unsolicited suggestions or offer to do things. Wait for the user to ask.
- Never invent tool names or arguments not listed above.
- If unsure what the user wants, ask a short clarifying question.`;

// ── SearXNG Web Search ─────────────────────────────────────────────────────────
async function searchWeb(query) {
  try {
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&categories=general,news`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`SearXNG ${res.status}`);
    const data = await res.json();
    const results = (data.results || []).slice(0, 5).map(r => ({
      title: r.title,
      url: r.url,
      snippet: (r.content || '').slice(0, 200),
    }));
    return results;
  } catch (err) {
    console.error('[Voice] SearXNG error:', err.message);
    return [];
  }
}

// ── Whisper transcription ───────────────────────────────────────────────────────
async function transcribeAudio(base64Audio, format = 'webm') {
  const { writeFileSync, unlinkSync, readFileSync } = await import('node:fs');
  const audioBuffer = Buffer.from(base64Audio, 'base64');
  const tmpInput = join(tmpdir(), `gev-whisper-in-${Date.now()}.${format === 'wav' ? 'wav' : 'webm'}`);
  writeFileSync(tmpInput, audioBuffer);

  let tmpWav = tmpInput;
  try {
    // Convert webm/opus to WAV if needed (whisper-server only accepts WAV/PCM)
    if (format !== 'wav') {
      tmpWav = join(tmpdir(), `gev-whisper-${Date.now()}.wav`);
      const inputSize = audioBuffer.length;
      console.log(`[Voice] ffmpeg converting ${inputSize} bytes ${format} → WAV`);
      if (inputSize < 100) {
        throw new Error(`Audio too small (${inputSize} bytes), skipping`);
      }
      await new Promise((resolve, reject) => {
        const cmd = `ffmpeg -y -i ${tmpInput} -ar 16000 -ac 1 -f wav ${tmpWav}`;
        console.log(`[Voice] ffmpeg cmd: ${cmd}`);
        exec(cmd, (error, stdout, stderr) => {
          if (error) {
            console.error('[Voice] ffmpeg error:', error.code, 'signal:', error.signal);
            console.error('[Voice] ffmpeg stderr:', (stderr || '').slice(-500));
            reject(new Error(`ffmpeg exit ${error.code}`));
          } else {
            resolve();
          }
        });
      });
    }

    // whisper-server expects multipart/form-data file upload
    const wavBuffer = readFileSync(tmpWav);
    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
    const res = await fetch(`${WHISPER_URL}/inference`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) throw new Error(`Whisper ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.text || '').trim();
  } catch (err) {
    console.error('[Voice] Whisper HTTP failed, trying CLI:', err.message);
    return transcribeViaCli(tmpWav);
  } finally {
    try { unlinkSync(tmpInput); } catch {}
    if (tmpWav !== tmpInput) try { unlinkSync(tmpWav); } catch {}
  }
}

async function transcribeViaCli(wavPath) {
  const whisperCli = process.env.WHISPER_CLI || join(__dirname, 'whisper', 'whisper-cli.exe');
  const whisperModel = process.env.WHISPER_MODEL || join(__dirname, 'whisper', 'models', 'ggml-base.bin');
  return new Promise((resolve, reject) => {
    const proc = spawn(whisperCli, [
      '-m', whisperModel,
      '-f', wavPath,
      '--language', 'en',
      '--output_format', 'txt',
      '--output_dir', tmpdir(),
      '--no-prints',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.on('close', () => {
      const txtPath = wavPath.replace(/\.\w+$/, '.txt');
      try {
        const { readFileSync, unlinkSync } = require('fs');
        const text = readFileSync(txtPath, 'utf8').trim();
        unlinkSync(txtPath);
        resolve(text);
      } catch {
        resolve(stdout.trim());
      }
    });
    proc.on('error', reject);
  });
}

// ── LLM streaming ──────────────────────────────────────────────────────────────
async function streamLlm(userText, context, onText, onToolCall) {
  const contextStr = context
    ? `\n\nCURRENT VIEW CONTEXT:\n${JSON.stringify(context, null, 0)}`
    : '';

  const res = await fetch(`${LM_STUDIO_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + contextStr },
        { role: 'user', content: userText },
      ],
      stream: true,
      temperature: 0.7,
      max_tokens: 300,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LM Studio ${res.status}: ${err}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') break;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        if (delta) {
          fullText += delta;
          onText(delta);
        }
      } catch {}
    }
  }

  // Parse tool calls from full response
  console.log('[Voice] LLM response:', fullText.slice(0, 200));
  const toolRegex = /\[TOOL\]\s+(\w+)\s+(\{.*?\})/gs;
  const toolMatches = [...fullText.matchAll(toolRegex)];

  if (toolMatches.length > 0) {
    const spokenPart = fullText.slice(0, toolMatches[0].index).trim();
    const toolCalls = toolMatches.map((m) => {
      let args = {};
      try { args = JSON.parse(m[2]); } catch {}
      return { name: m[1], args };
    });

    // Handle search_web tool — query SearXNG and return results
    if (toolCalls[0].name === 'search_web' && toolCalls[0].args.query) {
      console.log('[Voice] Web search:', toolCalls[0].args.query);
      const results = await searchWeb(toolCalls[0].args.query);
      onToolCall('search_web', { query: toolCalls[0].args.query, results }, spokenPart);
      return spokenPart;
    }

    // Handle enrich_entity — server-side public data lookup
    if (toolCalls[0].name === 'enrich_entity' && toolCalls[0].args.entityType) {
      const { entityType, identifier, latitude, longitude } = toolCalls[0].args;
      console.log(`[Voice] Entity enrich: ${entityType} / ${identifier}`);
      const enrichResult = await lookupEntity(entityType, identifier, { latitude, longitude });
      onToolCall('enrich_entity', { entityType, identifier, __result: enrichResult }, spokenPart);
      return spokenPart;
    }

    // Send all tool calls to client for sequential execution
    for (const tc of toolCalls) {
      console.log('[Voice] Tool call:', tc.name, JSON.stringify(tc.args).slice(0, 100));
      onToolCall(tc.name, tc.args, spokenPart);
    }
    return spokenPart;
  }

  return fullText.trim();
}

// ── Piper TTS ──────────────────────────────────────────────────────────────────
async function textToSpeech(text) {
  if (!text || text.length < 3) return null;

  return new Promise((resolve, reject) => {
    console.log('[Voice] TTS input:', text.slice(0, 80));
    const proc = spawn(PIPER_BIN_ABS, [
      '--model', VOICE_MODEL_ABS,
      '--output-raw',
    ], { cwd: PIPER_DIR, stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks = [];
    let stderrData = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { stderrData += d.toString(); });

    proc.on('close', (code) => {
      const pcm = Buffer.concat(chunks);
      console.log(`[Voice] TTS output: ${pcm.length} bytes, piper exit: ${code}`);
      if (stderrData) console.error('[Voice] Piper stderr:', stderrData.slice(0, 300));
      if (pcm.length === 0) { resolve(null); return; }
      // Piper outputs 22050Hz 16-bit mono PCM — wrap in WAV header
      const wav = rawPcmToWav(pcm, 22050, 1, 16);
      resolve(wav.toString('base64'));
    });

    proc.on('error', (err) => {
      console.error('[Voice] Piper error:', err.message);
      resolve(null);
    });

    proc.stdin.write(text);
    proc.stdin.end();
  });
}

function rawPcmToWav(pcm, sampleRate, channels, bitsPerSample) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);       // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

// ── Sentence splitting for TTS ─────────────────────────────────────────────────
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

// ── WebSocket server ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  console.log('[Voice] Client connected');

  // Per-connection audio buffer
  let audioChunks = [];
  let audioFormat = 'pcm'; // 'pcm' or 'webm'
  let context = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      // ── Audio chunk from browser ──
      case 'audio': {
        audioChunks.push(msg.data); // base64-encoded audio
        audioFormat = msg.format || 'pcm';
        break;
      }

      // ── Set viewport context for LLM ──
      case 'context': {
        context = msg.context;
        break;
      }

      // ── Process accumulated audio (user stopped speaking) ──
      case 'process': {
        if (audioChunks.length === 0) {
          ws.send(JSON.stringify({ type: 'error', error: 'No audio recorded' }));
          return;
        }

        const allAudio = audioChunks.join('');
        audioChunks = [];
        const fmt = audioFormat || 'webm';

        try {
          // 1. Transcribe
          ws.send(JSON.stringify({ type: 'status', status: 'transcribing' }));
          const transcript = await transcribeAudio(allAudio, fmt);

          if (!transcript || transcript.length < 2) {
            ws.send(JSON.stringify({ type: 'transcript', text: '' }));
            ws.send(JSON.stringify({ type: 'status', status: 'listening' }));
            return;
          }

          ws.send(JSON.stringify({ type: 'transcript', text: transcript }));

          // 2. LLM inference
          ws.send(JSON.stringify({ type: 'status', status: 'thinking' }));
          let spokenText = '';
          let fullResponse = '';

          fullResponse = await streamLlm(transcript, context,
            // onText — stream text deltas
            (delta) => {
              ws.send(JSON.stringify({ type: 'text_delta', text: delta }));
            },
            // onToolCall
            (name, args, spoken) => {
              spokenText = spoken;
              ws.send(JSON.stringify({
                type: 'function_call',
                name,
                arguments: args,
              }));
            }
          );

          // 3. TTS on the spoken response
          const ttsText = spokenText || fullResponse;
          if (ttsText && ttsText.length > 3) {
            ws.send(JSON.stringify({ type: 'status', status: 'speaking' }));
            const wavBase64 = await textToSpeech(ttsText);
            if (wavBase64) {
              // Decode WAV to raw PCM16 — simpler for client playback
              const wavBuf = Buffer.from(wavBase64, 'base64');
              const pcm16 = wavBuf.subarray(44); // strip 44-byte WAV header
              const pcm16B64 = pcm16.toString('base64');
              console.log(`[Voice] Sending TTS audio: ${pcm16.length} bytes PCM16`);
              ws.send(JSON.stringify({
                type: 'audio',
                data: pcm16B64,
                format: 'pcm16',
                sampleRate: 22050,
                final: true,
              }));
            }
          }

          ws.send(JSON.stringify({ type: 'status', status: 'listening' }));

        } catch (err) {
          console.error('[Voice] Pipeline error:', err);
          ws.send(JSON.stringify({ type: 'error', error: err.message }));
          ws.send(JSON.stringify({ type: 'status', status: 'listening' }));
        }
        break;
      }

      // ── Direct text input (bypass STT) ──
      case 'text': {
        try {
          ws.send(JSON.stringify({ type: 'status', status: 'thinking' }));

          let spokenText = '';
          await streamLlm(msg.text, context,
            (delta) => {
              ws.send(JSON.stringify({ type: 'text_delta', text: delta }));
            },
            (name, args, spoken) => {
              spokenText = spoken;
              ws.send(JSON.stringify({
                type: 'function_call',
                name,
                arguments: args,
              }));
            }
          );

          const ttsText = spokenText || '';
          if (ttsText.length > 3) {
            ws.send(JSON.stringify({ type: 'status', status: 'speaking' }));
            const wavBase64 = await textToSpeech(ttsText);
            if (wavBase64) {
              const wavBuf = Buffer.from(wavBase64, 'base64');
              const pcm16 = wavBuf.subarray(44);
              const pcm16B64 = pcm16.toString('base64');
              ws.send(JSON.stringify({
                type: 'audio',
                data: pcm16B64,
                format: 'pcm16',
                sampleRate: 22050,
                final: true,
              }));
            }
          }

          ws.send(JSON.stringify({ type: 'status', status: 'listening' }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: err.message }));
          ws.send(JSON.stringify({ type: 'status', status: 'listening' }));
        }
        break;
      }

      // ── Tool result from client (e.g., search_web results) ──
      case 'tool_result': {
        try {
          const toolName = msg.tool_call_id;
          const resultContent = msg.content || '';

          if (toolName === 'search_web') {
            // Feed search results back to LLM for a natural language response
            ws.send(JSON.stringify({ type: 'status', status: 'thinking' }));

            const searchPrompt = `The web search returned these results:\n${resultContent}\n\nBased on these results, give a brief spoken answer to the user's question. Keep it to 2-3 sentences.`;

            let spokenText = '';
            await streamLlm(searchPrompt, context,
              (delta) => {
                ws.send(JSON.stringify({ type: 'text_delta', text: delta }));
              },
              (name, args, spoken) => {
                spokenText = spoken;
              }
            );

            const ttsText = spokenText || '';
            if (ttsText && ttsText.length > 3) {
              ws.send(JSON.stringify({ type: 'status', status: 'speaking' }));
              const wavBase64 = await textToSpeech(ttsText);
              if (wavBase64) {
                const wavBuf = Buffer.from(wavBase64, 'base64');
                const pcm16 = wavBuf.subarray(44);
                const pcm16B64 = pcm16.toString('base64');
                ws.send(JSON.stringify({
                  type: 'audio',
                  data: pcm16B64,
                  format: 'pcm16',
                  sampleRate: 22050,
                  final: true,
                }));
              }
            }
          }

          if (toolName === 'enrich_entity') {
            // Feed enriched entity data back to LLM for a natural language summary
            ws.send(JSON.stringify({ type: 'status', status: 'thinking' }));

            const enrichPrompt = `The entity lookup returned this data:\n${resultContent}\n\nGive a brief spoken summary of this entity's current status. Highlight the most important fields (altitude, speed, route for flights; magnitude for earthquakes; orbital period for satellites). Keep it to 2-3 sentences.`;

            let spokenText = '';
            await streamLlm(enrichPrompt, context,
              (delta) => {
                ws.send(JSON.stringify({ type: 'text_delta', text: delta }));
              },
              (name, args, spoken) => {
                spokenText = spoken;
              }
            );

            const ttsText = spokenText || '';
            if (ttsText && ttsText.length > 3) {
              ws.send(JSON.stringify({ type: 'status', status: 'speaking' }));
              const wavBase64 = await textToSpeech(ttsText);
              if (wavBase64) {
                const wavBuf = Buffer.from(wavBase64, 'base64');
                const pcm16 = wavBuf.subarray(44);
                const pcm16B64 = pcm16.toString('base64');
                ws.send(JSON.stringify({
                  type: 'audio',
                  data: pcm16B64,
                  format: 'pcm16',
                  sampleRate: 22050,
                  final: true,
                }));
              }
            }
          }

          ws.send(JSON.stringify({ type: 'status', status: 'listening' }));
        } catch (err) {
          console.error('[Voice] tool_result error:', err);
          ws.send(JSON.stringify({ type: 'error', error: err.message }));
          ws.send(JSON.stringify({ type: 'status', status: 'listening' }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log('[Voice] Client disconnected');
  });
});

console.log(`[Voice] Server listening on ws://0.0.0.0:${PORT}`);
console.log(`[Voice] Whisper: ${WHISPER_URL}`);
console.log(`[Voice] LM Studio: ${LM_STUDIO_URL}`);
console.log(`[Voice] Piper: ${PIPER_BIN_ABS} (${VOICE_MODEL_ABS})`);
console.log(`[Voice] LLM: ${LLM_MODEL}`);
