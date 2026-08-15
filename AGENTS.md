# AGENTS.md

## Project
**Claudette** — Chromium extension (Chrome/Edge, Manifest V3). A power-user toolkit for Claude.ai, currently shipping its first module: a full-featured chat exporter. No ads, no telemetry, no external services beyond Claude.ai itself. Loaded as an unpacked extension directly from the repo.

The repo is public. The extension is not on the Chrome Web Store — install is manual.

**Current version: 6.0.2.0**

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
content.js                           Injected into claude.ai — button injection, progress bar, SPA nav
exporter.js                          Converts raw API data → MD/TXT, packages ZIPs via JSZip
image_classifier.js                  Image fingerprinting + OCR routing, semaphore-based worker pool
popup.html / popup.js                Settings popup — format/content toggles + progress mirror
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

## Claude.ai Internal API — Complete Discovery Log

All requests use `credentials: 'include'` (session cookie auth only, no token injection).
Base URL: `https://claude.ai/api`
Headers: `Accept: application/json`. GETs only unless noted.

### Confirmed & Implemented

| Action | Method | Endpoint |
|---|---|---|
| List organizations | GET | `/organizations` |
| List all conversations | GET | `/organizations/{orgId}/chat_conversations` |
| Fetch single conversation (full tree) | GET | `/organizations/{orgId}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true` |
| List projects | GET | `/organizations/{orgId}/projects` |

**Query params on single conversation fetch:**
- `tree=True` — returns branched message tree structure rather than flat array
- `rendering_mode=messages` — returns messages in a renderable format with full content blocks
- `render_all_tools=true` — includes tool_use and tool_result blocks in content arrays

**Org ID detection:** Hit `/organizations`, find the org with `capabilities` array including `"chat"`, use its `uuid`. Falls back to first org if none match. Some accounts have multiple orgs (personal + team workspace) — the capability check is the reliable discriminator.

**Alternative org detection:** `document.cookie` contains `lastActiveOrg={uuid}` — simpler but less reliable than the API approach. Useful as a fallback.

**Pagination:** The `/chat_conversations` list endpoint returns all conversations as a flat array with no pagination observed. May change as accounts scale.

---

### Conversation Object (from list endpoint)

```json
{
  "uuid": "b0fe8467-2be7-4d00-8226-3218d671d780",
  "name": "Conversation title",
  "created_at": "2026-06-30T07:14:22.000Z",
  "updated_at": "2026-07-01T12:00:00.000Z",
  "account": { "uuid": "org-uuid-here" },
  "is_starred": false,
  "current_leaf_message_uuid": "019f18ee-9777-7b9b-92f2-5f3b8a912ee9",
  "project_uuid": null
}
```

Key fields:
- `current_leaf_message_uuid` — the active branch tip. Walk `parent_message_uuid` backwards from this to reconstruct the conversation. Flat array order in the full fetch is unreliable for branched conversations.
- `project_uuid` — null for non-project conversations, UUID string if part of a project

---

### Message Object (from full conversation fetch)

```json
{
  "uuid": "019f18ee-9777-7b9b-92f2-5f3b8a912ee9",
  "sender": "human",
  "text": "",
  "content": [ /* content blocks — see below */ ],
  "parent_message_uuid": "019f18ed-46f2-77e1-b56d-13a108a9ae50",
  "attachments": [ /* file attachments — see below */ ],
  "files": [ /* sometimes used instead of or alongside attachments */ ],
  "created_at": "2026-07-01T12:00:00.000Z"
}
```

- `sender` values: `"human"` or `"assistant"`
- `content` is an array of typed blocks (see Content Blocks below)
- `text` is sometimes populated as a flat string fallback; `content` array is the reliable source
- Both `attachments[]` and `files[]` can carry image or file data — always merge and process both
- `parent_message_uuid` — null on root message; walk this chain from leaf to reconstruct branch

---

### Content Block Types

All discovered content block types, their fields, and how we render them:

**`text`**
```json
{ "type": "text", "text": "message content", "is_paste": false, "paste_id": null }
```
- `is_paste: true` or `paste_id` present → large pasted content, render as `*<Pasted>*` + fenced block
- Otherwise → plain text, render inline

**`thinking`**
```json
{ "type": "thinking", "thinking": "internal reasoning content" }
```
- Extended reasoning blocks; skipped by default (toggle: include thinking)
- Render as `> *italic blockquote*` when enabled

**`tool_use`**
```json
{
  "type": "tool_use",
  "name": "web_search",
  "title": "Search the web",
  "input": { "query": "search terms" },
  "id": "tool-call-uuid"
}
```
- `title` is the human-readable label Claude generates — use this, not `name`, as the display header
- `input` is a JSON object of parameters — can be empty `{}`
- Render as `> **title**` blockquote + fenced JSON block for input

