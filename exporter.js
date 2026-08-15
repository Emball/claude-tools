// exporter.js — converts raw Claude API conversation data to MD/TXT and packages ZIP

const EXPORTER_DEFAULTS = {
  format:   'md',
  thinking: false,
  tools:    true,
  images:   true,
  ocr:      true,
  zip:      true,
};

function loadSettings() {
  return new Promise(resolve =>
    chrome.storage.sync.get(EXPORTER_DEFAULTS, resolve)
  );
}

// --- Message chain builder ---

function buildMessageChain(conv) {
  const msgMap = {};
  const messages = conv.chat_messages || [];
  messages.forEach(m => { msgMap[m.uuid] = m; });

  const leafUuid = conv.current_leaf_message_uuid;
  if (!leafUuid || !msgMap[leafUuid]) {
    console.log('[exporter] no leaf uuid, falling back to flat order');
    return messages;
  }

  const chain = [];
  let cur = msgMap[leafUuid];
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent_message_uuid ? msgMap[cur.parent_message_uuid] : null;
  }
  console.log(`[exporter] built chain: ${chain.length} messages from leaf`);
  return chain;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9_\-. ]/gi, '_').trim().slice(0, 80);
}

// --- Image routing ---

async function classifyAndRouteFile(file, images, settings) {
  const previewUrl = file.preview_url
    ? (file.preview_url.startsWith('http')
        ? file.preview_url
        : `https://claude.ai${file.preview_url}`)
    : null;

  if (!previewUrl)
    return `[image: ${file.file_name || 'unknown'} (no preview available)]`;

  const width  = file.preview_asset?.image_width;
  const height = file.preview_asset?.image_height;

  const result = await ImageClassifier.classify(
    previewUrl, width, height, images.length, settings
  );

  if (result.tier === 'skip')        return '';
  if (result.tier === 'placeholder') return `[image: ${file.file_name || 'photo'} (not packaged)]`;
  if (result.tier === 1)             return `[screenshot: "${result.text}"]`;
  if (result.tier === 2)             return '[screenshot: no extractable text]';

  // tier 3 — save to images folder
  if (result.blob) {
    const ext   = result.blob.type.split('/')[1] || 'webp';
    const fname = file.file_name || `image_${images.length + 1}.${ext}`;
    images.push({ filename: fname, blob: result.blob });
    return `![${fname}](./images/${fname})`;
  }
  return `[image: ${file.file_name || 'unknown'} (fetch failed)]`;
}

// --- Content block renderer ---

async function contentBlocksToText(blocks, images, settings) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];

  for (const block of blocks) {

    // Thinking — include as italics if toggle on, else skip
    if (block.type === 'thinking') {
      if (settings.thinking) {
        const thought = (block.thinking || block.text || '').trim();
        if (thought) parts.push(`*[thinking: ${thought}]*`);
      }
      continue;
    }

    // Plain text (may be a paste — detected by is_paste flag)
    if (block.type === 'text') {
      if (block.is_paste || block.paste_id) {
        parts.push(`[pasted: "${(block.text || '').trim()}"]`);
      } else {
        parts.push(block.text || '');
      }
      continue;
    }

    // Tool use
    if (block.type === 'tool_use') {
      if (!settings.tools) continue;
      const name = block.name || 'tool';
      if (block.input && Object.keys(block.input).length > 0) {
        const inputStr = JSON.stringify(block.input, null, 2);
        parts.push(`[${name}:\n${inputStr}]`);
      } else {
        parts.push(`[${name}]`);
      }
      continue;
    }

    // Tool result — output of a tool call (bash output, search results, etc.)
    if (block.type === 'tool_result') {
      if (!settings.tools) continue;
      const content = Array.isArray(block.content)
        ? block.content.map(c => c.text || '').join('\n')
        : (block.content || '');
      if (content.trim()) parts.push(`[output:\n${content.trim()}]`);
      continue;
    }

    // Inline image blocks (rare — most images are in msg.files[])
    if (block.type === 'image') {
      if (!settings.images) continue;
      console.log('[exporter] inline image block — handled via files[] normally');
      continue;
    }

    // Artifact block
    if (block.type === 'artifact') {
      const fname   = block.title || `artifact_${parts.length}`;
      const lang    = block.language || '';
      const content = block.content || '';
      parts.push(`[artifact: ${fname}]\n\`\`\`${lang}\n${content}\n\`\`\``);
      continue;
    }

    // Document / uploaded file
    if (block.type === 'document') {
      const name = block.name || block.document?.name || 'file';
      const text = block.text
        || block.document?.text
        || block.document?.content
        || '';
      parts.push(`[${name}: "${text.trim()}"]`);
      continue;
    }

    // Pasted context block
    if (block.type === 'context') {
      const content = block.body || block.content || block.text || '';
      parts.push(`[pasted: "${content.trim()}"]`);
      continue;
    }

    console.warn('[exporter] unknown block type:', block.type, block);
  }

  return parts.join('\n\n');
}

