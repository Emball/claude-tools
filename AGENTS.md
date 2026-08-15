# AGENTS.md

## Project
**Claudette** — Chromium extension (Chrome/Edge, Manifest V3). A power-user toolkit for Claude.ai, currently shipping its first module: a full-featured chat exporter. No ads, no telemetry, no external services beyond Claude.ai itself. Loaded as an unpacked extension directly from the repo.

The repo is public. The extension is not on the Chrome Web Store — install is manual (see README).

---

## Design Principles

**Bracket convention:** Anything in an export that is not pure dialogue gets brackets. This makes exports unambiguous at a glance — brackets = metadata or action, no brackets = something a human or Claude actually said.

**Claudette voice:** Any time Claudette communicates with Claude programmatically (session chaining injections, background compression prompts, or any other automated Claude interaction) it speaks in first person and introduces itself naturally. The goal is that Claude and Claudette feel like companion apps, not like a script hitting an API. The user never sees these messages — they're a back-channel between the two products. Example: *"Hey Claude, it's Claudette — I'm handing you a transcript from the previous session so you can pick up naturally."*

**No duplication:** One central working copy of the code in the repo. Never copy files from uploads — the upload will be out of date from the working copy.

**No silent failures:** All modules log their processes. No errors silently swallowed.

---

## Versioning & Git

Format: `MAJOR.MINOR.PATCH.MICRO`

| Lines changed | Bump |
|---|---|
| 300+ | MAJOR |
| 100+ | MINOR |
| 20+ | PATCH |
| 1+ | MICRO |

Commit message: version number only (e.g. `4.1.0.0`).
All files changed as part of a single logical update are committed together in one commit. Never split related changes across multiple commits.
AGENTS.md and README.md must be kept in sync with the actual codebase — update them whenever relevant behavior changes.
If a push fails for any reason, stop immediately and notify the user.

**Current version: 4.1.0.0**

---

## File Structure

```
manifest.json              MV3 manifest — permissions, content scripts, service worker, WAR
background.js              Service worker — all Claude API calls, concurrency queue, OCR bridge
content.js                 Injected into claude.ai — export button injection, SPA navigation handling
exporter.js                Converts raw API data → MD/TXT, packages ZIPs via JSZip
image_classifier.js        Image fingerprinting + OCR routing, semaphore-based worker pool
popup.html / popup.js      Settings popup — format + content toggles
ocr_engine.html            Hidden iframe page (extension origin) — Tesseract runs here
ocr_engine.js              Tesseract init + recognition, image inversion for dark UIs, postMessage bridge
worker-overwrites.js       Patches Tesseract worker's fetch to cache traineddata via IndexedDB
jszip.min.js               Bundled JSZip — no CDN dependency
tesseract.min.js           Bundled Tesseract.js v5
worker.min.js              Tesseract worker bundle
tesseract-core-simd-lstm.wasm.js   Tesseract WASM core (SIMD LSTM)
tesseract-core-simd-lstm.wasm      WASM binary
tesseract-core-simd-lstm.js        JS wrapper for WASM core
icons/                     icon16, icon48, icon128 — dark rounded square, white download arrow
```

---

## Claude.ai Internal API

All requests use `credentials: 'include'` — session cookie auth only, no token injection needed.
Headers: `Accept: application/json`. No pagination observed on conversation list.

| Action | Method | Endpoint |
|---|---|---|
| List orgs | GET | `/api/organizations` |
| List all convos | GET | `/api/organizations/{orgId}/chat_conversations` |
| Fetch single convo | GET | `/api/organizations/{orgId}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true` |
| List projects | GET | `/api/organizations/{orgId}/projects` |

**Org ID detection:** Hit `/api/organizations`, find the org with `capabilities` including `"chat"`, use its `uuid`. Falls back to first org if none match.

**Message tree:** Conversations are a tree, not a flat list. `current_leaf_message_uuid` points to the active branch tip. Walk `parent_message_uuid` from the leaf to root to reconstruct the active branch. Flat index order exists in the response but is unreliable for branched conversations.

---

## Export Format

Messages are prefixed `user:` or `assistant:` on their own line, separated by blank lines. Everything else uses the bracket convention:

| Content | Format |
|---|---|
| Artifact | `[artifact: filename.ext]` + fenced code block |
| Uploaded file (text) | `[filename.ext: "extracted content"]` |
| Pasted text | `[pasted: "content"]` |
| Tool call (expanded) | `[tool_name:\n{json input}]` |
| Tool output (expanded) | `[output:\ncontent]` |
| Thinking block (expanded) | `*[thinking: content]*` (italics, before assistant turn) |
| Screenshot with OCR text | `[screenshot: "extracted text"]` |
| Screenshot, no text | `[screenshot: no extractable text]` |
| Photo (ZIP on) | `![filename](./images/filename)` |
| Photo (ZIP off) | `[User posted a photo: filename]` |

**Single export, no images → bare `.md`/`.txt` file (no ZIP).**
**Single export, images present → ZIP: `title.md` + `images/` folder at root, no subfolder nesting.**
**Bulk export (2+ convos) → single ZIP, one subfolder per conversation, `images/` inside each.**

---

## Settings (`chrome.storage.sync`)

All settings have defaults and are toggled from the popup.

