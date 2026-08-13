// exporter.js — converts raw Claude API conversation data to MD/TXT and packages ZIP

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

async function classifyAndRouteImage(block, images) {
  if (!block.source) return '![image](unavailable)';

  if (block.source.type === 'base64') {
    const result = await ImageClassifier.classify(
      block.source.data,
      block.source.media_type || 'image/png',
      images.length
    );
    if (result.tier === 1) return `[screenshot: "${result.text}"]`;
    if (result.tier === 2) return `[screenshot: no extractable text]`;
    // tier 3 — save to images folder
    images.push({ filename: result.filename, data: result.data, mediaType: result.mediaType });
    return `![${result.filename}](./images/${result.filename})`;
  }

  if (block.source.url) return `![image](${block.source.url})`;
  return '![image](unavailable)';
}

async function contentBlocksToText(blocks, images, format) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];

  for (const block of blocks) {

    // Skip internal/extended thinking
    if (block.type === 'thinking') continue;

    // Plain text block
    if (block.type === 'text') {
      parts.push(block.text || '');
      continue;
    }

    // Tool use — show action label
    if (block.type === 'tool_use') {
      const desc = block.input && block.input.description
        ? block.input.description
        : (block.name || 'tool');
      parts.push(`[${desc}]`);
      continue;
    }

    // Tool results — skip (Claude's internal response data, not chat content)
    if (block.type === 'tool_result') {
      continue;
    }

    // Image block — routed through three-tier classifier
    if (block.type === 'image') {
      const rendered = await classifyAndRouteImage(block, images);
      parts.push(rendered);
      continue;
    }

    // Artifact block (code/content artifacts Claude generates)
    if (block.type === 'artifact') {
      const fname = block.title || `artifact_${parts.length}`;
      const lang = block.language || '';
      const content = block.content || '';
      parts.push(`[artifact: ${fname}]\n\`\`\`${lang}\n${content}\n\`\`\``);
      continue;
    }

    // Document block — uploaded files (.txt, .md, .pdf text layer, etc.)
    // The API returns these as { type: "document", name: "file.md", text: "..." }
    // or { type: "document", document: { name: "file.md", content: "..." } }
    if (block.type === 'document') {
      const name = block.name || (block.document && block.document.name) || 'file';
      const text = block.text
        || (block.document && (block.document.text || block.document.content))
        || '';
      parts.push(`[${name}: "${text.trim()}"]`);
      continue;
    }

    // Pasted content block — long pastes that Claude wraps in a context block
    // API returns these as { type: "text", context: "...", is_paste: true }
    // or { type: "text" } with a separate sibling structure — handled below
    // Some API versions use type: "context" directly
    if (block.type === 'context') {
      const content = block.body || block.content || block.text || '';
      parts.push(`[pasted: "${content.trim()}"]`);
      continue;
    }

    // Fallback: unknown block — log it so we know to add handling
    console.warn('[exporter] unknown block type:', block.type, block);
  }

  return parts.join('\n\n');
}

async function messageToText(msg, images, format) {
  const role = msg.sender === 'human' ? 'user' : 'assistant';
  let body = '';

  if (Array.isArray(msg.content)) {
    // Check each block: if a text block has is_paste:true or context_uuid, treat as pasted
    const processedBlocks = msg.content.map(block => {
      if (block.type === 'text' && (block.is_paste || block.paste_id)) {
        return { ...block, type: 'context', body: block.text };
      }
      return block;
    });
    body = await contentBlocksToText(processedBlocks, images, format);
  } else if (typeof msg.content === 'string') {
    body = msg.content;
  } else if (msg.text) {
    body = msg.text;
  }

  // Also check top-level message fields for attachments
  // The API sometimes puts file attachments at msg.attachments[]
  const attachmentParts = [];
  if (Array.isArray(msg.attachments)) {
    for (const att of msg.attachments) {
      const name = att.file_name || att.name || 'file';
      const content = att.extracted_content || att.text || att.content || '';
      if (content) {
        attachmentParts.push(`[${name}: "${content.trim()}"]`);
      } else {
        attachmentParts.push(`[${name}: (binary file, content not available)]`);
      }
    }
  }

  const allParts = [body.trim(), ...attachmentParts].filter(Boolean);
  return `${role}:\n${allParts.join('\n\n')}`;
}

async function conversationToText(conv, format) {
  const images = [];
  const chain = buildMessageChain(conv);
  const lines = [];
  for (const m of chain) lines.push(await messageToText(m, images, format));
  const text = lines.join('\n\n');
  console.log(`[exporter] rendered ${chain.length} messages, ${images.length} images`);
  return { text, images };
}

function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return arr;
}

async function exportSingle(conv, format) {
  console.log(`[exporter] exporting single: ${conv.uuid}`);
  const ext = format === 'txt' ? 'txt' : 'md';
  const title = sanitizeFilename(conv.name || conv.uuid);
  const { text, images } = conversationToText(conv, format);

  if (images.length === 0) {
    // Bare file — no ZIP, no subfolder
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    console.log(`[exporter] single export done (no images): ${title}.${ext}`);
    return;
  }

  // Has images — ZIP but no subfolder: just title.md + images/ at root
  const zip = new JSZip();
  zip.file(`${title}.${ext}`, text);
  images.forEach(img => {
    zip.folder('images').file(img.filename, base64ToUint8Array(img.data));
  });
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  console.log(`[exporter] single export done (with images): ${title}.zip`);
}

async function exportBulk(results, format) {
  // If only one result, route through exportSingle for clean output
  if (results.length === 1 && results[0].success && results[0].data) {
    const format_ = format;
    return exportSingle(results[0].data, format_);
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
    const conv = result.data;
    const title = sanitizeFilename(conv.name || conv.uuid);
    const folder = zip.folder(title);
    const { text, images } = conversationToText(conv, format);
    folder.file(`${title}.${ext}`, text);
    if (images.length > 0) {
      const imgFolder = folder.folder('images');
      images.forEach(img => imgFolder.file(img.filename, base64ToUint8Array(img.data)));
    }
    ok++;
  }

  console.log(`[exporter] bulk: ${ok} ok, ${fail} failed`);
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `claude_export_${Date.now()}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  console.log('[exporter] bulk export zip downloaded');
}
