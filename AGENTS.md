# AGENTS.md

## Project
**Claudette** — Chromium extension (Chrome/Edge, Manifest V3). A power-user toolkit for Claude.ai, currently shipping its first module: a full-featured chat exporter. No ads, no telemetry, no external services beyond Claude.ai itself. Loaded as an unpacked extension directly from the repo.

The repo is public. The extension is not on the Chrome Web Store — install is manual.

**Current version: 4.1.0.0**

---

## Design Principles

**Bracket convention:** Anything in an export that is not pure dialogue gets brackets. Brackets = metadata or action. No brackets = something a human or Claude actually said.

**Claudette voice:** Any time Claudette communicates with Claude programmatically — session chaining injections, background compression prompts, or any other automated Claude interaction — it speaks in first person and introduces itself naturally. The goal is that Claude and Claudette feel like companion apps, not like a script hitting an API. The user never sees these messages; they're a back-channel between the two products.

**No silent failures:** All modules log their processes. No errors silently swallowed.

---

## File Structure

```
manifest.json                        MV3 manifest — permissions, content scripts, service worker, WAR
background.js                        Service worker — all Claude API calls, concurrency queue, OCR bridge
content.js                           Injected into claude.ai — button injection, SPA navigation handling
exporter.js                          Converts raw API data → MD/TXT, packages ZIPs via JSZip
image_classifier.js                  Image fingerprinting + OCR routing, semaphore-based worker pool
popup.html / popup.js                Settings popup — format + content toggles
ocr_engine.html                      Hidden iframe page (extension origin) — Tesseract runs here
ocr_engine.js                        Tesseract init + recognition, image inversion, postMessage bridge
worker-overwrites.js                 Patches Tesseract worker fetch to cache traineddata via IndexedDB
jszip.min.js                         Bundled JSZip — no CDN dependency
tesseract.min.js                     Bundled Tesseract.js v5
worker.min.js                        Tesseract worker bundle
tesseract-core-simd-lstm.wasm.js     Tesseract WASM core (SIMD LSTM)
tesseract-core-simd-lstm.wasm        WASM binary
tesseract-core-simd-lstm.js          JS wrapper for WASM core
icons/                               icon16, icon48, icon128 — dark rounded square, white download arrow
```

---

## Claude.ai Internal API

All requests use `credentials: 'include'` — session cookie auth only, no token injection.
Headers: `Accept: application/json`. No pagination observed on conversation list.

| Action | Method | Endpoint |
|---|---|---|
| List orgs | GET | `/api/organizations` |
| List all convos | GET | `/api/organizations/{orgId}/chat_conversations` |
| Fetch single convo | GET | `/api/organizations/{orgId}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true` |
| List projects | GET | `/api/organizations/{orgId}/projects` |

**Org ID detection:** Hit `/api/organizations`, find the org with `capabilities` including `"chat"`, use its `uuid`. Falls back to first org if none match.

**Message tree:** Conversations are a tree. `current_leaf_message_uuid` points to the active branch tip. Walk `parent_message_uuid` from leaf to root to reconstruct the active branch. Flat index order exists in the response but is unreliable for branched conversations.

---

## Export Format

Messages prefixed `user:` or `assistant:` on their own line, separated by blank lines. Everything else uses the bracket convention:

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

- Single export, no images → bare `.md`/`.txt`
- Single export, images present → ZIP: `title.md` + `images/` at root, no subfolder nesting
- Bulk export (2+ convos) → single ZIP, one subfolder per conversation, `images/` inside each

---

## Settings (`chrome.storage.sync`)

| Key | Default | Description |
|---|---|---|
| `format` | `'md'` | `'md'` or `'txt'` |
| `thinking` | `false` | Include extended thinking blocks |
| `tools` | `true` | Include tool calls and output |
| `images` | `true` | Process images at all |
| `ocr` | `true` | Run Tesseract on screenshot-fingerprinted images (sub-toggle, requires `images: true`) |
| `zip` | `true` | Package image files into ZIP (sub-toggle, requires `images: true`) |

Settings loaded fresh at the start of each export.

---

## Image Classification

Multi-signal fingerprint scoring determines photo vs screenshot before any OCR runs. Score ≥ 2 = photo, score < 2 = screenshot.

**Scoring signals:**

| Signal | Score |
|---|---|
| ≥ 12 megapixels | +3 |
| ≥ 9 megapixels | +2 |
| < 4 megapixels | −1 |
| Matches camera aspect ratio (4:3, 3:2, 16:9, 1:1, 5:4, 5:3, 7:5, 16:10 at ±1px) | +2 |
| Does not match any camera ratio | −1 |
| JPEG/JPG | +1 |
| PNG | −2 |
| File size ≥ 500KB | +1 |
| File size < 100KB | −1 |

**Decision matrix:**

```
images=off → skip entirely

photo (score ≥ 2):
  zip=on  → save to images/, MD path ref
  zip=off → [User posted a photo: filename]

screenshot (score < 2):
  ocr=on, text found (confidence ≥ 35, chars ≥ 20) → [screenshot: "text"]
  ocr=on, no text / error / timeout:
    zip=on  → save to images/
    zip=off → [screenshot: no extractable text]
  ocr=off:
    zip=on  → save to images/
    zip=off → [screenshot: no extractable text]
```