**`tool_result`**
```json
{
  "type": "tool_result",
  "tool_use_id": "tool-call-uuid",
  "content": [
    { "type": "text", "text": "result content" }
  ]
}
```
- `content` is an array of sub-blocks (usually `text`, sometimes `image`)
- Render as fenced code block with raw content

**`artifact`**
```json
{
  "type": "artifact",
  "title": "filename.py",
  "language": "python",
  "content": "print('hello')",
  "id": "artifact-uuid"
}
```
- Claude-generated files (code, HTML, etc.)
- `language` may be absent — infer from `title` extension
- Render as fenced block with language tag + filename comment on first line

**`document`**
```json
{
  "type": "document",
  "name": "filename.md",
  "text": "extracted text content",
  "document": { "name": "...", "text": "..." }
}
```
- Uploaded documents processed by Claude
- `text` or `document.text` contains extracted content
- Render as `*<File: name>*` + fenced block

**`context`**
```json
{ "type": "context", "body": "large pasted content", "content": "...", "text": "..." }
```
- Alternative to `is_paste` on text blocks — some API versions wrap large pastes here
- Render as `*<Pasted>*` + fenced block

**`image`**
```json
{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
```
- Inline image blocks within content array
- In practice, images come through `attachments[]` more reliably — this block type is handled but deferred to the attachments path

---

### Attachment / File Object

Found in `msg.attachments[]` and `msg.files[]` — always merge both arrays when processing.

```json
{
  "file_name": "Screenshot 2026-06-30 071649.png",
  "file_kind": "image",
  "file_type": "image/webp",
  "file_size": 43520,
  "success": true,
  "preview_asset": {
    "url": "/api/organizations/{orgId}/files/{fileId}/preview",
    "image_width": 1316,
    "image_height": 921
  },
  "preview_url": "/api/organizations/{orgId}/files/{fileId}/preview",
  "thumbnail_asset": {
    "url": "/api/organizations/{orgId}/files/{fileId}/thumbnail"
  },
  "extracted_content": "text extracted from document if applicable",
  "text": "alternative field for extracted text",
  "content": "another alternative"
}
```

Key fields:
- `file_kind`: `"image"` or `"document"` (text files, PDFs, etc.)
- `file_type`: MIME type as delivered by the API — note that uploaded images are often served as `image/webp` regardless of original format
- `file_name`: original filename. May be null/absent for anonymous pastes or scraped content
- `success`: if explicitly `false`, skip the file entirely. Absent means success.
- `preview_asset.url`: relative URL to full-size preview — prepend `https://claude.ai` if not absolute
- `preview_asset.image_width` / `image_height`: dimensions, used for photo vs screenshot fingerprinting
- `thumbnail_asset.url`: smaller version, not used currently
- `extracted_content` / `text` / `content`: for document attachments, one of these holds the extracted text — check all three

**File preview fetch:** `GET {preview_asset.url}` with `credentials: 'include'` returns the image blob. This is what we fetch for OCR and photo classification.

---

### Organization Object

```json
{
  "uuid": "org-uuid",
  "name": "Personal",
  "capabilities": ["chat", "claude_pro", ...],
  "settings": { ... },
  "billing_type": "..."
}
```

- `capabilities` array determines account type — `"chat"` is always present on usable orgs
- Other capability values observed: `"claude_pro"`, `"artifacts"`, `"projects"` — useful for feature detection

---

### Project Object

```json
{
  "uuid": "project-uuid",
  "name": "Project name",
  "created_at": "...",
  "account": { "uuid": "org-uuid" }
}
```

Conversations can belong to projects via `conversation.project_uuid`. Projects are fetchable but not yet used in Claudette's export flow.

---

### API Endpoints — Confirmed but Not Yet Implemented

These endpoints exist and have been validated during development but are not yet wired into any Claudette feature:

| Action | Method | Endpoint | Notes |
|---|---|---|---|
| Fetch project conversations | GET | `/organizations/{orgId}/projects/{projectId}/conversations` | Lists convos within a specific project |
| File preview (full size) | GET | `/organizations/{orgId}/files/{fileId}/preview` | Returns image blob, used for OCR |
| File thumbnail | GET | `/organizations/{orgId}/files/{fileId}/thumbnail` | Smaller version of above |
| Account/profile info | GET | `/account` | Returns user profile, email, account UUID |
| Usage / stats | GET | `/organizations/{orgId}/usage` | Usage metrics — TBD exact structure |

---

### API Endpoints — To Be Determined (Useful for Future Features)

These endpoints are expected to exist based on the API's patterns and Claude.ai's observed behavior, but have not been confirmed or documented yet:

