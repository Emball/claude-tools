# AGENTS.md

## Project
**Claudette** — Chrome/Edge (Manifest V3) extension. Currently implements a chat exporter module. Planned as a multi-module power-user toolkit for Claude.ai. Private repo, no ads, no telemetry. Self-loaded as an unpacked extension.

## File Structure
- `manifest.json` — MV3 manifest; declares permissions, content scripts, service worker, and web-accessible resources
- `background.js` — service worker; handles all Claude API calls and bulk export orchestration
- `content.js` — injected into claude.ai; injects export buttons and wires UI interactions
- `exporter.js` — converts raw API conversation data to MD/TXT and packages ZIPs via JSZip
- `popup.html` / `popup.js` — settings page; MD vs TXT toggle stored in `chrome.storage.sync`
- `jszip.min.js` — bundled JSZip library (no CDN dependency)
- `icons/` — icon16, icon48, icon128 PNGs (dark rounded square, white download arrow)

## Claude.ai API
All requests use `credentials: 'include'` (session cookie auth, no token injection).

| Action | Method | Endpoint |
|---|---|---|
| List orgs | GET | `/api/organizations` |
| List all convos | GET | `/api/organizations/{orgId}/chat_conversations` |
| Fetch single convo | GET | `/api/organizations/{orgId}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true` |
| List projects | GET | `/api/organizations/{orgId}/projects` |
| Rename convo | PATCH | `/api/organizations/{orgId}/chat_conversations/{uuid}` (body: `{ name }`) |
| Delete convo | DELETE | `/api/organizations/{orgId}/chat_conversations/{uuid}` |
| Account info | GET | `/api/account` or `/api/me` (unconfirmed — verify before use) |

- `orgId` detected by hitting `/api/organizations` and finding the org with `capabilities` including `"chat"` (falls back to first org).
- Conversation list returns a flat array — no pagination observed.
- Messages are a tree; `current_leaf_message_uuid` + `parent_message_uuid` chain is walked to reconstruct the active branch.

## Export Format
Bracket convention: anything that is not pure dialogue gets brackets. This makes exports scannable and unambiguous.

- Messages prefixed `user:` / `assistant:` on their own line
- Artifacts: `[artifact: filename.ext]` + fenced code block
- Uploaded files: `[filename.ext: "extracted content"]`
- Pasted text: `[pasted: "content"]`
- Images: three-tier system (see below)
- Single export, no images → bare `.md`/`.txt`
- Single export, images present → ZIP with file + `images/` folder, no subfolder nesting
- Bulk export (2+ convos) → single ZIP, one subfolder per conversation

### Toggleable Content (stored in `chrome.storage.sync`, off by default)

**Thinking blocks** (`includethinking: false`)
When off: omitted entirely.
When on: rendered as italics immediately before the assistant turn they belong to:
```
*[thinking: Claude's internal reasoning here...]*

assistant:
The answer is...
```

**Tool calls + output** (`includeTools: false`)
When off: collapsed to label only → `[web_search]`, `[bash]`, `[read_file]` etc.
When on: expanded to show full input and output:
```
[bash: "cat /etc/hosts"]
[output: "127.0.0.1 localhost\n::1 localhost"]
```
Tool results (`tool_result` blocks) are only rendered when this toggle is on — otherwise dropped entirely. This covers terminal runs, file reads/edits, and any other computer use actions visible in the Claude UI.

## Image Export — Three-Tier System (IN PROGRESS)
Images are scored using multiple signals to determine handling:

**Scoring signals:**
- Aspect ratio matches known camera ratio (4:3, 16:9, 3:2, 1:1) within 2% → strong photo signal
- Portrait orientation → moderate photo signal
- File size over 1MB → moderate photo signal
- Tesseract OCR finds substantial text → strong screenshot signal
- Landscape + non-standard dimensions → moderate screenshot signal

**Tiers:**
- **Tier 1 — Screenshot with text**: Tesseract extracts text → `[screenshot: "extracted text"]`
- **Tier 2 — Screenshot, no text**: OCR finds nothing → `[screenshot: no extractable text]`
- **Tier 3 — Photo / large file**: Saved to `images/` folder, referenced in MD → triggers ZIP

**Notes:**
- Claude app recompresses uploads to WebP (~500KB). Raw camera JPGs can be ~4MB. Size alone is not sufficient — use combined scoring.
- Tesseract.js accuracy on dark-themed UIs with small monospace fonts may require confidence thresholding.
- Portrait orientation is a strong photo signal since desktop screenshots are virtually never portrait.

## UI Injection Points
- **Active chat top bar** — icon-only download button injected before the Share button; exports current chat as single file
- **Chats page selection bar** (`/chats`) — "Export" button injected next to Cancel when items are checked; exports only selected conversations. Single selection routes through `exportSingle` (no ZIP/subfolder).
- `MutationObserver` handles SPA navigation re-injection

## Version
Current version: 2.0.0.2

---

## Planned Modules

### Module 2 — Session Chaining
Allows chaining multiple Claude chat sessions into a single continuous conversation context, enabling seamless account-switching when hitting quota limits.

**Core concept:**
- User assigns chats to a named chain via extension UI
- Chain metadata stored in `chrome.storage.sync` keyed by org UUID (account identifier)
- Chat titles are automatically renamed with a structured tag: `[cct: chain-name | N]` where N is position
- Title tag acts as external anchor — chain can be reconstructed from titles alone even if local storage is lost
- Account association stored locally per chain entry (org UUID, email if `/api/me` confirms it)

**Injection flow:**
- On new chat, if active chain exists, extension injects prior session transcript directly into the input box as pasted text (not file upload — pasted text is never truncated regardless of length)
- Injection includes a system header explaining the chaining context to Claude so it can collaborate seamlessly:
  ```
  [Claudette — Session Continuation]
  Chain: <name> | Session <N>. Continue naturally from the transcript below.
  [TRANSCRIPT START]
  ...
  [TRANSCRIPT END]
  ```
- Claude sees the header and understands the context without user explanation

**Background compression (optional, future):**
- Spin up a hidden conversation via API
- Send transcript + compression instructions
- Receive summary, store in extension
- Delete the temporary conversation via DELETE endpoint
- User never sees this happen

**Chain organizer UI:**
- Lives in extension popup or dedicated page
- List of chains, each showing member chats in order with account association
- Connect button assigns current chat to chain and triggers rename
- Chain membership visible in Claude sidebar via title tags

### Module 3 — Prompt Library
TBD — store, organize, and inject reusable prompts into the input box.

### Module 4 — Conversation Search
TBD — full-text search across all conversations in the current account using the list + fetch APIs.
