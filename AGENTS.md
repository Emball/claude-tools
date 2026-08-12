# AGENTS.md

## Project
Chrome/Edge extension (Manifest V3) to export Claude.ai chats as Markdown or plain text, with images saved as separate files in a ZIP. No ads, no telemetry, private repo.

## Architecture
- `manifest.json` — extension manifest, declares permissions and entry points
- `background.js` — service worker; intercepts network responses from Claude's internal API to capture raw message data
- `content.js` — injected into claude.ai; injects export buttons into the chat list and active chat view
- `popup.html` / `popup.js` — settings UI (export format toggle: MD vs TXT)
- `exporter.js` — core export logic; converts captured API data to MD/TXT, packages ZIP
- `icons/` — extension icons

## Key Workflows

### Single chat export
1. `background.js` intercepts XHR/fetch responses from Claude's internal API (e.g. `/api/organizations/.../chat_conversations/...`) and caches message data by conversation ID.
2. `content.js` injects a download button into the active chat view.
3. On click, `content.js` requests the cached data from `background.js` via `chrome.runtime.sendMessage`.
4. `exporter.js` converts to MD/TXT and triggers ZIP download.

### Bulk export (all chats for current account)
1. `content.js` injects a "Export All" button into the chat list sidebar.
2. On click, `background.js` hits the conversation list endpoint sequentially with rate limiting (300ms delay between requests).
3. Each conversation is fetched individually, exported, and added to a single ZIP.

## API Notes
- Claude.ai uses internal REST endpoints. Conversation list: `GET /api/organizations/{org_id}/chat_conversations?limit=50&offset=0`
- Individual conversation: `GET /api/organizations/{org_id}/chat_conversations/{uuid}?tree=True&rendering_mode=raw`
- Auth is handled by existing session cookies — no token injection needed.
- `org_id` is extracted from the page URL or from intercepted responses.

## Export Format
- Messages prefixed with `user:` or `assistant:` on their own line
- Tool use logged as `[tool: tool_name]` header before the content block
- Extended thinking blocks omitted entirely
- Artifacts exported as labeled fenced code blocks: `[artifact: filename.ext]` followed by triple-backtick block
- Images saved as separate files; MD uses relative links `./images/filename.png`
- Output: ZIP containing the `.md` or `.txt` file plus an `images/` folder

## Settings
- Default export format: MD or TXT (stored in `chrome.storage.sync`)

## Version
0.0.0.1
