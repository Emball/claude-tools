# AGENTS.md

## Project
**Claudette** — Chromium extension (Chrome/Edge, Manifest V3). A power-user toolkit for Claude.ai, currently shipping its first module: a full-featured chat exporter. No ads, no telemetry, no external services beyond Claude.ai itself. Loaded as an unpacked extension directly from the repo.

The repo is public. The extension is not on the Chrome Web Store — install is manual.

**Current version: 6.0.0.1**

**Version sync:** The version in this file and the `"version"` field in `manifest.json` must always be kept in sync. AGENTS.md uses MAJOR.MINOR.PATCH.MICRO; manifest.json uses MAJOR.MINOR.PATCH (drop the MICRO). Update both on every commit.

---

## Design Principles

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

**Message labels:** `**User:**` and `**Assistant:**` bold inline, content follows on the same line with no line break between label and text.

**Action/tool headers:** `> **Title of action**` — bold text inside a blockquote. Used for every tool call, bash command, file write, web search, etc. Title is whatever Claude generated for that action in the UI.

**Thinking blocks:** `> *Thinking content here*` — italic text inside a blockquote. Same container as action headers, visually quieter.

**Media/file attribution:** `*<Type: filename.ext>*` on its own line immediately before the associated content block. Type is one of: `Screenshot`, `File`, `Pasted`, `Photo`. Angle brackets render visibly in claude.ai's MD engine — intentional, reads as a tag.

| Content | Format |
|---|---|
| Screenshot (OCR text found) | `*<Screenshot: filename.png>*` then fenced block with extracted text |
| Screenshot (no text / OCR off) | `*<Screenshot: filename.png>*` then fenced block with `no extractable text` |
| Uploaded file | `*<File: filename.ext>*` then fenced block with extracted content |
| Pasted text | `*<Pasted: filename.ext>*` then fenced block (language tag inferred from content) |
| Photo (zip=on) | `*<Photo: filename.jpg>*` then `![filename.jpg](./images/filename.jpg)` |
| Photo (zip=off) | `*<Photo: filename.jpg>*` — no image embed, attribution only |
| Tool/action header | `> **Action title**` |
| Thinking block | `> *thinking content*` |
| Inline code / artifacts | fenced block with language tag; filename in a comment on the first line if applicable |

**ZIP structure:**
- Single export, no images → bare `.md`/`.txt`
- Single export, images present → ZIP with `.md` and `images/` at root, no subfolder nesting
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
  zip=on  → *<Photo: filename>* + ![filename](./images/filename)
  zip=off → *<Photo: filename>* only (no embed)

screenshot (score < 2):
  ocr=on, text found (confidence ≥ 35, chars ≥ 20):
    → *<Screenshot: filename>* + fenced block with extracted text
  ocr=on, no text / error / timeout:
    zip=on  → *<Screenshot: filename>* + save to images/
    zip=off → *<Screenshot: filename>* + fenced block with "no extractable text"
  ocr=off:
    zip=on  → *<Screenshot: filename>* + save to images/
    zip=off → *<Screenshot: filename>* + fenced block with "no extractable text"
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

As the user navigates Claude.ai, Claudette passively absorbs every conversation that gets opened — extracting the full transcript, images, artifacts, and uploaded files via the API and storing them locally in `chrome.storage.local`, indexed by `orgUUID + conversationUUID`. This happens silently in the background. Passive absorption is toggleable (default: on) — users who don't want background data collection can disable it and trigger absorption manually per conversation.

Images are pre-OCR'd during absorption so that when the user exports, classification and text extraction are already cached — export feels instantaneous even for image-heavy conversations.

**Staleness detection:** After absorbing a conversation, Claudette monitors the last two messages. If they change (new message added, edit, regeneration), the library entry is flagged as out of sync and re-absorbed. Nothing in the library is ever silently stale.

This library is the foundation for both chaining and search. Neither works reliably using live API calls alone.

**Chains:**

A chain is a named, ordered collection of conversation UUIDs — potentially spanning multiple accounts/orgs. Chain metadata is stored in `chrome.storage.local` and associated with the org UUIDs of its member conversations, never with auth tokens.

Data model:
```
chains: {
  [chainId]: {
    name: string,
    customInstructions: string | null,   // per-chain custom instructions
    sessions: [
      {
        orgUuid: string,
        convUuid: string,
        sessionIndex: number,            // 1-based
        title: string,
        joinedAt: timestamp,
      },
      ...
    ]
  }
}

library: {
  [orgUuid]: {
    [convUuid]: {
      transcript: string,
      name: string,
      updatedAt: timestamp,
      lastTwoMessageIds: [string, string],  // for staleness detection
      ocrCache: { [imageId]: string },      // pre-computed OCR results
      chainId: string | null,
      sessionIndex: number | null,
      stale: boolean,
    }
  }
}

settings: {
  passiveLibrary: true,              // toggleable, default on
  globalCustomInstructions: string,  // appended to all chain handoffs
}
```

**UUID integrity:** Every stored entry is double-keyed by `orgUuid` + `convUuid`. No cross-account lookups. Chain membership records carry their own `orgUuid` so sessions from different accounts in the same chain can be correctly retrieved.

**Spawning a new chained session:**

When the user clicks "New session in chain", Claudette:
1. Gathers all prior sessions in the chain in order, pulling transcripts from the local library
2. Composes the injection payload (see preamble format below)
3. Opens a new Claude.ai chat
4. Pastes the payload into the input box and removes it from the visible DOM immediately — user sees a seamless fresh chat with no indication a paste occurred
5. Renames the new conversation: `[cct: chain-name | N]`
6. Registers the new conversation UUID in the chain

**Claudette intro preamble format:**
```
[Claudette v5.1.0.0 — Session Chain Handoff]
Hey Claude, I'm Claudette — a browser extension built as your companion app, designed
for Claude by Claude. I help [username] manage, export, and chain their conversations
with you so nothing gets lost across sessions or quota resets.

Attached below is a transcript of [N] chained sessions from [username]'s ongoing work
on "[chain name]". Each session is separated by a boundary block. Pick up naturally
from where the last session left off — the user doesn't see this message.

[Custom instructions: {per-chain instructions, or global if no per-chain set}]
[/Claudette]

[session: 1 | "First conversation title" | 2025-08-10]
**User:** ...
**Assistant:** ...
[/session]

[session: 2 | "Second conversation title" | 2025-08-12]
...
[/session]
```

Custom instructions are injected after the Claudette preamble, before session content. Per-chain instructions take priority over global; both can coexist if desired.

**Title tags:** Conversations that are chain members get renamed to `[cct: chain-name | N]`. Acts as an external anchor — chain structure can be partially reconstructed from titles alone if local storage is lost.

**Background compression (future):** For very long chains, compress earlier sessions into a summary via a hidden API conversation that is immediately deleted. User never sees it.

### Module 3 — Conversation Search

Full-text search across everything in the local library. Because transcripts are stored locally after being absorbed, search is instant and doesn't require API calls per query. Search indexes conversation text, titles, and metadata. Results link directly to the conversation on claude.ai.

Only possible because of the library built in Module 2 — this is why passive absorption matters.

### Module 4 — Prompt Library

Store, organize, and inject reusable prompts into the input box.
