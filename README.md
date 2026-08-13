# Claude Tools

A multipurpose power-user toolkit extension for Claude.ai.

## Current Modules
- **Chat Exporter** — export individual or bulk chats as Markdown or plain text, with smart image handling

## Planned Modules
- **Session Chaining** — chain conversations across accounts for seamless quota switching
- **Prompt Library** — store and inject reusable prompts
- **Conversation Search** — full-text search across all chats

## Installation
1. Clone this repo
2. Go to `chrome://extensions`, enable Developer Mode
3. Click "Load unpacked", select the repo folder
4. Visit claude.ai

## Updating
```
cd claude-tools
git pull
```
Then click the refresh icon on the extension card in `chrome://extensions`.

## Notes
- Private, closed source, no ads, no telemetry
- Uses Claude.ai's internal API via session cookie — no API key required
- May break on Claude UI updates