| Key | Default | Description |
|---|---|---|
| `format` | `'md'` | Output format — `'md'` or `'txt'` |
| `thinking` | `false` | Include extended thinking blocks |
| `tools` | `true` | Include tool calls and their output |
| `images` | `true` | Process images at all |
| `ocr` | `true` | Run Tesseract OCR on screenshot-fingerprinted images (sub-toggle, only relevant when `images: true`) |
| `zip` | `true` | Package image files into ZIP (sub-toggle, only relevant when `images: true`) |

Settings are loaded fresh at the start of each export — no stale values in memory.

---

## Image Classification

Images are scored using a multi-signal fingerprint system before any OCR runs. The score determines whether an image is treated as a **photo** (score ≥ 2) or a **screenshot** (score < 2).

**Scoring signals:**

| Signal | Score |
|---|---|
| ≥ 12 megapixels | +3 |
| ≥ 9 megapixels | +2 |
| < 4 megapixels | −1 |
| Matches a standard camera aspect ratio (4:3, 3:2, 16:9, 1:1, 5:4, 5:3, 7:5, 16:10 at ±1px) | +2 |
| Does not match any camera ratio | −1 |
| JPEG/JPG | +1 |
| PNG | −2 |
| File size ≥ 500KB | +1 |
| File size < 100KB | −1 |

**Decision matrix:**

```
photo (score ≥ 2):
  zip=on  → save blob to images/ folder, MD ref with path
  zip=off → [User posted a photo: filename]

screenshot (score < 2):
  ocr=on:
    text found (confidence ≥ 35, chars ≥ 20) → [screenshot: "text"]
    no text / OCR error / timeout:
      zip=on  → save blob to images/ folder
      zip=off → [screenshot: no extractable text]
  ocr=off:
    zip=on  → save blob to images/ folder
    zip=off → [screenshot: no extractable text]

images=off → skip entirely (no fetch, no processing)
```

**OCR implementation:**
- Tesseract.js v5, SIMD LSTM engine, English trained data
- Runs inside a hidden `<iframe>` loaded from `ocr_engine.html` (extension-origin page)
- Extension-origin iframe bypasses claude.ai's CSP and gives the Tesseract worker stable `chrome-extension://` URLs for `importScripts`
- Background.js injects the iframe via `chrome.scripting.executeScript` and bridges results back via `postMessage` → `chrome.runtime.sendMessage`
- Image is inverted before OCR (dark-themed UIs have white text on dark backgrounds — inverting improves Tesseract accuracy significantly)
- `eng.traineddata` fetched from `tessdata.projectnaptha.com` CDN on first run, then cached in IndexedDB by `worker-overwrites.js` — no repeated downloads
- Semaphore caps parallel OCR jobs at 3 (matches conversation fetch concurrency)
- OCR timeout: 120 seconds per image

**Why not offscreen document:** Chrome's offscreen API doesn't work with WASM under claude.ai's CSP. The iframe approach (extension-origin page) is what actually works — discovered by reverse-engineering an existing extension that solved it.

---

## UI Injection Points

**Active chat top bar** — icon-only download button injected before the Share button. Always visible on `/chat/*` pages. Exports the current open conversation as a single file.

**Chats page selection bar** (`/chats`) — "Export" button injected next to the Cancel button, visible only when at least one conversation is checked. Reads selected UUIDs from checked `<input[type="checkbox"]>` elements by walking up to the nearest `<a href="/chat/{uuid}">` anchor. Exports exactly the checked conversations. Single selection routes through `exportSingle` (no subfolder, no unnecessary ZIP).

`MutationObserver` on `document.body` handles SPA navigation — re-injects buttons when the route changes without a full page load.

---

## Performance & Concurrency

**Conversation fetching:**
- Default concurrency: 3 parallel fetches
- 200ms stagger between slot starts (spreads API load, reduces rate-limit risk)
- Memory ceiling: 200MB estimated heap — pauses intake if exceeded, resumes when clear
- Progress reported back to content script per conversation via `chrome.tabs.sendMessage`

**OCR:**
- Semaphore-limited to 3 concurrent OCR jobs
- Each job spawns one iframe, does recognition, then the iframe is removed
- `classifyAll()` method available for batch classification (runs all in parallel up to semaphore limit)

---

## Planned Modules

### Module 2 — Session Chaining
Chain multiple Claude sessions into a single continuous conversation context. Designed for hitting quota limits across multiple accounts.

**Core concept:**
- User assigns chats to a named chain
- Chain metadata in `chrome.storage.sync` keyed by org UUID
- Chat titles renamed with `[cct: chain-name | N]` — acts as external anchor, chain survives local storage loss
- On new chat, extension injects prior session transcript into input box as pasted text (not file upload — paste is never truncated)
- Injection preamble written in first-person Claudette voice (see Design Principles above)

**Background compression (future):** Spin up a hidden conversation via API, compress transcript, store summary, delete the temp conversation. User never sees it.

**Chain organizer UI:** Popup or dedicated page — list chains, show member chats in order with account association, Connect button to assign current chat.

### Module 3 — Prompt Library
Store, organize, and inject reusable prompts into the input box.

### Module 4 — Conversation Search
Full-text search across all conversations in the current account using the list + fetch APIs.
