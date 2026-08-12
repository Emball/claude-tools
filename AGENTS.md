# AGENTS.md

## Project
Chrome/Edge (Manifest V3) extension that exports Claude.ai chats as Markdown or plain text. Private repo, no ads, no telemetry. Self-loaded as an unpacked extension.

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

- `orgId` detected by hitting `/api/organizations` and finding the org with `capabilities` including `"chat"` (falls back to first org).
- Conversation list returns a flat array — no pagination observed.
- Messages are a tree; `current_leaf_message_uuid` + `parent_message_uuid` chain is walked to reconstruct the active branch.

## Export Format
- Messages prefixed `user:` / `assistant:` on their own line
- Tool use: `[tool: name]` header + fenced JSON block
- Tool results: `[tool_result]` header + fenced block
- Artifacts: `[artifact: filename.ext]` header + fenced code block
- Thinking blocks: omitted entirely
- Images: saved as separate files in `images/`; MD uses relative links `./images/filename.png`
- No images → bare `.md`/`.txt` file download; images present → ZIP with file + `images/` folder
- Bulk export → single ZIP, one subfolder per conversation (named by title or UUID)

## UI Injection
- **Chats page only** (`/chats`) — a download icon is injected into the selection action bar (the bar that appears when items are checked, alongside "Select all", "Delete", "Cancel")
- Button only appears when the selection bar is visible; clicking it exports only the checked conversations
- `MutationObserver` handles SPA navigation re-injection
- No buttons in sidebar, active chat view, or anywhere else

## Export: Selected Chats
- `getSelectedConvIds()` in `content.js` extracts UUIDs from checked rows via three strategies: checked checkboxes, `aria-selected="true"` rows, selected-class rows
- Sends `selectedExport` to `background.js` with the list of UUIDs
- `background.js` fetches each individually with 500ms delay, reports per-conversation success/failure

## Bulk Export (full account)
- `bulkExport` action in `background.js` still exists; fetches full conversation list then each individually with 500ms delay

## Version
1.0.0.0