| Feature | Expected Endpoint | Notes |
|---|---|---|
| Rename conversation | PUT/PATCH | `/organizations/{orgId}/chat_conversations/{uuid}` | Needed for chain title tagging (`[cct: name \| N]`) |
| Delete conversation | DELETE | `/organizations/{orgId}/chat_conversations/{uuid}` | Useful for cleanup of compression proxy conversations |
| Create new conversation | POST | `/organizations/{orgId}/chat_conversations` | Needed for chain spawn without DOM manipulation |
| Send message to conversation | POST | `/organizations/{orgId}/chat_conversations/{uuid}/completion` | Streaming endpoint — needed for background compression |
| Star/unstar conversation | PUT/PATCH | `/organizations/{orgId}/chat_conversations/{uuid}` | Toggle `is_starred` field |
| Update project membership | PUT/PATCH | `/organizations/{orgId}/chat_conversations/{uuid}` | Set/clear `project_uuid` |
| Create project | POST | `/organizations/{orgId}/projects` | |
| Rename project | PUT/PATCH | `/organizations/{orgId}/projects/{projectId}` | |
| List shared conversations | GET | `/organizations/{orgId}/chat_conversations/shared` | For conversations with share links |
| Custom instructions / system prompt | GET/PUT | `/organizations/{orgId}/settings` or `/account/settings` | Where Claude.ai stores user-set system prompts |
| Search conversations | GET | `/organizations/{orgId}/chat_conversations/search?q=...` | May not exist — Claude.ai has no native search, may be client-side only |
| Export data (official) | POST | `/account/export` | Triggers the official data export email — slow backend process |

---

## Export Format

**Message labels:** `**User:**` and `**Assistant:**` bold inline, content follows on the same line. No line break between label and content.

**Action/tool headers:** `> **Title of action**` — bold blockquote. Used for tool calls, bash commands, file writes, web searches. Title is whatever Claude generated for that action.

**Thinking blocks:** `> *Thinking content here*` — italic blockquote. Visually quieter than action headers.

**Media/file attribution:** `*<Type: filename.ext>*` immediately before the associated content block.

| Content | Format |
|---|---|
| Screenshot (OCR text found) | `*<Screenshot: name.png>*` + fenced block with extracted text |
| Screenshot (no text / OCR off) | `*<Screenshot: name.png>*` + fenced block: `no extractable text` |
| Screenshot (no text, zip=on) | `*<Screenshot: name.png>*` + `![name](./images/name.png)` |
| Uploaded file (with extension) | `*<File: name.ext>*` + fenced block with filename comment + content |
| Uploaded file (no extension/name) | Rendered inline as plain fenced block, no label, not zipped |
| Empty file (0 bytes) | Skipped entirely |
| Pasted text | `*<Pasted>*` + fenced block |
| Photo (zip=on) | `*<Photo: name.jpg>*` + `![name.jpg](./images/name.jpg)` |
| Photo (zip=off) | `*<Photo: name.jpg>*` only |
| Tool/action header | `> **Action title**` |
| Thinking | `> *content*` |
| Artifact | fenced block, language tag, filename as first-line comment |

**ZIP structure:**
- Single export, no images → bare `.md`/`.txt`
- Single export, images present → ZIP with `.md` and `images/` at root (no subfolder nesting)
- Bulk export (2+ convos) → single ZIP, one subfolder per conversation, `images/` inside each

---

## Settings (`chrome.storage.sync`)

| Key | Default | Description |
|---|---|---|
| `format` | `'md'` | `'md'` or `'txt'` |
| `thinking` | `false` | Include extended thinking blocks |
| `tools` | `true` | Include tool calls and output |
| `images` | `true` | Process images at all |
| `ocr` | `false` | Run Tesseract OCR on screenshots — **off by default** (slow) |
| `zip` | `true` | Package image files into ZIP (sub-toggle, requires `images: true`) |
| `zipFiles` | `true` | ZIP non-image file attachments into `files/` folder |

Settings loaded fresh at the start of each export. Sub-toggles (`ocr`, `zip`) are disabled in the UI when their parent (`images`) is off.

---

## Progress System

Global progress state flows through `window.cceProgress(phase, current, total, label)` installed by `content.js` and called by `exporter.js`.

**Phases:** `start`, `message`, `image`, `conv` (bulk), `zipping`, `done`

**Inline progress bar:** Appears below the clicked export button on trigger. Hides 5s after cursor leaves; reappears on hover. Attached to the button's parent element via absolute positioning.

**Download icon fill animation:** Two-layer SVG — white fill layer clipped by a rising `<rect>` (clipPath), grey outline layer always on top. Fill rect `y` animates from `24` (empty) to `0` (full) via CSS transition as progress updates.

**Popup mirror:** `content.js` writes `cce_progress: { pct, label }` to `chrome.storage.local` on every progress tick. `popup.js` polls `chrome.storage.local` every 300ms while open and updates its own progress bar from that data.

