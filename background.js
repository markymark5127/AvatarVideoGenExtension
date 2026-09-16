// Gemini Video Prompt Queue v0.6 download helper.
// The content script arms a single pending scene download immediately before it
// clicks Gemini's Download control. The very next browser download in that short
// window is claimed, renamed, and placed under the configured Downloads subfolder.

const PENDING_KEY = 'gvpqPendingDownload';
const MAX_PENDING_AGE_MS = 30_000;

function normalizeBasePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/(?:^|\/)\.\.(?:\/|$)/g, '/');
}

function extensionFor(item) {
  const filename = String(item?.filename || '').toLowerCase();
  const url = String(item?.finalUrl || item?.url || '').toLowerCase();
  const mime = String(item?.mime || '').toLowerCase();

  const byName = filename.match(/\.(mp4|webm|mov|m4v)(?:$|[?#])/i);
  if (byName) return byName[1].toLowerCase();
  const byUrl = url.match(/\.(mp4|webm|mov|m4v)(?:$|[?#])/i);
  if (byUrl) return byUrl[1].toLowerCase();
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('x-m4v')) return 'm4v';

  // Gemini Avatar downloads are sometimes served from opaque Google URLs with
  // no useful extension/MIME during filename determination. They are normally MP4.
  return 'mp4';
}

async function readPending() {
  const data = await chrome.storage.local.get(PENDING_KEY);
  return data?.[PENDING_KEY] || null;
}

async function writePending(pending) {
  await chrome.storage.local.set({ [PENDING_KEY]: pending });
}

function isFresh(pending) {
  if (!pending) return false;
  const age = Date.now() - Number(pending.preparedAt || 0);
  return age >= 0 && age <= MAX_PENDING_AGE_MS;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GVQ_PREPARE_DOWNLOAD') {
    const basePath = normalizeBasePath(message.basePath);
    if (!basePath) {
      sendResponse({ ok: false, error: 'Missing download path.' });
      return;
    }

    const pending = {
      token: String(message.token || ''),
      basePath,
      sceneTitle: String(message.sceneTitle || ''),
      preparedAt: Number(message.preparedAt) || Date.now(),
      tabId: sender.tab?.id ?? null,
      status: 'prepared',
      downloadId: null,
      assignedFilename: '',
      originalFilename: ''
    };

    writePending(pending)
      .then(() => sendResponse({ ok: true, token: pending.token }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === 'GVQ_DOWNLOAD_STATUS') {
    readPending().then(pending => {
      const sameToken = pending && String(pending.token || '') === String(message.token || '');
      sendResponse({ ok: true, pending: sameToken ? pending : null });
    }).catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === 'GVQ_CLEAR_DOWNLOAD') {
    readPending().then(async pending => {
      if (!pending || !message.token || pending.token === message.token) {
        await chrome.storage.local.remove(PENDING_KEY);
      }
      sendResponse({ ok: true });
    }).catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

// This is intentionally NOT filtered by hostname/MIME anymore. The extension
// arms this listener only milliseconds before clicking Gemini's Download button,
// so the next download in that narrow window is the scene we want. The previous
// hostname/MIME heuristic rejected Gemini's opaque Avatar URLs and prevented all
// renaming on some accounts.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  readPending().then(async pending => {
    if (!isFresh(pending) || !pending?.basePath) {
      if (pending && !isFresh(pending)) await chrome.storage.local.remove(PENDING_KEY);
      suggest();
      return;
    }

    // If a download is already claimed, do not rename a second unrelated one.
    if (pending.downloadId != null && pending.downloadId !== item.id) {
      suggest();
      return;
    }

    const ext = extensionFor(item);
    const assignedFilename = `${pending.basePath}.${ext}`;
    pending.downloadId = item.id;
    pending.originalFilename = String(item.filename || '');
    pending.assignedFilename = assignedFilename;
    pending.status = 'renamed';
    pending.matchedAt = Date.now();

    try {
      await writePending(pending);
      suggest({ filename: assignedFilename, conflictAction: 'uniquify' });
    } catch (_) {
      // Even if status persistence fails, still request the correct filename.
      suggest({ filename: assignedFilename, conflictAction: 'uniquify' });
    }
  }).catch(() => suggest());
  return true;
});

chrome.downloads.onCreated.addListener(item => {
  readPending().then(async pending => {
    if (!isFresh(pending)) return;
    if (pending.downloadId == null || pending.downloadId === item.id) {
      pending.downloadId = item.id;
      if (pending.status === 'prepared') pending.status = 'started';
      pending.startedAt = Date.now();
      await writePending(pending);
    }
  }).catch(() => {});
});

chrome.downloads.onChanged.addListener(delta => {
  if (!delta?.state && !delta?.error) return;
  readPending().then(async pending => {
    if (!pending || pending.downloadId !== delta.id) return;
    if (delta.error?.current) {
      pending.status = 'error';
      pending.error = delta.error.current;
      pending.finishedAt = Date.now();
    } else if (delta.state?.current === 'complete') {
      pending.status = 'complete';
      pending.finishedAt = Date.now();
    } else if (delta.state?.current === 'interrupted') {
      pending.status = 'error';
      pending.error = 'interrupted';
      pending.finishedAt = Date.now();
    }
    await writePending(pending);
  }).catch(() => {});
});
