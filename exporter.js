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

function contentBlocksToText(blocks, images, format) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];

  for (const block of blocks) {
    if (block.type === 'thinking') continue;

    if (block.type === 'text') {
      parts.push(block.text || '');
      continue;
    }

    if (block.type === 'tool_use') {
      const toolName = block.name || 'tool';
      const input = block.input ? JSON.stringify(block.input, null, 2) : '';
      parts.push(`[tool: ${toolName}]\n\`\`\`\n${input}\n\`\`\``);
      continue;
    }

    if (block.type === 'tool_result') {
      const content = Array.isArray(block.content)
        ? block.content.map(c => c.text || '').join('\n')
        : (block.content || '');
      parts.push(`[tool_result]\n\`\`\`\n${content}\n\`\`\``);
      continue;
    }

    if (block.type === 'image') {
      if (block.source && block.source.type === 'base64') {
        const ext = (block.source.media_type || 'image/png').split('/')[1] || 'png';
        const fname = `image_${images.length + 1}.${ext}`;
        images.push({ filename: fname, data: block.source.data, mediaType: block.source.media_type });
        parts.push(`![${fname}](./images/${fname})`);
      }
      continue;
    }

    if (block.type === 'artifact') {
      const fname = block.title || `artifact_${parts.length}`;
      const lang = block.language || '';
      const content = block.content || '';
      parts.push(`[artifact: ${fname}]\n\`\`\`${lang}\n${content}\n\`\`\``);
      continue;
    }
  }

  return parts.join('\n\n');
}

function messageToText(msg, images, format) {
  const role = msg.sender === 'human' ? 'user' : 'assistant';
  let body = '';

  if (Array.isArray(msg.content)) {
    body = contentBlocksToText(msg.content, images, format);
  } else if (typeof msg.content === 'string') {
    body = msg.content;
  } else if (msg.text) {
    body = msg.text;
  }

  return `${role}:\n${body.trim()}`;
}

function conversationToText(conv, format) {
  const images = [];
  const chain = buildMessageChain(conv);
  const lines = chain.map(m => messageToText(m, images, format));
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
