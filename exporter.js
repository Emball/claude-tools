// exporter.js — converts raw Claude API conversation data to MD and packages ZIP

const EXPORTER_DEFAULTS = {
  format:   'md',
  thinking: false,
  tools:    true,
  images:   true,
  ocr:      true,
  zip:      true,
  zipFiles: true,
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

function inferLang(filename, content) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const langMap = {
    js: 'js', ts: 'ts', py: 'python', rb: 'ruby', go: 'go',
    rs: 'rust', java: 'java', cpp: 'cpp', c: 'c', cs: 'csharp',
    html: 'html', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml',
    sh: 'bash', bash: 'bash', md: 'md', sql: 'sql', swift: 'swift',
    kt: 'kotlin', php: 'php', r: 'r', scala: 'scala',
  };
  return langMap[ext] || '';
}

// --- Image routing ---

async function classifyAndRouteFile(file, images, settings) {
  const rawUrl = file.preview_asset?.url || file.preview_url || null;
  const previewUrl = rawUrl
    ? (rawUrl.startsWith('http') ? rawUrl : `https://claude.ai${rawUrl}`)
    : null;

  const fname = file.file_name || 'image';

  if (!previewUrl)
    return `*<Screenshot: ${fname}>*\n\`\`\`\nno preview available\n\`\`\``;

  const width  = file.preview_asset?.image_width;
  const height = file.preview_asset?.image_height;

  const result = await ImageClassifier.classify(
    previewUrl, width, height, images.length, settings
  );

  if (result.tier === 'skip') return '';

  if (result.tier === 'photo-nozip')
    return `*<Photo: ${fname}>*`;

  if (result.tier === 'screenshot-text')
    return `*<Screenshot: ${fname}>*\n\`\`\`\n${result.text}\n\`\`\``;

  if (result.tier === 'screenshot-notext')
    return `*<Screenshot: ${fname}>*\n\`\`\`\nno extractable text\n\`\`\``;

  // 'save' — write blob to images folder
  if (result.tier === 'save' && result.blob) {
    const ext   = result.blob.type.split('/')[1] || 'webp';
    const iname = file.file_name || `image_${images.length + 1}.${ext}`;
    images.push({ filename: iname, blob: result.blob });
    const isPhoto = result.isPhoto;
    return `*<${isPhoto ? 'Photo' : 'Screenshot'}: ${iname}>*\n![${iname}](./images/${iname})`;
  }

  return `*<Screenshot: ${fname}>*\n\`\`\`\nfetch failed\n\`\`\``;
}

// --- Content block renderer ---

async function contentBlocksToText(blocks, images, nonImageFiles, settings) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];

  for (const block of blocks) {

    // Thinking — italic blockquote if toggle on
    if (block.type === 'thinking') {
      if (settings.thinking) {
        const thought = (block.thinking || block.text || '').trim();
        if (thought) parts.push(`> *${thought}*`);
      }
      continue;
    }

    // Plain text (check for paste flag)
    if (block.type === 'text') {
      if (block.is_paste || block.paste_id) {
        const content = (block.text || '').trim();
        parts.push(`*<Pasted>*\n\`\`\`\n${content}\n\`\`\``);
      } else {
        parts.push(block.text || '');
      }
      continue;
    }

    // Tool use — bold blockquote header + JSON input in fenced block
    if (block.type === 'tool_use') {
      if (!settings.tools) continue;
      const name = block.name || 'tool';
      const title = block.title || name;
      if (block.input && Object.keys(block.input).length > 0) {
        const inputStr = JSON.stringify(block.input, null, 2);
        parts.push(`> **${title}**\n\`\`\`json\n${inputStr}\n\`\`\``);
      } else {
        parts.push(`> **${title}**`);
      }
      continue;
    }

    // Tool result — output fenced block
    if (block.type === 'tool_result') {
      if (!settings.tools) continue;
      const content = Array.isArray(block.content)
        ? block.content.map(c => c.text || '').join('\n')
        : (block.content || '');
      if (content.trim()) parts.push(`\`\`\`\n${content.trim()}\n\`\`\``);
      continue;
    }

    // Inline image blocks
    if (block.type === 'image') {
      if (!settings.images) continue;
      console.log('[exporter] inline image block — skipping, handled via files[]');
      continue;
    }

    // Artifact — fenced block with filename as first-line comment
    if (block.type === 'artifact') {
      const fname   = block.title || `artifact_${parts.length}`;
      const lang    = block.language || inferLang(fname, block.content);
      const content = block.content || '';
      const comment = lang === 'python' ? `# ${fname}` : `// ${fname}`;
      parts.push(`\`\`\`${lang}\n${comment}\n${content}\n\`\`\``);
      continue;
    }

    // Document / uploaded file
    if (block.type === 'document') {
      const name = block.name || block.document?.name || 'file';
      const text = block.text || block.document?.text || block.document?.content || '';
      const lang  = inferLang(name, text);
      const comment = lang === 'python' ? `# ${name}` : `// ${name}`;
      const entry = `*<File: ${name}>*\n\`\`\`${lang}\n${comment}\n${text.trim()}\n\`\`\``;
      if (settings.zipFiles) nonImageFiles.push({ filename: name, content: text.trim() });
      parts.push(entry);
      continue;
    }

    // Pasted context block
    if (block.type === 'context') {
      const content = block.body || block.content || block.text || '';
      parts.push(`*<Pasted>*\n\`\`\`\n${content.trim()}\n\`\`\``);
      continue;
    }

    console.warn('[exporter] unknown block type:', block.type, block);
  }

  return parts.join('\n\n');
}

// --- Message renderer ---

