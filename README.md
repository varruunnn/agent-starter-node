# Semantic VAD Interceptor for LiveKit Voice Agent

This project extends the standard LiveKit Voice Agent with a custom semantic interruption layer. It uses a secondary transcription analysis step to intelligently filter out filler words (e.g., "um", "uh", "hmm") during agent playback, preventing accidental interruptions while preserving responsiveness for genuine user commands.

## What Changed

### New Modules
* **VADInterceptor Class:** A custom event emitter that processes partial transcripts in real-time. It maintains the state of the agent (speaking/silent) and decides whether a user's input should trigger an interruption or be ignored.
* **Dynamic Configuration Server:** An Express.js server running on port `3030` that allows for runtime updates to the ignore-list without restarting the agent.

### Logic & Parameters
* **Filler Detection logic (`isAllFillers`):** Analyzes incoming user speech tokens. If the speech consists *entirely* of defined filler words while the agent is speaking, the interruption is suppressed.
* **Urgent Command Override:** A specific list of words (e.g., "stop", "wait") bypasses all filter logic to ensure immediate control.
* **Multilingual Support:** Added a heuristic `detectLanguage` function to switch between English and Hindi filler lists based on character script.
* **State Management:** Added listeners for `TTSStarted` and `TTSStopped` to synchronize the interceptor with the agent's audio output.

## What Works

* **Selective Interruption:** The agent successfully ignores users saying "um" or "uh" while it is mid-sentence, continuing its audio output uninterrupted.
* **Valid Interruption:** The agent correctly stops speaking when the user interjects with meaningful words (e.g., "actually", "I have a question").
* **Urgent Stopping:** Commands like "Stop" or "Wait" trigger an immediate halt to TTS, regardless of context.
* **Dynamic Updates:** The `/fillers/:lang` API endpoint successfully updates the active exclusion list in real-time.
<img width="1440" height="593" alt="image" src="https://github.com/user-attachments/assets/c38f3785-6506-4624-b570-0bcdcec8cba5" />
* **Language Routing:** The system correctly detects Devanagari script and applies the Hindi exclusion list (e.g., ignoring "achha" or "haan").

## Known Issues

* **Latency Trade-off:** Unlike acoustic VAD (which is near-instant), this solution relies on partial transcriptions from the STT provider. There is a slight delay (milliseconds) between the user speaking and the semantic decision being made.
* **Language Detection Heuristic:** The current language detection relies on script regex (`/[अ-ह]/`). It may not correctly identify Romanized Hindi (Hinglish) without context.
* **Turn Detector Sensitivity:** If the native LiveKit `turnDetection` threshold is set too low, it may trigger a turn before the semantic interceptor has a chance to emit an "ignore" event.

## Optional Persistence (Not Implemented currently)
Right now, filler updates are stored in memory and reset on restart.
If the project grows, filler lists can be persisted in:
-JSON File
-Redis
-SQLite / PostgreSQL

## Steps to Test

### 1. Start the Agent
Run the agent worker locally:
```bash
pnpm install
# OR
pnpm run dev