**OCR implementation:**
- Tesseract.js v5, SIMD LSTM engine, English trained data
- Runs inside a hidden `<iframe>` loaded from `ocr_engine.html` (extension-origin page) — bypasses claude.ai's CSP, gives worker stable `chrome-extension://` URLs for `importScripts`
- Background.js injects the iframe via `chrome.scripting.executeScript`, bridges results via `postMessage` → `chrome.runtime.sendMessage`
- Image is inverted before OCR (dark UIs have white-on-dark text — inverting improves Tesseract accuracy significantly)
- `eng.traineddata` fetched from `tessdata.projectnaptha.com` on first run, cached in IndexedDB by `worker-overwrites.js`
- Semaphore caps parallel OCR jobs at 3
- OCR timeout: 120s per image

---

## UI Injection Points

**Active chat top bar** — icon-only download button before the Share button. Visible on `/chat/*` pages. Exports current conversation as a single file.

**Chats page selection bar** (`/chats`) — Export button next to Cancel, visible only when conversations are checked. Reads UUIDs by walking from checked `<input[type="checkbox"]>` elements up to the nearest `<a href="/chat/{uuid}">`. Single selection routes through `exportSingle` (no subfolder, no unnecessary ZIP).

`MutationObserver` on `document.body` handles SPA navigation re-injection.

---

## Performance & Concurrency

- Conversation fetch concurrency: 3 parallel, 200ms stagger between slot starts
- Memory ceiling: 200MB estimated heap — pauses intake if exceeded
- Progress reported to content script per conversation via `chrome.tabs.sendMessage`
- OCR semaphore: 3 concurrent jobs max

---

## Planned Modules

### Module 2 — Session Chaining + Conversation Library

**Core concept: a local library keyed to each account.**

As the user navigates Claude.ai, Claudette passively absorbs every conversation that gets opened — extracting the transcript via the API and storing it locally in `chrome.storage.local`, indexed by `orgUUID + conversationUUID`. The stored entry includes the full transcript text, conversation name, timestamps, and chain membership if applicable. This happens silently in the background.

This library is the foundation for both chaining and search. Neither would work reliably using live API calls alone.

**Chains:**

A chain is a named, ordered collection of conversation UUIDs — potentially spanning multiple accounts/orgs. Chain metadata is stored in `chrome.storage.local` and associated with the org UUIDs of its member conversations, never with auth tokens.

Data model:
```
chains: {
  [chainId]: {
    name: string,
    sessions: [
      {
        orgUuid: string,         // which account this session belongs to
        convUuid: string,        // conversation UUID
        sessionIndex: number,    // position in chain (1-based)
        title: string,           // conversation name at time of joining
        joinedAt: timestamp,
      },
      ...
    ]
  }
}

library: {
  [orgUuid]: {
    [convUuid]: {
      transcript: string,        // full exported text of the conversation
      name: string,
      updatedAt: timestamp,
      chainId: string | null,
      sessionIndex: number | null,
    }
  }
}
```

**UUID integrity:** Every stored entry is double-keyed by `orgUuid` + `convUuid`. No cross-account lookups. Chain membership records carry their own `orgUuid` so sessions from different accounts in the same chain can be correctly retrieved. The library must never associate a convUuid with the wrong org.

**Spawning a new chained session:**

When the user clicks "New session in chain", Claudette:
1. Gathers all prior sessions in the chain in order, pulling transcripts from the local library
2. Composes a single injected payload with:
   - A first-person Claudette introduction at the top (see voice below)
   - Per-session boundary blocks between each session's transcript
   - The full transcript content of each session in order
3. Opens a new Claude.ai chat
4. Pastes the payload into the input box silently (pasted text, not file upload — paste is never truncated)
5. Renames the new conversation with the chain tag: `[cct: chain-name | N]`
6. Registers the new conversation UUID in the chain

**Claudette intro preamble (example):**
```
[Claudette v4.1.0.0 — Session Chain Handoff]
Hey Claude, I'm Claudette — a browser extension built as your companion app, designed
for Claude by Claude. I help [username] manage, export, and chain their conversations
with you so nothing gets lost across sessions or quota resets.

Attached below is a transcript of [N] chained sessions from [username]'s ongoing work
on "[chain name]". Each session is separated by a boundary block. Pick up naturally
from where the last session left off — the user doesn't see this message.
[/Claudette]

[session: 1 | "First conversation title" | 2025-08-10]
user:
...
assistant:
...
[/session]

[session: 2 | "Second conversation title" | 2025-08-12]
...
[/session]
```

**Title tags:** Conversations that are chain members get renamed to `[cct: chain-name | N]` where N is the session index. This acts as an external anchor — the chain structure can be partially reconstructed from titles alone even if local storage is lost, by scanning conversation names via the API.

**Background compression (future):** For very long chains, optionally compress earlier sessions into a summary via a hidden API conversation that is created and immediately deleted. User never sees it.

### Module 3 — Conversation Search

Full-text search across everything in the local library. Because transcripts are stored locally after being absorbed, search is instant and doesn't require API calls per query. Search indexes conversation text, titles, and metadata. Results link directly to the conversation on claude.ai.

Only possible because of the library built in Module 2 — this is why passive absorption matters.

### Module 4 — Prompt Library

Store, organize, and inject reusable prompts into the input box.