async function messageToText(msg, images, nonImageFiles, settings) {
  const role = msg.sender === 'human' ? '**User:**' : '**Assistant:**';
  let body = '';

  if (msg.sender === 'human') {
    const hasText =
      (Array.isArray(msg.content) && msg.content.some(b => b.type === 'text' && b.text))
      || (typeof msg.content === 'string' && msg.content.trim())
      || msg.text;
    if (!hasText && !(msg.files?.length) && !(msg.attachments?.length))
      console.log('[exporter][debug] empty user msg:', JSON.stringify(msg));
  }

  if (Array.isArray(msg.content)) {
    body = await contentBlocksToText(msg.content, images, nonImageFiles, settings);
  } else if (typeof msg.content === 'string') {
    body = msg.content;
  } else if (msg.text) {
    body = msg.text;
  }

  // All file attachments — both msg.attachments[] and msg.files[] can contain images or text
  const fileParts = [];
  const allFiles = [...(msg.attachments || []), ...(msg.files || [])];
  console.log(`[exporter][debug] msg ${msg.uuid} allFiles count:`, allFiles.length, allFiles.map(f => ({kind: f.file_kind, name: f.file_name, success: f.success})));
  for (const file of allFiles) {
    if (file.success === false) continue;
    const name = file.file_name || file.name || 'file';

    if (file.file_kind === 'image') {
      console.log(`[exporter][debug] image file hit, settings.images=${settings.images}, name=${name}`);
      if (!settings.images) continue;
      let rendered;
      try {
        rendered = await classifyAndRouteFile(file, images, settings);
      } catch(e) {
        console.error('[exporter][debug] classifyAndRouteFile threw:', e);
        rendered = '';
      }
      console.log(`[exporter][debug] rendered result:`, rendered?.slice?.(0,80));
      if (rendered) fileParts.push(rendered);
    } else {
      const content = file.extracted_content || file.text || file.content || '';
      const lang    = inferLang(name, content);
      const comment = lang === 'python' ? `# ${name}` : `// ${name}`;
      if (content) {
        fileParts.push(`*<File: ${name}>*\n\`\`\`${lang}\n${comment}\n${content.trim()}\n\`\`\``);
        if (settings.zipFiles) nonImageFiles.push({ filename: name, content: content.trim() });
      } else {
        fileParts.push(`*<File: ${name}>*\n\`\`\`\n(binary file)\n\`\`\``);
      }
    }
  }

  const allParts = [body.trim(), ...fileParts].filter(Boolean);
  return `${role} ${allParts.join('\n\n')}`;
}

// --- Conversation renderer ---

async function conversationToText(conv, settings) {
  const images       = [];
  const nonImageFiles = [];
  const chain        = buildMessageChain(conv);
  const lines        = [];
  for (const m of chain)
    lines.push(await messageToText(m, images, nonImageFiles, settings));
  const text = lines.join('\n\n');
  console.log(`[exporter] rendered ${chain.length} messages, ${images.length} images, ${nonImageFiles.length} files`);
  return { text, images, nonImageFiles };
}

// --- ZIP builder ---

function buildZip(title, text, ext, images, nonImageFiles, settings) {
  const zip = new JSZip();
  zip.file(`${title}.${ext}`, text);
  if (settings.zip && images.length > 0)
    images.forEach(img => zip.folder('images').file(img.filename, img.blob));
  if (settings.zipFiles && nonImageFiles.length > 0)
    nonImageFiles.forEach(f => zip.folder('files').file(f.filename, f.content));
  return zip;
}

async function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Export entry points ---

async function exportSingle(conv, settingsOverride) {
  const settings = settingsOverride || await loadSettings();
  const format   = settings.format || 'md';
  const ext      = format === 'txt' ? 'txt' : 'md';
  const title    = sanitizeFilename(conv.name || conv.uuid);
  console.log(`[exporter] exporting single: ${conv.uuid}`);

  const { text, images, nonImageFiles } = await conversationToText(conv, settings);
  const needsZip = (images.length > 0 && settings.zip) || (nonImageFiles.length > 0 && settings.zipFiles);

  if (!needsZip) {
    await triggerDownload(new Blob([text], { type: 'text/plain' }), `${title}.${ext}`);
    console.log(`[exporter] single done (no zip): ${title}.${ext}`);
    return;
  }

  const zip  = buildZip(title, text, ext, images, nonImageFiles, settings);
  const blob = await zip.generateAsync({ type: 'blob' });
  await triggerDownload(blob, `${title}.zip`);
  console.log(`[exporter] single done (zip): ${title}.zip`);
}

async function exportBulk(results, settingsOverride) {
  const settings = settingsOverride || await loadSettings();
  const format   = settings.format || 'md';

  if (results.length === 1 && results[0].success && results[0].data)
    return exportSingle(results[0].data, settings);

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
    const conv   = result.data;
    const title  = sanitizeFilename(conv.name || conv.uuid);
    const folder = zip.folder(title);
    const { text, images, nonImageFiles } = await conversationToText(conv, settings);
    folder.file(`${title}.${ext}`, text);
    if (settings.zip && images.length > 0)
      images.forEach(img => folder.folder('images').file(img.filename, img.blob));
    if (settings.zipFiles && nonImageFiles.length > 0)
      nonImageFiles.forEach(f => folder.folder('files').file(f.filename, f.content));
    ok++;
  }

  console.log(`[exporter] bulk: ${ok} ok, ${fail} failed`);
  const blob = await zip.generateAsync({ type: 'blob' });
  await triggerDownload(blob, `claude_export_${Date.now()}.zip`);
  console.log('[exporter] bulk zip downloaded');
}
