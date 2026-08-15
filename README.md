# Claudette

A Chromium extension for Claude.ai power users. Clean, no ads, no telemetry — just tools that should exist but don't.

> **Note:** Claudette is not on the Chrome Web Store. Install is manual from this repo.

---

## What it does

### Chat Exporter (current module)

Export any Claude.ai conversation — or your entire account history — as Markdown or plain text. Claudette reads directly from Claude's internal API using your existing session, so exports happen instantly without waiting for the official "request your data" pipeline.

**Single chat export**
A download button is injected into the top bar of any open conversation. One click exports the current chat.

**Bulk export**
On the `/chats` page, check any number of conversations and an Export button appears in the selection bar. Exports exactly the checked conversations — not your whole history unless you want that.

**What gets exported:**
- Full conversation content — user and assistant messages
- Tool calls and their output (bash runs, file reads, web searches, etc.)
- Uploaded files with extracted text content
- Pasted text blocks
- Artifacts (code, documents) as fenced code blocks with filename labels
- Images — classified and routed automatically (see below)
- Extended thinking blocks (optional)

**Image handling**

Images are fingerprinted using file size, dimensions, aspect ratio, and type before any OCR runs. Based on the fingerprint:

- **Photos** (camera-like dimensions/ratios, large JPEG) — saved to an `images/` folder in the ZIP, referenced in the Markdown
- **Screenshots with text** — Tesseract OCR extracts the text and embeds it inline: `[screenshot: "extracted text"]`
- **Screenshots with no readable text** — either saved to ZIP or noted as `[screenshot: no extractable text]` depending on your settings

All of this is configurable. If you just want the text and don't care about images, turn images off and exports are always a bare `.md` file with no ZIP.

**Output format:**
- Single conversation, no images → bare `.md` or `.txt` file
- Single conversation, with images → `.zip` containing the file + `images/` folder
- Multiple conversations → single `.zip`, one subfolder per conversation

---

## Install

```bash
git clone https://github.com/Emball/claudette.git
cd claudette
```

1. Open Chrome or Edge and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `claudette` folder

The extension icon appears in your toolbar. Click it to access settings.

---

## Update

```bash
cd claudette
git pull
```

Then go to `chrome://extensions` and click the **↻** reload icon on the Claudette card.

---

## Settings

Click the Claudette icon in your toolbar to open the settings popup.

| Setting | Default | What it does |
|---|---|---|
| Format | MD | Output as Markdown (`.md`) or plain text (`.txt`) |
| Include thinking | Off | Export Claude's extended thinking blocks (shown in italics before the response) |
| Include tool calls | On | Export tool invocations and their output (bash runs, searches, file reads, etc.) |
| Include images | On | Process and export images |
| ↳ Use OCR | On | Run text recognition on screenshot-fingerprinted images |
| ↳ Package in ZIP | On | Save photo/image files to a ZIP; if off, photos get a text placeholder and unreadable screenshots are noted inline |

The two image sub-settings are only active when Include images is on.

---

## Export format reference

```
user:
Hey, can you write a Python script that reads a CSV?

assistant:
Sure. Here's a script that reads a CSV and prints each row:

[artifact: read_csv.py]
\```python
import csv

with open('data.csv') as f:
    reader = csv.reader(f)
    for row in reader:
        print(row)
\```

user:
[report.pdf: "Q3 revenue was $4.2M, up 18% YoY..."]

assistant:
[bash:
{"command": "python read_csv.py"}]
[output:
['name', 'age', 'city']
['Alice', '30', 'NYC']]
```

Bracket convention: anything that's not dialogue gets brackets. Tool calls show the full JSON input when tool calls are enabled. Thinking blocks appear as `*[thinking: ...]*` in italics before the assistant turn they belong to.

---

## Planned

- **Session chaining** — Chain conversations across quota resets or multiple accounts. Claudette injects the previous session's transcript into the next chat automatically, with a first-person preamble so Claude understands the context. Conversations are tagged in their titles (`[cct: chain-name | N]`) so chains survive local storage loss.
- **Prompt library** — Store and inject reusable prompts.
- **Conversation search** — Full-text search across your entire account history.

---

## Technical notes

**Auth:** Uses your existing Claude.ai session cookie (`credentials: 'include'`). No API keys, no OAuth, no accounts.

**OCR:** Tesseract.js v5 running in a hidden extension-origin iframe (necessary to work around claude.ai's Content Security Policy). The trained data file is downloaded once from the Tesseract CDN and cached in IndexedDB — no repeated downloads. Image inversion is applied before OCR to handle dark-themed UIs.

**API:** Reads from Claude's internal undocumented API — the same endpoints the Claude.ai frontend uses. This can break if Anthropic changes their API structure.

**Concurrency:** Bulk exports fetch up to 3 conversations in parallel. OCR runs up to 3 images in parallel. A memory ceiling pauses fetching if estimated heap usage gets too high.
