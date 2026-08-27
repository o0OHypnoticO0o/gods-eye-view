/**
 * LocalVoiceController — drop-in replacement for GevRealtimeController
 * that uses a WebSocket connection to a local voice-server.mjs instead of
 * the OpenAI Realtime API over WebRTC.
 *
 * Protocol (JSON over WebSocket):
 *   Client → Server:
 *     { type: 'audio', data: '<base64 webm/opus>', format: 'webm' }
 *     { type: 'start' }
 *     { type: 'stop' }
 *     { type: 'tool_result', tool_call_id: '...', content: '...' }
 *   Server → Client:
 *     { type: 'ready' }
 *     { type: 'transcript', text: '...' }
 *     { type: 'llm_delta', text: '...' }
 *     { type: 'llm_done', text: '...' }
 *     { type: 'function_call', id: '...', name: '...', arguments: '...' }
 *     { type: 'audio', data: '<base64 pcm16 24kHz>', format: 'pcm16' }
 *     { type: 'error', error: '...' }
 */

import { createVoiceControl } from './gevRealtime.js';
import { createGevActionRunner } from './gevActions.js';

const WS_URL = import.meta.env.LOCAL_VOICE_WS_URL;
const AUDIO_MIME = 'audio/webm;codecs=opus';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}

/* ------------------------------------------------------------------ */
/*  initLocalVoiceCommands — public entry point                       */
/* ------------------------------------------------------------------ */

export function initLocalVoiceCommands({ viewer, styleManager, dataManager, sceneDirector, annotations } = {}) {
  if (!WS_URL) return null;

  if (window.__gevVoiceCommands && typeof window.__gevVoiceCommands.stop === 'function') {
    window.__gevVoiceCommands.stop({ removeUi: true });
  }

  const runner = createGevActionRunner({ viewer, styleManager, dataManager, sceneDirector, annotations });
  const ui = createVoiceControl({ reset: true });

  const ctrl = new LocalVoiceController({ runner, ui, dataManager, viewer, styleManager });
  ctrl.buttonHandler = () => {
    if (ctrl.isActive()) ctrl.stop();
    else ctrl.start();
  };
  ui.button.addEventListener('click', ctrl.buttonHandler);

  if (ui.tierButton) {
    ui.tierButton.style.display = 'none'; // hide tier toggle for local voice
  }

  window.__gevVoiceCommands = ctrl;
  return ctrl;
}

/* ------------------------------------------------------------------ */
/*  LocalVoiceController                                              */
/* ------------------------------------------------------------------ */

class LocalVoiceController {
  constructor({ runner, ui, dataManager, viewer, styleManager }) {
    this.runner = runner;
    this.ui = ui;
    this.dataManager = dataManager;
    this.viewer = viewer;
    this.styleManager = styleManager;

    this._ws = null;
    this._mediaStream = null;
    this._recorder = null;
    this._active = false;
    this._audioQueue = [];
    this._playing = false;
    this._audioCtx = null;
    this._fullResponse = '';
    this._toolResults = {};
    this._contextInterval = null;
    this._vadCtx = null;
    this._toolQueue = [];
    this._toolRunning = false;
  }

  /* ---- lifecycle ---- */