---

## Image Classification

Multi-signal fingerprint scoring — photo vs screenshot — before any OCR runs. Score ≥ 2 = photo.

| Signal | Score |
|---|---|
| ≥ 12 megapixels | +3 |
| ≥ 9 megapixels | +2 |
| < 4 megapixels | −1 |
| Matches camera aspect ratio (4:3, 3:2, 16:9, 1:1, 5:4, 5:3, 7:5, 16:10 ±1px) | +2 |
| No camera ratio match | −1 |
| JPEG/JPG | +1 |
| PNG | −2 |
| File size ≥ 500KB | +1 |
| File size < 100KB | −1 |

**Decision matrix:**
```
images=off → skip entirely, no placeholder

photo (score ≥ 2):
  zip=on  → *<Photo: filename>* + ![filename](./images/filename)
  zip=off → *<Photo: filename>* only

screenshot (score < 2):
  ocr=on, text found (confidence ≥ 35, chars ≥ 20):
    → *<Screenshot: filename>* + fenced block with extracted text
  ocr=on, no text / error / timeout:
    zip=on  → *<Screenshot: filename>* + save to images/ + embed
    zip=off → *<Screenshot: filename>* + fenced: "no extractable text"
  ocr=off:
    zip=on  → *<Screenshot: filename>* + save to images/ + embed
    zip=off → *<Screenshot: filename>* + fenced: "no extractable text"
```

**OCR implementation:**
- Tesseract.js v5, SIMD LSTM engine, English
- Runs inside a hidden `<iframe>` at `ocr_engine.html` (extension-origin) — bypasses claude.ai CSP
- `eng.traineddata` fetched from `tessdata.projectnaptha.com` on first run, cached in IndexedDB by `worker-overwrites.js`
- Image inverted before OCR (dark UIs → white-on-dark text, inversion improves accuracy)
- Semaphore: 3 concurrent OCR jobs max
- Timeout: 120s per image

---

## UI Injection Points

**Active chat top bar** — icon-only download button before the Share button. Visible on `/chat/*`. Exports current conversation.

**Chats page selection bar** (`/chats`) — Export button next to Cancel, visible when conversations are checked. UUIDs extracted by walking from checked `<input[type="checkbox"]>` up to nearest `<a href="/chat/{uuid}">`. Single selection routes through `exportSingle` (no subfolder ZIP).

`MutationObserver` on `document.body` and the React root handles SPA re-injection. Debounced 400ms.

---

## Performance & Concurrency

- Conversation fetch: 3 parallel slots, 200ms stagger between starts
- Memory ceiling: 200MB estimated heap — pauses fetch queue if exceeded
- OCR semaphore: 3 concurrent jobs max

---

## Planned Modules

### Module 2 — Session Chaining + Conversation Library

**Core concept: a local library keyed per account.**

Claudette passively absorbs every conversation the user opens — full transcript, images (pre-OCR'd), artifacts, and files — stored in `chrome.storage.local` indexed by `orgUUID + conversationUUID`. Passive absorption is toggleable (default: on).

**Staleness detection:** Monitors last two message IDs per stored conversation. If they change, flags as stale and re-absorbs.

**Data model:**
```
chains: {
  [chainId]: {
    name: string,
    customInstructions: string | null,
    sessions: [{ orgUuid, convUuid, sessionIndex, title, joinedAt }]
  }
}

library: {
  [orgUuid]: {
    [convUuid]: {
      transcript: string,
      name: string,
      updatedAt: timestamp,
      lastTwoMessageIds: [string, string],
      ocrCache: { [imageId]: string },
      chainId: string | null,
      sessionIndex: number | null,
      stale: boolean,
    }
  }
}

settings: {
  passiveLibrary: true,
  globalCustomInstructions: string,
}
```

**Chain spawn flow:**
1. Pull all prior session transcripts from library in order
2. Compose injection payload with Claudette preamble
3. Open new Claude.ai chat
4. Paste payload → immediately scrub from visible DOM (user sees seamless fresh chat)
5. Rename conversation: `[cct: chain-name | N]`
6. Register new UUID in chain

**Claudette preamble format:**
```
[Claudette v6.0.0.0 — Session Chain Handoff]
Hey Claude, I'm Claudette — a browser extension built as your companion app...

[Custom instructions: ...]
[/Claudette]

[session: 1 | "Title" | 2026-07-01]
**User:** ...
**Assistant:** ...
[/session]
```

Per-chain instructions take priority over global; both can coexist.

### Module 3 — Conversation Search

Full-text search across the local library. Instant, no API calls per query. Results link to conversation on claude.ai. Dependent on Module 2 library.

### Module 4 — Prompt Library

Store, organize, and inject reusable prompts directly into the Claude.ai input box.