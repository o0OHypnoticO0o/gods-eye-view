# Local Voice Pipeline Setup

Replace OpenAI's Realtime API with a fully local voice pipeline: **Whisper.cpp** (STT) → **LM Studio** (LLM) → **Piper** (TTS).

## Requirements

- **Node.js** ≥ 18
- **Whisper.cpp** — speech-to-text (GPU-accelerated via ROCm on AMD, or CPU)
- **Piper TTS** — text-to-speech (CPU, fast)
- **LM Studio** — local LLM inference (running at your configured endpoint)

## Quick Start

### 1. Install Whisper.cpp

#### ROCm (AMD GPU, e.g. Radeon 7900 XTX)

```bash
# Install ROCm if not already present
# See: https://rocm.docs.amd.com/en/latest/

# Build whisper.cpp with ROCm backend
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build -DGGML_HIP=ON
cmake --build build --config Release -j$(nproc)

# Download a model (large-v3 recommended for accuracy)
bash models/download-ggml-model.sh large-v3

# Test
./build/bin/whisper-cli -m models/ggml-large-v3.bin -f samples/jfk.wav
```

#### CPU-only (any platform)

```bash
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build --config Release -j$(nproc)
bash models/download-ggml-model.sh large-v3
```

### 2. Install Piper TTS

```bash
# Download from https://github.com/rhasspy/piper/releases
# Linux x86_64:
wget https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
tar xzf piper_linux_x86_64.tar.gz

# Download a voice model
mkdir -p piper-voices
cd piper-voices
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json
cd ..

# Test
./piper/piper --model piper-voices/en_US-amy-medium.onnx --output_file test.wav <<< "Hello from Piper."
```

### 3. Start LM Studio

1. Open LM Studio
2. Load a model (e.g. Qwen 3.6 35B)
3. Start the local server (default: `http://localhost:1234/v1`)

### 4. Start the Voice Server

```bash
# From the gods-eye-view project root
node voice-server.mjs
```

The server starts on `ws://localhost:8765` by default. Configure with env vars:

| Variable | Default | Description |
|---|---|---|
| `WHISPER_PATH` | `./whisper.cpp/build/bin/whisper-cli` | Path to whisper-cli binary |
| `WHISPER_MODEL` | `./whisper.cpp/models/ggml-large-v3.bin` | Path to GGML model file |
| `PIPER_PATH` | `./piper/piper` | Path to piper binary |
| `PIPER_MODEL` | `./piper-voices/en_US-amy-medium.onnx` | Path to voice model |
| `LLM_URL` | `http://localhost:1234/v1/responses` | LM Studio endpoint |
| `LLM_MODEL` | `qwen3.6-35b-a3b-mtp` | Model name |
| `LLM_API_KEY` | `lm-studio` | API key (LM Studio ignores this) |
| `PORT` | `8765` | WebSocket port |

Example for a remote inference host:

```bash
LLM_URL=http://10.10.10.253:1234/v1/responses \
WHISPER_PATH=/usr/local/bin/whisper-cli \
PIPER_PATH=/opt/piper/piper \
node voice-server.mjs
```

### 5. Configure the Frontend

In your `.env` file:

```
LOCAL_VOICE_WS_URL=ws://10.10.10.253:8765
```

This tells the browser to connect to the voice server via WebSocket instead of OpenAI's Realtime API.

If `LOCAL_VOICE_WS_URL` is not set, the app falls back to OpenAI's voice API (requires API key).

## Architecture

```
Browser                    Voice Server                Inference Host
┌──────────┐              ┌──────────────┐            ┌──────────────┐
│ MediaRec │──webm/opus──▶│ Whisper.cpp  │            │              │
│ (200ms)  │              │    (STT)     │            │              │
│          │              │      │       │            │              │
│          │              │      ▼       │            │              │
│          │              │ LM Studio    │──requests──▶│ Qwen 3.6 35B│
│          │              │   (LLM)      │◀──stream───│              │
│          │              │      │       │            │              │
│          │              │      ▼       │            │              │
│          │◀──pcm16─────│ Piper TTS    │            │              │
│ AudioCtx │              │    (TTS)     │            │              │
│ (play)   │              └──────────────┘            └──────────────┘
│          │
│ gevActions│◀──function_call──┘
│ (dispatch)│
└──────────┘
```

## Troubleshooting

**Voice button does nothing**
- Check that `LOCAL_VOICE_WS_URL` is set in `.env`
- Open browser console — look for `[LocalVoice]` messages
- Ensure the voice server is running and accessible

**"MICROPHONE ACCESS DENIED"**
- Browser requires HTTPS for mic access on non-localhost origins
- For local dev, use `https://localhost` or add the origin to your browser's secure origins list

**Whisper is slow**
- Ensure GPU acceleration is enabled (ROCm/CUDA)
- Use a smaller model: `medium` or `small` instead of `large-v3`
- Check GPU utilization with `rocm-smi` (AMD) or `nvidia-smi` (NVIDIA)

**No audio response from Piper**
- Test Piper directly: `echo "test" | ./piper/piper --model voice.onnx --output_file test.wav`
- Ensure the `.onnx.json` config file is in the same directory as the `.onnx` file

**WebSocket connection fails**
- Ensure the voice server port (default 8765) is open
- Check firewall rules if running on a different host
- For remote hosts, use the machine's IP, not `localhost`