// --- Message renderer ---

async function messageToText(msg, images, settings) {
  const role = msg.sender === 'human' ? 'user' : 'assistant';
  let body = '';

  // Debug: empty user messages (image-only uploads etc.)
  if (msg.sender === 'human') {
    const hasText =
      (Array.isArray(msg.content) && msg.content.some(b => b.type === 'text' && b.text))
      || (typeof msg.content === 'string' && msg.content.trim())
      || msg.text;
    if (!hasText) console.log('[exporter][debug] empty user msg:', JSON.stringify(msg));
  }

  if (Array.isArray(msg.content)) {
    body = await contentBlocksToText(msg.content, images, settings);
  } else if (typeof msg.content === 'string') {
    body = msg.content;
  } else if (msg.text) {
    body = msg.text;
  }

  // Attachments at msg.attachments[]
  const attachmentParts = [];
  if (Array.isArray(msg.attachments)) {
    for (const att of msg.attachments) {
      const name    = att.file_name || att.name || 'file';
      const content = att.extracted_content || att.text || att.content || '';
      attachmentParts.push(
        content
          ? `[${name}: "${content.trim()}"]`
          : `[${name}: (binary file)]`
      );
    }
  }

  // Images at msg.files[]
  const fileParts = [];
  if (settings.images && Array.isArray(msg.files)) {
    for (const file of msg.files) {
      if (!file.success) continue;
      if (file.file_kind === 'image') {
        const rendered = await classifyAndRouteFile(file, images, settings);
        if (rendered) fileParts.push(rendered);
      } else {
        fileParts.push(`[${file.file_name || 'file'}: (binary)]`);
      }
    }
  }

  const allParts = [body.trim(), ...attachmentParts, ...fileParts].filter(Boolean);
  return `${role}:\n${allParts.join('\n\n')}`;
}

// --- Conversation renderer ---

async function conversationToText(conv, settings) {
  const images = [];
  const chain  = buildMessageChain(conv);
  const lines  = [];
  for (const m of chain) lines.push(await messageToText(m, images, settings));
  const text = lines.join('\n\n');
  console.log(`[exporter] rendered ${chain.length} messages, ${images.length} images`);
  return { text, images };
}

// --- Export entry points ---

async function exportSingle(conv, settingsOverride) {
  const settings = settingsOverride || await loadSettings();
  const format   = settings.format || 'md';
  const ext      = format === 'txt' ? 'txt' : 'md';
  const title    = sanitizeFilename(conv.name || conv.uuid);
  console.log(`[exporter] exporting single: ${conv.uuid}`);

  const { text, images } = await conversationToText(conv, settings);

  const hasImages = images.length > 0;

  if (!hasImages || !settings.zip) {
    // Bare .md/.txt file
    const blob = new Blob([text], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${title}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    console.log(`[exporter] single done (no zip): ${title}.${ext}`);
    return;
  }

  // ZIP with images
  const zip = new JSZip();
  zip.file(`${title}.${ext}`, text);
  images.forEach(img => zip.folder('images').file(img.filename, img.blob));
  const blob = await zip.generateAsync({ type: 'blob' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${title}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  console.log(`[exporter] single done (with images): ${title}.zip`);
}

async function exportBulk(results, settingsOverride) {
  const settings = settingsOverride || await loadSettings();
  const format   = settings.format || 'md';

  if (results.length === 1 && results[0].success && results[0].data) {
    return exportSingle(results[0].data, settings);
  }

  console.log(`[exporter] bulk export: ${results.length} results`);
  const ext = format === 'txt' ? 'txt' : 'md';
  const zip = new JSZip();
  let ok = 0, fail = 0;

  for (const result of results) {
    if (!result.success || !result.data) {
      console.warn('[exporter] skipping failed result:', result.error || result.uuid);
      fail++;
      continue;
    }
    const conv    = result.data;
    const title   = sanitizeFilename(conv.name || conv.uuid);
    const folder  = zip.folder(title);
    const { text, images } = await conversationToText(conv, settings);
    folder.file(`${title}.${ext}`, text);
    if (images.length > 0 && settings.zip) {
      const imgFolder = folder.folder('images');
      images.forEach(img => imgFolder.file(img.filename, img.blob));
    }
    ok++;
  }

  console.log(`[exporter] bulk: ${ok} ok, ${fail} failed`);
  const blob = await zip.generateAsync({ type: 'blob' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `claude_export_${Date.now()}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  console.log('[exporter] bulk zip downloaded');
}
