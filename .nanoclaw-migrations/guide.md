# NanoClaw Migration Guide

Generated: 2026-04-24
Last upgraded: 2026-07-02 (v2.0.13 → v2.1.24 migration)
Base: eba94b721ab8c7476e97d6600ca7ee4c0e53249c (v1.2.53 → v2.0.13 migration)
HEAD at generation: 8d852220
Upstream: aecad864 (upstream/main at time of last migration)

---

## Applied Skills

No skill branches were merged from upstream — the Telegram channel is a **custom implementation** using Grammy (not the upstream channels-branch adapter). All other skills in `.claude/skills/` were operationally installed and require no branch re-merge.

Custom skills to copy as-is from the pre-migration backup branch (`pre-migrate-8abcb1d1-20260424-145214`):
- `.claude/skills/add-macos-statusbar/`
- `.claude/skills/get-qodo-rules/`
- `.claude/skills/qodo-pr-resolver/`
- `.claude/skills/claw/`

---

## Skill Interactions

None — the Telegram channel is standalone with no conflicts with other installed skills.

---

## Customizations

### 1. Telemetry opt-out

**Intent:** Disable PostHog anonymous telemetry collected during setup and update-nanoclaw flows.

**Files:**
- `.claude/skills/update-nanoclaw/diagnostics.md` → replace with `# Diagnostics — opted out`
- `.claude/skills/update-nanoclaw/SKILL.md` → remove the `## Diagnostics` section
- `.claude/skills/migrate-nanoclaw/diagnostics.md` → replace with `# Diagnostics — opted out`
- `.claude/skills/migrate-nanoclaw/SKILL.md` → remove the `## Diagnostics` section
- (`.claude/skills/setup/diagnostics.md` no longer exists upstream as of v2.1.24 — nothing to do there)

---

### 2. Remove GitHub Actions auto-sync workflows

**Intent:** Remove upstream-only workflows (auto version bumping and token badge updates).

**Files:** Delete if present:
- `.github/workflows/bump-version.yml`
- `.github/workflows/update-tokens.yml`

---

### 3. Grammy Telegram dependency

**Intent:** Grammy is the Telegram bot framework used by the custom channel implementation.

**Files:** `package.json` — add `"grammy": "^1.39.3"` to `dependencies`, then run `npm install` or `pnpm install`.

---

### 4. Custom Telegram channel with voice transcription and TTS

**Intent:** Full Telegram bot channel using Grammy with:
- Voice message transcription (faster-whisper via local Python venv)
- TTS voice replies (Piper TTS) when user sends a voice message
- Telegram topic/thread support via `message_thread_id`
- @bot mention translation to TRIGGER_PATTERN format
- 4096-char message splitting

**Files:**
- `src/channels/telegram.ts` — see this file in the repo (committed)
- `src/channels/index.ts` — append `import './telegram.js';`

**Note on the v2 adapter interface:** This implementation uses the v2 `ChannelAdapter` interface from `./adapter.js` with `registerChannelAdapter` from `./channel-registry.js`. Key differences from v1: `setup()` replaces `connect()`, `deliver()` replaces `sendMessage()`, `teardown()` replaces `disconnect()`, `platformId` is bare chat ID (no `tg:` prefix).

---

### 5. Python voice/TTS scripts

**Intent:** Scripts invoked by the Telegram channel for voice transcription and TTS synthesis.

**Files:**
- `scripts/transcribe.py` — uses `faster-whisper`, CUDA-aware with CPU fallback
- `scripts/tts.py` — uses Piper TTS with model at `/mnt/main-data/models/piper/en_US-lessac-medium.onnx`

**Runtime dependencies (host-side, not in repo):**
- Python venv at `/home/ryan/nanoclaw/venv/` with `faster-whisper` and `piper-tts`
- `ffmpeg` system package (for WAV→OGG/Opus conversion)
- Piper model files at `/mnt/main-data/models/piper/`

Both scripts are committed in `scripts/` and should be executable (`chmod +x`).