  async start() {
    if (this._active) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 44100,
        },
      });
      this._mediaStream = stream;
      this._active = true;

      this.ui.root.dataset.status = 'listening';
      this.ui.root.dataset.speaker = 'idle';
      this.ui.status.textContent = 'LISTENING';
      this.ui.detail.textContent = 'VOICE ACTIVE — speak now';
      this.ui.buttonLabel.textContent = 'ON';
      this.ui.costValue.style.display = 'none';

      this._connect();
    } catch (err) {
      console.error('[LocalVoice] mic access denied', err);
      this.ui.root.dataset.status = 'error';
      this.ui.detail.textContent = 'MICROPHONE ACCESS DENIED';
    }
  }

  stop({ removeUi = false } = {}) {
    this._active = false;
    this._stopContextSender();

    if (this._recorder && this._recorder.state !== 'inactive') {
      this._recorder.stop();
    }
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach(t => t.stop());
      this._mediaStream = null;
    }
    if (this._ws) {
      try { this._ws.send(JSON.stringify({ type: 'stop' })); } catch {}
      this._ws.close();
      this._ws = null;
    }

    this._audioQueue = [];
    this._playing = false;
    if (this._audioCtx) { this._audioCtx.close().catch(() => {}); this._audioCtx = null; }
    if (this._vadCtx) { this._vadCtx.close().catch(() => {}); this._vadCtx = null; }

    this.ui.root.dataset.status = 'idle';
    this.ui.root.dataset.speaker = 'idle';
    this.ui.status.textContent = 'OFF';
    this.ui.detail.textContent = 'VOICE STANDBY';
    this.ui.buttonLabel.textContent = 'ON/OFF';
    this.ui.costValue.style.display = '';

    if (removeUi) {
      this.ui.root.remove();
    }
  }

  isActive() { return this._active; }

  /* ---- WebSocket ---- */

  _connect() {
    const ws = new WebSocket(WS_URL);
    this._ws = ws;

    ws.onopen = () => {
      console.log('[LocalVoice] connected to', WS_URL);
      this.ui.detail.textContent = 'VOICE ACTIVE — speak now';
      this._startRecording();
      this._startContextSender();
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      this._handleMessage(msg);
    };

    ws.onerror = (err) => {
      console.error('[LocalVoice] ws error', err);
      this.ui.detail.textContent = 'CONNECTION ERROR';
    };

    ws.onclose = () => {
      this._stopContextSender();
      if (this._active) {
        this.ui.root.dataset.status = 'idle';
        this.ui.status.textContent = 'OFF';
        this.ui.detail.textContent = 'VOICE DISCONNECTED';
      }
    };
  }

  /* ---- context sender: periodically send viewport state to LLM ---- */

  _startContextSender() {
    this._stopContextSender();
    const send = () => {
      if (!this._ws || this._ws.readyState !== 1) return;
      try {
        const ctx = this._buildContext();
        if (ctx) this._ws.send(JSON.stringify({ type: 'context', context: ctx }));
      } catch {}
    };
    send(); // send immediately on connect
    this._contextInterval = setInterval(send, 3000); // every 3s
  }

  _stopContextSender() {
    if (this._contextInterval) {
      clearInterval(this._contextInterval);
      this._contextInterval = null;
    }
  }

  _buildContext() {
    if (!this.viewer) return null;
    try {
      const Cesium = window.Cesium;
      if (!Cesium) return null;
      const cartographic = Cesium.Cartographic.fromCartesian(this.viewer.camera.positionWC);
      const layers = (this.dataManager?.getAll?.() || []).map(l => ({
        id: l.id,
        name: l.name,
        enabled: l.enabled,
        count: l.stats?.count || 0,
      }));
      return {
        camera: {
          latitude: Number(Cesium.Math.toDegrees(cartographic.latitude).toFixed(4)),
          longitude: Number(Cesium.Math.toDegrees(cartographic.longitude).toFixed(4)),
          heightM: Math.round(cartographic.height),
        },
        layers,
        style: this.styleManager?.activeStyle || 'normal',
      };
    } catch { return null; }
  }

  /* ---- audio capture ---- */

  _startRecording() {
    if (!this._mediaStream || this._recorder?.state === 'recording') return;

    const rec = new MediaRecorder(this._mediaStream, {
      mimeType: AUDIO_MIME,
      audioBitsPerSecond: 64_000,
    });
    this._recorder = rec;

    // ── VAD: Voice Activity Detection via frequency-band analysis ──
    // Reuse a single AudioContext across recordings (browsers throttle > ~6)
    if (!this._vadCtx) {
      this._vadCtx = new AudioContext({ sampleRate: 44100 });
    }
    const audioCtx = this._vadCtx;
    const source = audioCtx.createMediaStreamSource(this._mediaStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048; // higher resolution for frequency analysis
    source.connect(analyser);

    const binCount = analyser.frequencyBinCount; // 1024
    const freqData = new Uint8Array(binCount);
    const sampleRate = audioCtx.sampleRate;
    const binSize = sampleRate / analyser.fftSize; // ~21.5 Hz per bin

    // Voice frequency band: 85Hz – 3000Hz (fundamental + harmonics)
    const voiceLowBin = Math.floor(85 / binSize);
    const voiceHighBin = Math.ceil(3000 / binSize);

    // VAD state with hysteresis
    let speechActive = false;
    let silenceTimer = null;
    let speechStartTime = 0;
    let totalSpeechMs = 0;           // cumulative speech time in current utterance
    let lastSpeechTime = 0;
    const SPEECH_THRESHOLD = 0.15;    // voice-band energy ratio to declare speech
    const MIN_SPEECH_MS = 500;        // ignore blips < 500ms
    const SILENCE_TIMEOUT_MS = 4000;  // 4s of silence → process (long natural pauses)
    const MIN_SPEECH_BEFORE_END_MS = 1500; // need ≥1.5s speech before silence can end it
    const ENERGY_FLOOR = 12;          // ignore digital noise floor

    // Accumulate MediaRecorder Blobs for current utterance
    let audioBuffers = [];

    const checkVad = () => {
      // Stop VAD loop if recorder was stopped (e.g. by _sendUtterance)
      if (!this._active || rec.state !== 'recording') return;
      // Don't detect speech while TTS is playing — prevents echo feedback
      if (this._playing) {
        speechActive = false;
        totalSpeechMs = 0;
        clearTimeout(silenceTimer);
        silenceTimer = null;
        audioBuffers = [];
        requestAnimationFrame(checkVad);
        return;
      }
      analyser.getByteFrequencyData(freqData);

      // Calculate energy in voice band vs total
      let voiceEnergy = 0;
      let totalEnergy = 0;
      for (let i = 0; i < binCount; i++) {
        const v = freqData[i];
        totalEnergy += v;
        if (i >= voiceLowBin && i <= voiceHighBin) voiceEnergy += v;
      }
      const voiceRatio = totalEnergy > 0 ? voiceEnergy / totalEnergy : 0;
      const avgEnergy = totalEnergy / binCount;

      // Speech detected: voice-band energy is dominant AND above noise floor
      const isSpeech = avgEnergy > ENERGY_FLOOR && voiceRatio > SPEECH_THRESHOLD;
      const now = performance.now();

      if (isSpeech) {
        if (!speechActive) {
          speechActive = true;
          speechStartTime = now;
          lastSpeechTime = now;
          clearTimeout(silenceTimer);
          silenceTimer = null;
          console.log('[VAD] speech started');
        } else {
          // Accumulate speech time (track gaps to avoid counting silence)
          totalSpeechMs += now - lastSpeechTime;
          lastSpeechTime = now;
        }
      } else if (speechActive) {
        if (!silenceTimer) {
          silenceTimer = setTimeout(() => {
            speechActive = false;
            silenceTimer = null;

            // Ignore very short utterances (noise blips)
            if (totalSpeechMs < MIN_SPEECH_MS || audioBuffers.length === 0) {
              audioBuffers = [];
              totalSpeechMs = 0;
              console.log(`[VAD] ignoring short utterance: ${Math.round(totalSpeechMs)}ms`);
              return;
            }

            // Not enough speech yet — user is pausing mid-sentence, restart timer
            if (totalSpeechMs < MIN_SPEECH_BEFORE_END_MS) {
              console.log(`[VAD] pause but only ${Math.round(totalSpeechMs)}ms speech — waiting`);
              silenceTimer = setTimeout(() => {
                silenceTimer = null;
                console.log(`[VAD] speech ended (${Math.round(totalSpeechMs)}ms) — processing`);
                this._sendUtterance(audioBuffers);
                audioBuffers = [];
                totalSpeechMs = 0;
              }, SILENCE_TIMEOUT_MS);
              return;
            }

            console.log(`[VAD] speech ended (${Math.round(totalSpeechMs)}ms) — processing`);
            this._sendUtterance(audioBuffers);
            audioBuffers = [];
            totalSpeechMs = 0;
          }, SILENCE_TIMEOUT_MS);
        }
      }

      requestAnimationFrame(checkVad);
    };
    requestAnimationFrame(checkVad);

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioBuffers.push(e.data);
    };

    rec.start(200); // chunk every 200ms
  }

  /* ---- Send utterance and restart recorder for next one ---- */

  async _sendUtterance(buffers) {
    if (buffers.length === 0) return;

    // Stop current recorder — triggers onstop, frees the stream
    const rec = this._recorder;
    if (rec && rec.state === 'recording') rec.stop();

    // Build complete webm blob (has EBML headers since it's a fresh recording)
    const blob = new Blob(buffers, { type: AUDIO_MIME });
    const buf = await blob.arrayBuffer();
    const b64 = arrayBufferToB64(buf);
    this._ws.send(JSON.stringify({ type: 'audio', data: b64, format: 'webm' }));
    this._ws.send(JSON.stringify({ type: 'process' }));
    this.ui.detail.textContent = 'PROCESSING...';

    // Restart recorder for next utterance (new recording = fresh webm headers)
    setTimeout(() => this._startRecording(), 100);
  }

  /* ---- message handling ---- */

  async _handleMessage(msg) {
    switch (msg.type) {
      case 'ready':
        console.log('[LocalVoice] server ready');
        this._startRecording();
        break;

      case 'transcript':
        if (msg.text) {
          this.ui.root.dataset.status = 'processing';
          this.ui.detail.textContent = msg.text;
        }
        break;

      case 'llm_delta':
        if (msg.text) {
          this._fullResponse += msg.text;
          this.ui.detail.textContent = this._fullResponse.slice(-120);
        }
        break;

      case 'llm_done':
        this._fullResponse = '';
        break;

      case 'function_call':
        this._toolQueue.push(msg);
        this._processToolQueue();
        break;

      case 'audio':
        if (msg.data) {
          this._lastSampleRate = msg.sampleRate || 22050;
          this._enqueueTts(msg.data, msg.format || 'pcm16', msg.sampleRate);
        }
        break;

      case 'error':
        console.error('[LocalVoice] server error:', msg.error);
        this.ui.root.dataset.status = 'error';
        this.ui.detail.textContent = msg.error || 'VOICE ERROR';
        break;

      default:
        break;
    }
  }

  /* ---- function call dispatch ---- */

  async _processToolQueue() {
    if (this._toolRunning) return;
    this._toolRunning = true;
    while (this._toolQueue.length > 0) {
      const msg = this._toolQueue.shift();
      await this._dispatchFunctionCall(msg);
    }
    this._toolRunning = false;
  }

  async _dispatchFunctionCall(msg) {
    const name = msg.name;
    const args = parseArgs(msg.arguments);

    // search_web is handled server-side — send results back for LLM follow-up
    if (name === 'search_web' && args.results) {
      if (this._ws && this._ws.readyState === 1) {
        this._ws.send(JSON.stringify({
          type: 'tool_result',
          tool_call_id: 'search_web',
          content: JSON.stringify(args.results),
        }));
      }
      return;
    }

    // enrich_entity is handled server-side — forward the result for LLM follow-up
    if (name === 'enrich_entity' && args.__result) {
      if (this._ws && this._ws.readyState === 1) {
        this._ws.send(JSON.stringify({
          type: 'tool_result',
          tool_call_id: 'enrich_entity',
          content: JSON.stringify(args.__result),
        }));
      }
      return;
    }

    // If the server sent the tool result payload, record it and stop
    if (args.__result_text !== undefined) {
      this._toolResults[name] = args.__result_text;
      return;
    }

    try {
      const result = await this.runner(name, args);

      if (this._ws && this._ws.readyState === 1) {
        this._ws.send(JSON.stringify({
          type: 'tool_result',
          tool_call_id: msg.id || name,
          content: typeof result === 'string' ? result : JSON.stringify(result ?? ''),
        }));
      }
    } catch (err) {
      console.error(`[LocalVoice] action "${name}" failed:`, err);
      if (this._ws && this._ws.readyState === 1) {
        this._ws.send(JSON.stringify({
          type: 'tool_result',
          tool_call_id: msg.id || name,
          content: `Error: ${err.message || err}`,
          is_error: true,
        }));
      }
    }
  }

  /* ---- TTS playback ---- */

  _enqueueTts(b64, format, sampleRate) {
    this._audioQueue.push({ b64, format, sampleRate });
    if (!this._playing) this._playNext();
  }

  async _playNext() {
    if (this._audioQueue.length === 0) {
      this._playing = false;
      this.ui.root.dataset.speaker = 'idle';
      this.ui.detail.textContent = 'VOICE ACTIVE — speak now';
      return;
    }

    this._playing = true;
    this.ui.root.dataset.speaker = 'speaking';
    this.ui.detail.textContent = 'SPEAKING...';

    const { b64, format, sampleRate } = this._audioQueue.shift();

    try {
      const ctx = this._audioCtx || new AudioContext({ sampleRate: 44100 });
      this._audioCtx = ctx;

      // Resume context if suspended (browser autoplay policy)
      if (ctx.state === 'suspended') await ctx.resume();

      const raw = b64ToArrayBuffer(b64);
      let audioBuffer;

      if (format === 'wav') {
        // Decode WAV — browser resamples to match AudioContext rate
        const blob = new Blob([raw], { type: 'audio/wav' });
        audioBuffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      } else if (format === 'pcm16') {
        const int16 = new Int16Array(raw);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 32768;
        }
        const srcRate = sampleRate || this._lastSampleRate || 22050;
        audioBuffer = ctx.createBuffer(1, float32.length, srcRate);
        audioBuffer.getChannelData(0).set(float32);
      } else {
        const blob = new Blob([raw], { type: 'audio/webm' });
        audioBuffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      }

      await playBuffer(ctx, audioBuffer);
      this._playNext();
    } catch (err) {
      console.error('[LocalVoice] TTS playback error', err);
      this._playNext();
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Audio helpers                                                     */
/* ------------------------------------------------------------------ */

function arrayBufferToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function playBuffer(ctx, buffer) {
  return new Promise((resolve) => {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // Reduce volume to prevent speaker feedback and ear-blasting
    const gainNode = ctx.createGain();
    gainNode.gain.value = 0.18;
    source.connect(gainNode);
    gainNode.connect(ctx.destination);
    source.onended = resolve;
    source.start();
  });
}
