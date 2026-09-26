# Real Amadeus Mobile

An **unofficial** Android port of [RealAmadeus](https://github.com/dsuv-sg/RealAmadeus) by DSUV / ELVELT:
talk with **Amadeus Kurisu**, the AI from *Steins;Gate 0*, animated in Live2D on your phone. She answers
through the language model of your choice (cloud or running on your own PC), remembers you across sessions,
and can even speak Japanese while her lines are shown in your language, like a subtitled anime.

![Login screen, dialogue, menu and settings](docs/screenshots.jpg)

*Version française : [README.fr.md](README.fr.md).*

- [Install](#install)
- [Features](#features)
- [Choosing an AI provider](#choosing-an-ai-provider)
- [Free and private: Ollama on your PC](#free-and-private-ollama-on-your-pc)
- [Away from home: Tailscale](#away-from-home-tailscale)
- [Japanese voice with VOICEVOX](#japanese-voice-with-voicevox)
- [Troubleshooting](#troubleshooting)
- [Building from source](#building-from-source)
- [How it works](#how-it-works)
- [Project history](#project-history)
- [Credits and licenses](#credits-and-licenses)

## Install

1. Download `RealAmadeusMobile-<version>.apk` from the **Releases** page, or from the **Actions** tab
   (latest run → *Artifacts*).
2. Open it on the phone and allow installing from that source when Android asks.
3. Start **Amadeus** and log in with the credentials from the anime: `Salieri` / `MakiseKurisu`
   (pre-filled after the first login).
4. Open the menu (☰ button or long press) → **CONFIG** → **API**, pick a provider and paste its API key.

Requires Android 7.0 or later. API keys, settings and Kurisu's memory stay on the device (Android backup is disabled).

## Features

| RealAmadeus (Unity, Windows) | Real Amadeus Mobile |
| --- | --- |
| Login screen, boot sequence, logo | Same (tap to skip the boot sequence) |
| Live2D Kurisu (Cubism 5) | Same model; texture downscaled to 4096 / 2048 px for mobile GPUs |
| Procedural emotions, blinking, breathing, falling asleep after 60 s, hidden sneeze | Line-by-line port of `AmadeusChatController.LateUpdate()` |
| Gaze follows the mouse | Kurisu follows your finger |
| Visual-novel dialogue (pages, ▼, AUTO mode, Ctrl+C) | Tap to advance, AUTO button, ✕ button to cancel |
| OpenAI (+ compatible APIs), Gemini, Claude, Groq (+ Compound web search), Vertex AI, Ollama, OpenRouter | All of them, streamed; Vertex AI in Express mode (API key, no gcloud on a phone) |
| Long-term memory (facts, episodes, summaries), BM25 RAG | Same, plus a screen to browse and delete memories |
| Circular menu, BACKLOG, CONFIG, STATUS, CHANGE LOG, HELP | Same; Kurisu appears on the lab PC monitor while the menu is open |
| Windows TTS (SAPI), Windows dictation / Whisper | Android speech recognition and text-to-speech, or a Japanese **VOICEVOX** voice |
| Desktop notifications | Android notification when a reply arrives in the background |
| 11 languages | The original 11; strings added by the port exist in English, French and Japanese (English elsewhere); Kurisu's in-character error lines in all 11 |

Additions and changes compared with the original:

- **Streaming replies** for every provider, with automatic retries on transient errors (overloaded servers,
  timeouts, rate limits) before Kurisu reports a problem in character.
- **STATUS → LAST_ERROR** and the backlog show the technical error message behind an in-character error.
- Memory commands explained to the model in every language (the original only described them in French, German
  and Russian).
- **Detailed persona** option using the original long Japanese character sheet (present in the original code but
  unused). A language rule is sent last, after memories and context, and repeated after the history for local
  models, so replies stay in the chosen language.
- **Japanese voice with VOICEVOX**: text in your language, voice in Japanese, lip sync driven by the actual voice.
- Claude through the official Anthropic SDK, with server-side fallback when a request is refused.

## Choosing an AI provider

Set it in **CONFIG → API**. Leave *Model name* empty to use the default.

| Provider | Where to get a key | Default model | Notes |
| --- | --- | --- | --- |
| Google Gemini | [aistudio.google.com](https://aistudio.google.com/) → *Get API key* | `gemini-flash-latest` | Free tier; web search available |
| OpenAI | [platform.openai.com](https://platform.openai.com/) | `gpt-5.5` | "OpenAI compatible" toggle for any compatible server (base URL) |
| Anthropic Claude | [console.anthropic.com](https://console.anthropic.com/) | `claude-opus-5` | API usage is billed separately from Claude.ai subscriptions; `claude-sonnet-5` or `claude-haiku-4-5` cost less |
| Groq | [console.groq.com](https://console.groq.com/) | `openai/gpt-oss-20b` | Web search through `groq/compound` |
| Vertex AI (Express) | Google Cloud, Express mode API key | `gemini-3.8-flash` | Project and location in CONFIG |
| OpenRouter | [openrouter.ai](https://openrouter.ai/) | `openrouter/auto` | Web search plugin |
| Ollama | none | `llama3.2` | Runs on your own PC, see below |

Claude itself cannot run locally: Anthropic does not publish its weights. Open-weight models (Gemma, Mistral,
Llama, Qwen…) can, through Ollama.

## Free and private: Ollama on your PC

[Ollama](https://ollama.com/) runs open-weight models on your computer; the phone talks to it over your network.
No API key, no usage cost. The PC must stay on (disable sleep while plugged in).

1. **Install Ollama** from [ollama.com/download](https://ollama.com/download).
2. **Download a model** in a terminal, for example `ollama run gemma4` (several GB). Other models from
   [ollama.com/library](https://ollama.com/library) work too, e.g. `ollama run mistral` (good at French) or the
   lighter `ollama run llama3.2`. Type `/bye` to leave the terminal chat; Ollama keeps running in the background.
3. **Let other devices connect.** By default Ollama only listens to the PC itself.
   - Windows: quit Ollama (tray icon → *Quit*), open *Edit environment variables for your account*, add
     `OLLAMA_HOST` = `0.0.0.0:11434`, then start Ollama again from the Start menu.
     Check with `echo %OLLAMA_HOST%` in a new `cmd` window.
   - macOS: `launchctl setenv OLLAMA_HOST "0.0.0.0:11434"`, then restart the Ollama app.
4. **Open the firewall** (Windows, `cmd` run as administrator; make sure the network profile is *Private*):
   ```
   netsh advfirewall firewall add rule name="Ollama" dir=in action=allow protocol=TCP localport=11434 profile=private
   ```
5. **Find the PC's address**: `ipconfig` → *IPv4 Address* of the adapter that has a default gateway
   (ignore `vEthernet (WSL)` and other virtual adapters), e.g. `192.168.1.55`.
6. **Test from the phone's browser**: `http://192.168.1.55:11434` must show *Ollama is running*.
   `netstat -an | findstr 11434` on the PC must show `0.0.0.0:11434 … LISTENING`; `127.0.0.1:11434` means
   `OLLAMA_HOST` was not applied.
7. **In the app**, CONFIG → API: provider *Ollama*, API key empty, model name exactly as downloaded (`gemma4`),
   Ollama host `http://192.168.1.55:11434`.

The first reply can take 30–60 s while the model loads; the next ones are faster.

**Detailed persona with a local model**: the Japanese character sheet is about 6,600 characters (roughly 5,000
tokens), more than Ollama's default 4k context on GPUs with less than 24 GB of VRAM. Raise *Context length* to
16k in Ollama's settings (tray icon → *Settings*), then check with `ollama ps` (CONTEXT column, and ideally
`100% GPU` under PROCESSOR). The short persona works with the default context.

## Away from home: Tailscale

On mobile data the phone cannot reach `192.168.x.x`. [Tailscale](https://tailscale.com/download) (free) links
your devices in a private network, reachable from anywhere and closed to everyone else.

1. Install Tailscale on the PC and on the phone, and sign in with the same account on both.
2. Note the PC's Tailscale address (starts with `100.`), shown in the Tailscale app or admin console.
3. Allow Tailscale devices through the firewall (PowerShell as administrator). The rule is bound to the
   Tailscale adapter, so on a public Wi-Fi a device giving itself a `100.x` address cannot use it:
   ```
   New-NetFirewallRule -DisplayName "Ollama Tailscale" -Direction Inbound -Protocol TCP -LocalPort 11434 -InterfaceAlias Tailscale -RemoteAddress 100.64.0.0/10 -Action Allow
   ```
4. Test `http://100.x.y.z:11434` in the phone's browser (don't forget `:11434`), then use it as the Ollama host.
   It works on Wi-Fi and on mobile data, as long as Tailscale is on.

Do **not** forward port 11434 on your router: Ollama has no password, anyone on the internet could use your PC.

## Japanese voice with VOICEVOX

Kurisu can speak Japanese while her lines stay in your language. The voice comes from
[VOICEVOX](https://voicevox.hiroshiba.jp/), a free Japanese text-to-speech engine running on your PC, reached
like Ollama (same network or Tailscale).

1. Install VOICEVOX on the PC (you can try the voices in its app), then **quit the app completely**
   (including the tray icon): it only accepts connections from the PC itself.
2. Run [`scripts/windows/Lancer-VOICEVOX-pour-Amadeus.bat`](scripts/windows/Lancer-VOICEVOX-pour-Amadeus.bat).
   The first time, right-click → *Run as administrator*: it opens port 50021 in the firewall for the Tailscale
   adapter and the private network. Afterwards a double-click is enough. It starts the VOICEVOX engine with `--host 0.0.0.0`;
   keep its window open. It is ready when it prints `Uvicorn running on http://0.0.0.0:50021`.
3. Test from the phone: `http://<PC address>:50021/version` shows a version number such as `"0.25.2"`.
4. In the app, CONFIG → Voice: turn on *Read replies aloud*, set *Voice* to **VOICEVOX**. Leave the address empty
   when VOICEVOX runs on the Ollama PC (the app then uses that PC on port 50021), otherwise enter
   `http://<PC address>:50021`. Pick a voice, press *Listen*, then *Apply*.

How it works: the model writes, before each sentence, the Japanese line Kurisu actually says, as
`[VOICE: 日本語]`. The app hides these lines, synthesises them while the reply is still streaming, and plays
them in order as their pages appear (the text waits up to 2 s for the first line). Kurisu's mouth follows the
loudness of the voice. With Japanese as the display language, each page is spoken as is.

Every VOICEVOX character has its own terms of use, which require the credit "VOICEVOX:character name"; the app
shows it in CONFIG and STATUS.

Kurisu's actual voice actress is deliberately not an option: this project does not clone a real person's
voice without their consent.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "The specified model doesn't seem to exist" | Model name unknown to the provider (or not downloaded in Ollama). Leave it empty for the default, or type the exact name. |
| "Something went wrong on the server side", now and then | The provider is overloaded (common on free tiers). The app already retries twice; try again or switch model. |
| Network error with Ollama or VOICEVOX | Phone not on the same network (or Tailscale off), wrong address, firewall, or `OLLAMA_HOST` not applied. Test the address in the phone's browser first. |
| Replies drift into Japanese with the detailed persona | Context too small for the long character sheet: set Ollama's context length to 16k, or use the short persona. |
| VOICEVOX: "HTTP 404" | The engine answers but the address has an extra path; use `http://<PC>:50021` only. |
| VOICEVOX script: "port 50021 already in use" | The VOICEVOX app is still open; quit it, then run the script again. |
| Some replies have no voice | The model forgot the `[VOICE: …]` lines for that reply (small local models sometimes do). |

**STATUS → LAST_ERROR** always shows the technical message of the last failure.

## Building from source

Requirements: Node.js 22, JDK 17+, `git`, `curl`, `zip`. No Android Studio or Gradle.

```bash
./scripts/build-apk.sh          # → android/build/RealAmadeusMobile-<version>.apk
```

The script fetches:
- the **Live2D Cubism SDK for Web**: Framework `5-r.3` (official repository) and Cubism Core 5.0 (a copy checked
  against its SHA-256). As in the original project, these files are not versioned.
- `android.jar` (API 34) and `aapt2` from the Android SDK when `ANDROID_HOME` is set, otherwise from public
  mirrors with pinned checksums, plus `dx` and `apksig` from Maven Central.

Develop the interface in a browser, and run the tests:

```bash
cd web && npm ci && npm run fetch:live2d && npm run dev
npm test          # reply parser (emotion tags, memory commands, voice lines, paging) and memory search
```

`web/tests/fake-llm-server.mjs` (OpenAI and Anthropic streaming) and `web/tests/fake-voicevox-server.mjs` are
small fake servers for end-to-end tests without API keys or a real VOICEVOX.

GitHub Actions (`.github/workflows/android.yml`) builds the APK on every push to `main` (and on demand from the
Actions tab); pushing a `v*` tag also publishes a release.

### Signing

Android only installs an update over a previous version when both are signed with the same key. The key is
**not** stored in this repository. The build script looks for, in order:

1. the `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` environment variables
   (set them as repository **secrets** for GitHub Actions);
2. a local `android/signing/amadeus-personal.p12` with `android/signing/keystore.properties`
   (`password=…`, `alias=…`), ignored by git;
3. otherwise a throwaway key: the APK works, but cannot be installed over a build signed with another key.

Create a key and its secret value:

```bash
keytool -genkeypair -keystore amadeus.p12 -storetype PKCS12 -alias amadeus \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Real Amadeus Mobile"
base64 -w0 amadeus.p12          # → ANDROID_KEYSTORE_BASE64
```

Keep the `.p12` file and its password somewhere safe: losing them means reinstalling the app (and losing its
settings and memory) to change key.

Builds published from this repository are signed with the certificate whose SHA-256 fingerprint is
`3B:8B:41:FC:55:5A:2F:F6:5A:16:FD:8D:2C:9E:DD:FB:1D:ED:A4:16:EE:D0:30:E3:E5:C0:24:DF:A1:39:47:1B`.

## How it works

```
web/        the app itself (TypeScript + Vite): Live2D rendering, animation, AI, memory, voice, interface
android/    Java shell: WebView plus a native bridge (HTTP without CORS, speech, notifications…)
scripts/    dependency download, asset conversion, prompt extraction, APK build, Windows VOICEVOX launcher
```

- **Rendering**: Live2D Cubism Web Framework 5-r.3 on WebGL, with context-loss recovery, an FPS cap and
  quality levels. The model, textures and images come from the original project, converted by
  `scripts/prepare-assets.py`.
- **Animation**: `web/src/live2d/animator.ts` ports the original procedural animation (emotion targets,
  bursts, Perlin idle drift, blinking, gaze, breathing, sleep, sneeze, startled wake-up). Lip sync uses the
  VOICEVOX audio level when a voice is playing.
- **Dialogue**: `web/src/chat/parse.ts` turns streamed tokens into characters and events (emotion tags,
  hidden memory commands, `<think>` blocks, voice lines) and applies the visual-novel paging rules;
  `web/src/chat/controller.ts` runs the conversation, typewriter, AUTO mode, cancellation and errors.
- **AI**: one streaming client per API family (`web/src/ai/providers/`), retries in `web/src/ai/client.ts`,
  prompts extracted from the original by `scripts/extract-prompts.py`.
- **Memory**: port of the original `MemoryManager` (facts, episodes, summaries) with BM25 retrieval, stored in
  the WebView's local storage.
- **Voice**: Android text-to-speech and speech recognition through the bridge, or `web/src/voice/voicevox.ts`
  (VOICEVOX client, queued Web Audio playback).
- **Android shell**: plain Java, no AndroidX. The WebView loads the app from
  `https://appassets.androidplatform.net`; the `AmadeusAndroid` bridge performs HTTP requests natively
  (streamed, no CORS, binary bodies as base64) and exposes speech, notifications, immersive mode, vibration and
  the back button.
- **Build without Gradle**: `aapt2` (resources), `javac`, `dx`, a small zip aligner and `apksig`
  (APK Signature Scheme v2), all driven by `scripts/build-apk.sh`.

## Project history

1. **Port** of the Unity app to a web app in an Android shell: Live2D Kurisu, procedural animation, all
   screens and panels, the seven AI providers with streaming, long-term memory with RAG, speech input and
   output, notifications, and a Gradle-free APK build.
2. **Reliability**: current default models, automatic retries on transient errors, technical error messages in
   STATUS and the backlog.
3. **Local AI**: setup guide for Ollama on a PC, reachable on the home network and through Tailscale.
4. **Detailed persona in other languages**: the language rule moved to the end of the prompt and repeated for
   local models, so the Japanese character sheet no longer drags replies into Japanese.
5. **Japanese voice**: VOICEVOX support (voice lines written by the model, early synthesis, queued playback,
   real lip sync), Windows launcher script, settings and fake engine for tests.
6. **Public release**: English README, signing key kept out of the repository (GitHub secrets).

## Credits and licenses

- **RealAmadeus** © DSUV / ELVELT, [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/).
  This port reuses the original Live2D model of Kurisu, images, localisation strings, prompts and logic, adapted
  to mobile. It is also distributed under **CC BY-NC 4.0** (see `LICENSE`): non-commercial use only,
  attribution required. It is neither affiliated with nor endorsed by DSUV / ELVELT.
- **Steins;Gate 0** © MAGES. / Nitroplus. Non-commercial fan work, following the
  [Nitroplus fan-work guidelines](https://www.nitroplus.co.jp/company/license/fan-fiction/).
- **Live2D Cubism SDK** © Live2D Inc. — Core: Live2D Proprietary Software License (redistributable files);
  Framework: Live2D Open Software License. APKs include these files as those licenses allow.
- **VOICEVOX** (optional, installed by the user on their PC): each voice is used under its own terms, with the
  credit "VOICEVOX:character name".
- Fonts: Barlow Condensed, Mate SC, Noto Serif and Departure Mono (SIL Open Font License).
