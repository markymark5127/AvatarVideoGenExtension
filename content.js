(() => {
  const APP_ID = 'gvpq-root';
  if (document.getElementById(APP_ID)) return;

  const state = {
    scenes: [],
    currentIndex: 0,
    running: false,
    paused: false,
    boundUrl: '',
    lastStatus: 'Idle',
    lastSubmittedAt: 0,
    lastVideoCount: 0,
    lastDownloadCount: 0,
    forceFinishRequested: false,
    backgroundImage: null,
    busyRetryCount: 0,
    cooldownUntil: 0,
    settings: {
      prefix: '@markymark5127',
      minWaitSeconds: 20,
      maxWaitMinutes: 8,
      autoDownload: false,
      outputFolder: 'YouTube',
      requireVideoSignal: true,
      activateAvatarEachScene: true,
      avatarMenuIndex: 2,
      busyRetryEnabled: true,
      busyRetryInitialMinutes: 10,
      busyRetryIncrementMinutes: 5
    }
  };

  const ERROR_PHRASES = [
    'you’ve reached a limit',
    "you've reached a limit",
    'rate limit',
    'try again later',
    'unable to generate',
    'couldn’t generate',
    "couldn't generate",
    'something went wrong',
    'generation failed',
    'not available right now',
    'daily limit',
    'usage limit'
  ];

  const BUSY_RESPONSE_PATTERNS = [
    /you have\s+\d+\s+video generation requests running right now[^\n]{0,200}?maximum i can do at one time/i,
    /video generation requests running right now[^\n]{0,200}?maximum i can do at one time/i,
    /you have\s+2\s+video generation requests running right now/i
  ];

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();
  const qsAll = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const visible = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };

  function currentConversationKey() {
    return location.origin + location.pathname;
  }

  function parseScenes(text) {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];

    const headingRegex = /^(?:#{1,6}\s*)?(?:-{2,}\s*)?(scene|clip|shot)\s*(?:#\s*)?(\d+)?\s*(?:[:\-–—]\s*)?(.*?)(?:\s*-{2,})?$/gim;
    const matches = [...normalized.matchAll(headingRegex)];

    if (matches.length >= 2) {
      return matches.map((m, i) => {
        const start = m.index + m[0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : normalized.length;
        const title = `${m[1][0].toUpperCase() + m[1].slice(1)} ${m[2] || i + 1}${m[3] ? ' — ' + m[3].trim() : ''}`;
        return { title, prompt: normalized.slice(start, end).trim() };
      }).filter(s => s.prompt);
    }

    const delimiterParts = normalized
      .split(/\n\s*(?:-{3,}|={3,})\s*\n/g)
      .map(s => s.trim())
      .filter(Boolean);
    if (delimiterParts.length >= 2) {
      return delimiterParts.map((prompt, i) => ({ title: `Scene ${i + 1}`, prompt }));
    }

    return [{ title: 'Scene 1', prompt: normalized }];
  }

  async function saveState() {
    try {
      await chrome.storage.local.set({
        gvpq: {
          scenes: state.scenes,
          currentIndex: state.currentIndex,
          boundUrl: state.boundUrl,
          backgroundImage: state.backgroundImage,
          busyRetryCount: state.busyRetryCount,
          cooldownUntil: state.cooldownUntil,
          settings: state.settings
        }
      });
    } catch (_) {}
  }

  async function loadState() {
    try {
      const { gvpq } = await chrome.storage.local.get('gvpq');
      if (!gvpq) return;
      state.scenes = Array.isArray(gvpq.scenes) ? gvpq.scenes : [];
      state.currentIndex = Number.isInteger(gvpq.currentIndex) ? gvpq.currentIndex : 0;
      state.boundUrl = gvpq.boundUrl || '';
      state.backgroundImage = gvpq.backgroundImage || null;
      state.busyRetryCount = Number.isInteger(gvpq.busyRetryCount) ? gvpq.busyRetryCount : 0;
      state.cooldownUntil = Number(gvpq.cooldownUntil || 0) || 0;
      state.settings = { ...state.settings, ...(gvpq.settings || {}) };
    } catch (_) {}
  }

  function findPromptEditor() {
    const selectors = [
      'rich-textarea [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea[aria-label*="prompt" i]',
      'textarea[placeholder*="ask" i]',
      'textarea'
    ];
    for (const sel of selectors) {
      const candidates = qsAll(sel).filter(visible);
      if (candidates.length) return candidates[candidates.length - 1];
    }
    return null;
  }

  function setEditorText(editor, text) {
    editor.focus();
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(
        editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      if (setter) setter.call(editor, text);
      else editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    // Contenteditable: execCommand still triggers the input path used by many editors.
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text
    }));
  }

  function findSendButton() {
    const buttons = qsAll('button').filter(visible);
    const ranked = buttons.map(btn => {
      const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''} ${btn.innerText || ''}`.toLowerCase();
      let score = 0;
      if (/send|submit/.test(label)) score += 10;
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') score -= 20;
      const rect = btn.getBoundingClientRect();
      if (rect.bottom > innerHeight * 0.55) score += 2;
      return { btn, score };
    }).sort((a, b) => b.score - a.score);

    return ranked[0]?.score > 0 ? ranked[0].btn : null;
  }

  function findStopButton() {
    return qsAll('button').find(btn => {
      if (!visible(btn)) return false;
      const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''} ${btn.innerText || ''}`.toLowerCase();
      return /stop (response|generating|generation)|cancel generation|stop generating/.test(label);
    }) || null;
  }

  function findGenerationIndicator() {
    const candidates = qsAll('button, [role="status"], [aria-live], [aria-label], [title]').filter(el => visible(el) && !isInsideExtension(el));
    return candidates.find(el => {
      const label = elementLabel(el);
      return /stop (response|generating|generation)|cancel generation|stop generating|generating( video)?|creating( your)? video|rendering( video)?/.test(label);
    }) || null;
  }

  function countCompletionHints() {
    const candidates = qsAll('video, canvas, iframe, button, a, [role="button"], [aria-label], [title]').filter(el => visible(el) && !isInsideExtension(el));
    let media = 0;
    let actions = 0;
    for (const el of candidates) {
      const tag = el.tagName;
      const label = elementLabel(el);
      if (tag === 'VIDEO' || tag === 'CANVAS' || tag === 'IFRAME') media++;
      if (/download|play video|open video|view video|share video|save video/.test(label)) actions++;
    }
    return { media, actions };
  }

  function pageHasErrorSinceSubmit() {
    const bodyText = (document.body.innerText || '').toLowerCase();
    return ERROR_PHRASES.find(p => bodyText.includes(p)) || '';
  }


  function textHasBusyResponse(text) {
    const lower = String(text || '').toLowerCase();
    if (!lower) return '';
    for (const pattern of BUSY_RESPONSE_PATTERNS) {
      const m = lower.match(pattern);
      if (m) return m[0];
    }
    return '';
  }

  function countBusyResponsesOnPage() {
    // Count only actual chat-page text. The extension UI is appended outside <body>,
    // so its own cooldown status text cannot inflate this count.
    const bodyText = String(document.body?.innerText || '').toLowerCase();
    const matches = bodyText.match(/video generation requests running right now/g);
    return matches ? matches.length : 0;
  }

  function makeBusyRetryError(message) {
    const err = new Error(message || 'Gemini says the maximum number of video generations are already running right now.');
    err.gvpqCode = 'busy_video_slots';
    return err;
  }

  async function waitForBusyCooldown(sceneTitle) {
    const enabled = state.settings.busyRetryEnabled !== false;
    if (!enabled) {
      throw makeBusyRetryError('Gemini says the maximum number of video generations are already running right now. Auto-retry is disabled.');
    }

    state.busyRetryCount = Math.max(1, Number(state.busyRetryCount || 0) + 1);
    const initial = Math.max(1, Number(state.settings.busyRetryInitialMinutes) || 10);
    const increment = Math.max(0, Number(state.settings.busyRetryIncrementMinutes) || 5);
    const waitMinutes = initial + Math.max(0, state.busyRetryCount - 1) * increment;
    const waitMs = waitMinutes * 60 * 1000;
    state.cooldownUntil = now() + waitMs;
    await saveState();

    while (state.running && !state.paused) {
      const remainingMs = Math.max(0, state.cooldownUntil - now());
      if (remainingMs <= 0) break;
      const totalSeconds = Math.ceil(remainingMs / 1000);
      const mins = Math.floor(totalSeconds / 60);
      const secs = totalSeconds % 60;
      const stamp = `${mins}:${String(secs).padStart(2, '0')}`;
      setStatus(`Gemini says the max video requests are already running. Cooling down ${stamp} before retrying ${sceneTitle} (busy retry #${state.busyRetryCount}, wait ${waitMinutes} min).`);
      await sleep(Math.min(1000, remainingMs));
    }

    state.cooldownUntil = 0;
    await saveState();
    if (!state.running || state.paused) throw new Error('Queue paused.');
    setStatus(`Retrying ${sceneTitle} after busy cooldown…`);
  }

  function countVideoSignals() {
    const videos = qsAll('video').filter(visible).length;
    const downloads = qsAll('button, a').filter(el => {
      if (!visible(el)) return false;
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.innerText || ''}`.toLowerCase();
      return /download/.test(label);
    }).length;
    return { videos, downloads };
  }

  function newestVideoContainer() {
    const vids = qsAll('video').filter(visible);
    if (!vids.length) return null;
    let node = vids[vids.length - 1];
    for (let i = 0; i < 8 && node?.parentElement; i++) {
      node = node.parentElement;
      const hasDownload = qsAll('button, a', node).some(el => {
        const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.innerText || ''}`.toLowerCase();
        return visible(el) && /download/.test(label);
      });
      if (hasDownload) return node;
    }
    return vids[vids.length - 1].parentElement;
  }

  function scrollLikelyConversationToBottom() {
    try {
      window.scrollTo({ top: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), behavior: 'instant' });
    } catch (_) {
      window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    }

    const candidates = qsAll('main, [role="main"], div, section').filter(el => {
      if (isInsideExtension(el)) return false;
      const r = el.getBoundingClientRect?.();
      if (!r || r.width < 450 || r.height < 250) return false;
      if (el.scrollHeight <= el.clientHeight + 150) return false;
      const style = getComputedStyle(el);
      return /(auto|scroll)/.test(style.overflowY || '');
    });

    // Scrolling the largest useful containers covers Gemini's SPA conversation
    // scroller without depending on Google's internal class names.
    candidates
      .sort((a, b) => (b.clientHeight * b.clientWidth) - (a.clientHeight * a.clientWidth))
      .slice(0, 4)
      .forEach(el => { try { el.scrollTop = el.scrollHeight; } catch (_) {} });
  }

  function newestResultAnchor() {
    const candidates = qsAll('video, canvas, iframe, [aria-label], [title], button, a, [role="button"]').filter(el => {
      if (isInsideExtension(el)) return false;
      if (el.tagName === 'VIDEO' || el.tagName === 'CANVAS' || el.tagName === 'IFRAME') return true;
      const label = elementLabel(el);
      return /generated video|video is ready|video ready|play video|open video|view video|share video|save video|download/.test(label);
    });
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  async function revealNewestResultActions() {
    scrollLikelyConversationToBottom();
    await sleep(700);

    const anchor = newestResultAnchor();
    if (anchor) {
      try { anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (_) { anchor.scrollIntoView(); }
      for (const type of ['mouseenter', 'mouseover', 'mousemove']) {
        try { anchor.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
      }
      await sleep(500);
    }
  }

  function findNewestDownloadButton() {
    const all = qsAll('button, a, [role="button"], [role="menuitem"]').filter(el => {
      if (!visible(el) || isInsideExtension(el)) return false;
      const label = elementLabel(el);
      return /(^|\b)(download|download video|save video|save)(\b|$)/.test(label);
    });
    // querySelectorAll is DOM ordered; Gemini appends newer replies/actions later.
    return all.length ? all[all.length - 1] : null;
  }

  function findNewestMoreActionsButton() {
    const all = qsAll('button, [role="button"]').filter(el => {
      if (!visible(el) || isInsideExtension(el)) return false;
      const label = elementLabel(el);
      return /more( options| actions)?|additional actions|open menu/.test(label);
    });
    return all.length ? all[all.length - 1] : null;
  }

  async function findDownloadControlWithReveal() {
    await revealNewestResultActions();
    let btn = findNewestDownloadButton();
    if (btn) return btn;

    // Some Gemini result cards hide Download in a three-dot actions menu.
    const more = findNewestMoreActionsButton();
    if (more) {
      try { more.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
      more.click();
      await sleep(450);
      btn = findNewestDownloadButton();
      if (btn) return btn;
    }

    // One final bottom scroll because Gemini sometimes lazy-renders result actions.
    scrollLikelyConversationToBottom();
    await sleep(800);
    return findNewestDownloadButton();
  }

  function sanitizePathPart(value) {
    return String(value || '')
      .replace(/[<>:\"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '')
      .slice(0, 120) || 'Scene';
  }

  function sceneNumberFromTitle(scene, fallbackIndex) {
    const m = String(scene?.title || '').match(/(?:scene|clip|shot)\s*(\d+)/i);
    return m ? Number(m[1]) : fallbackIndex + 1;
  }

  function downloadBasePathForScene(scene, index) {
    const n = sceneNumberFromTitle(scene, index);
    const padded = String(n).padStart(3, '0');
    const rawTitle = String(scene?.title || `Scene ${n}`);
    const extra = rawTitle
      .replace(/^(?:scene|clip|shot)\s*#?\s*\d+\s*(?:[:\-–—]\s*)?/i, '')
      .trim();
    const filename = extra
      ? `Scene_${padded}_${sanitizePathPart(extra)}`
      : `Scene_${padded}`;
    const folder = String(state.settings.outputFolder || '')
      .split(/[\\/]+/)
      .map(sanitizePathPart)
      .filter(Boolean)
      .join('/');
    return folder ? `${folder}/${filename}` : filename;
  }

  async function getDownloadStatus(token) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GVQ_DOWNLOAD_STATUS', token });
      return response?.pending || null;
    } catch (_) {
      return null;
    }
  }

  async function waitForDownloadStart(token, timeoutMs = 12_000) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await sleep(300);
      const pending = await getDownloadStatus(token);
      if (!pending) continue;
      if (pending.status === 'error') throw new Error(`Chrome download failed: ${pending.error || 'unknown error'}`);
      if (['renamed', 'complete'].includes(pending.status)) return pending;
    }
    return null;
  }

  async function downloadSceneWithConfirmation(scene, index) {
    const btn = await findDownloadControlWithReveal();
    if (!btn) throw new Error(`Finished ${scene.title}, but I could not reveal Gemini’s Download control.`);

    try { btn.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (_) {}
    await sleep(250);

    const basePath = downloadBasePathForScene(scene, index);
    const token = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`);
    const preparedAt = Date.now();

    try {
      const prep = await chrome.runtime.sendMessage({
        type: 'GVQ_PREPARE_DOWNLOAD',
        token,
        basePath,
        sceneTitle: scene.title,
        preparedAt
      });
      if (!prep?.ok) throw new Error(`Could not prepare Chrome download naming: ${prep?.error || 'unknown error'}`);

      btn.click();
      const pending = await waitForDownloadStart(token, 12_000);
      if (!pending) {
        throw new Error(`I clicked Download for ${scene.title}, but Chrome never confirmed the renamed scene download.`);
      }

      return pending.assignedFilename || `${basePath}.mp4`;
    } catch (err) {
      // Do not leave a stale rename token armed after a failed download attempt.
      try { await chrome.runtime.sendMessage({ type: 'GVQ_CLEAR_DOWNLOAD', token }); } catch (_) {}
      throw err;
    }
  }

  function elementLabel(el) {
    return `${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''} ${el.innerText || el.textContent || ''}`.trim().toLowerCase();
  }

  function isInsideExtension(el) {
    return !!el?.closest?.(`#${APP_ID}`);
  }

  function findPlusButton() {
    const editor = findPromptEditor();
    const er = editor?.getBoundingClientRect?.();
    const candidates = qsAll('button, [role="button"]').filter(el => visible(el) && !isInsideExtension(el));

    const ranked = candidates.map(el => {
      const label = elementLabel(el);
      const r = el.getBoundingClientRect();
      let score = 0;

      // Gemini has changed this label a few times, so use both semantics and geometry.
      if (/^(add|plus|attach|upload|tools?)$/.test(label)) score += 20;
      if (/add (file|photo|image|attachment)|attach|upload|add to prompt|open tools/.test(label)) score += 18;
      if ((el.innerText || el.textContent || '').trim() === '+') score += 18;
      if (label.includes('+')) score += 5;
      if (r.bottom > innerHeight * 0.55) score += 3;

      if (er) {
        const dx = Math.abs((r.left + r.width / 2) - er.left);
        const dy = Math.abs((r.top + r.height / 2) - (er.top + er.height / 2));
        // The + button normally sits immediately beside the composer.
        if (dy < 120) score += 8;
        if (dx < 220) score += 6;
        score -= Math.min(8, (dx + dy) / 180);
      }
      return { el, score };
    }).sort((a, b) => b.score - a.score);

    return ranked[0]?.score >= 8 ? ranked[0].el : null;
  }

  function menuCandidates() {
    const selectors = [
      '[role="menuitem"]',
      '[role="option"]',
      '[role="menu"] button',
      '[role="listbox"] button',
      'mat-menu button',
      '.mat-mdc-menu-content button',
      '.cdk-overlay-container button',
      '.cdk-overlay-container [role="button"]'
    ];
    const seen = new Set();
    const out = [];
    for (const sel of selectors) {
      for (const el of qsAll(sel)) {
        if (!visible(el) || isInsideExtension(el) || seen.has(el)) continue;
        const r = el.getBoundingClientRect();
        // Ignore the normal composer toolbar at the bottom of the page.
        if (r.width < 20 || r.height < 16) continue;
        seen.add(el);
        out.push(el);
      }
    }
    return out.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.top - br.top || ar.left - br.left;
    });
  }

  async function activateAvatarTool() {
    if (!state.settings.activateAvatarEachScene) return;

    setStatus('Opening Gemini + menu…');
    const before = new Set(menuCandidates());
    const plus = findPlusButton();
    if (!plus) throw new Error('Could not find Gemini’s + button beside the prompt box.');
    plus.click();

    let candidates = [];
    const deadline = now() + 5000;
    while (now() < deadline) {
      await sleep(180);
      const all = menuCandidates();
      const newlyVisible = all.filter(el => !before.has(el));
      candidates = newlyVisible.length >= 2 ? newlyVisible : all;
      if (candidates.length >= 2) break;
    }

    if (candidates.length < 2) {
      throw new Error('The + menu opened, but I could not find two selectable items.');
    }

    // If Gemini exposes the word "Avatar", use it. Otherwise use the user-confirmed
    // position: second selectable item from the top.
    const avatarByName = candidates.find(el => /\bavatar\b/.test(elementLabel(el)));
    const index = Math.max(1, Number(state.settings.avatarMenuIndex) || 2) - 1;
    const avatarItem = avatarByName || candidates[index];
    if (!avatarItem) throw new Error(`Could not find item #${index + 1} in Gemini’s + menu.`);

    setStatus(`Selecting Avatar (${avatarByName ? 'matched by name' : `menu item ${index + 1}`})…`);
    avatarItem.click();
    await sleep(900);
  }

  function dataUrlToFile(dataUrl, name, type) {
    const parts = String(dataUrl || '').split(',');
    if (parts.length < 2) throw new Error('Stored background image is invalid.');
    const meta = parts[0];
    const binary = atob(parts.slice(1).join(','));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const mime = type || (meta.match(/data:([^;]+)/)?.[1]) || 'image/png';
    return new File([bytes], name || 'GVQ_Background.png', { type: mime });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Could not read image file.'));
      reader.readAsDataURL(file);
    });
  }

  function composerRegion() {
    let node = findPromptEditor();
    for (let i = 0; i < 7 && node?.parentElement; i++) {
      const parent = node.parentElement;
      const r = parent.getBoundingClientRect?.();
      if (r && r.width > 300 && r.height > 70 && r.height < 600) node = parent;
      else break;
    }
    return node || document.body;
  }

  function attachmentHintCount() {
    const root = composerRegion();
    return qsAll('img, [aria-label], [title], button, [role="button"]', root).filter(el => {
      if (isInsideExtension(el)) return false;
      const label = elementLabel(el);
      if (el.tagName === 'IMG') {
        const r = el.getBoundingClientRect();
        return r.width >= 28 && r.height >= 28;
      }
      return /remove (image|attachment|file)|attached (image|file)|image preview|attachment preview/.test(label);
    }).length;
  }

  function hasComposerAttachment() {
    return attachmentHintCount() > 0;
  }

  async function waitForAttachmentPresent(before, timeoutMs = 4500) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await sleep(250);
      const count = attachmentHintCount();
      // Success if Gemini added a new attachment OR if the attachment is already
      // visibly present but the DOM shape did not make our numeric count increase.
      if (count > before || count > 0) return true;
    }
    return false;
  }

  function findGeminiFileInputs() {
    return qsAll('input[type="file"]').filter(el => !isInsideExtension(el)).sort((a, b) => {
      const aa = String(a.getAttribute('accept') || '').toLowerCase();
      const ba = String(b.getAttribute('accept') || '').toLowerCase();
      const as = /image|png|jpe?g|webp/.test(aa) ? 10 : aa ? 2 : 5;
      const bs = /image|png|jpe?g|webp/.test(ba) ? 10 : ba ? 2 : 5;
      return bs - as;
    });
  }

  async function attachBackgroundImage() {
    const bg = state.backgroundImage;
    if (!bg?.dataUrl) return;

    // IMPORTANT: Background attachment is intentionally PASTE-ONLY.
    // Gemini's Avatar beta can accept the paste successfully without exposing a
    // standard attachment chip/DOM marker. Older builds incorrectly assumed that
    // meant paste failed, then clicked Gemini's + button again to look for a file
    // input, causing repeated + menu openings / duplicate attachment attempts.
    // The + button is now reserved exclusively for selecting Avatar.
    setStatus(`Pasting background: ${bg.name || 'image'}…`);

    const file = dataUrlToFile(bg.dataUrl, bg.name, bg.type);
    const editor = findPromptEditor();
    if (!editor) throw new Error('Could not find Gemini’s prompt box while attaching the background image.');

    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      editor.focus();
      const paste = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      const dispatched = editor.dispatchEvent(paste);

      // Give Gemini time to ingest/render the attachment. Do not retry via + even
      // if the beta UI exposes no detectable image chip.
      await sleep(1800);
      setStatus(`Background pasted${dispatched === false ? ' (Gemini handled paste)' : ''}.`);
      return;
    } catch (err) {
      throw new Error(`Could not paste the saved background image into Gemini: ${err?.message || err}`);
    }
  }

  function composePrompt(scene) {
    const prefix = (state.settings.prefix || '').trim();
    const bgInstruction = state.backgroundImage?.dataUrl
      ? 'BACKGROUND REFERENCE: Use the attached image as the exact room/background reference for this scene. Preserve its architecture, furniture placement, wall treatment, lighting character, and overall composition. Keep the avatar naturally integrated into that same environment.'
      : '';
    const body = [bgInstruction, scene.prompt.trim()].filter(Boolean).join('\n\n');
    if (!prefix) return body;
    if (body.toLowerCase().startsWith(prefix.toLowerCase())) return body;
    return `${prefix}\n${body}`;
  }

  function setStatus(text, kind = '') {
    state.lastStatus = text;
    const status = document.querySelector('#gvpq-status');
    if (status) {
      status.textContent = text;
      status.dataset.kind = kind;
    }
    renderProgress();
  }

  function renderProgress() {
    const p = document.querySelector('#gvpq-progress');
    const scene = state.scenes[state.currentIndex];
    if (!p) return;
    p.textContent = state.scenes.length
      ? `${Math.min(state.currentIndex + 1, state.scenes.length)} / ${state.scenes.length}${scene ? ` — ${scene.title}` : ''}`
      : 'No scenes loaded';
  }

  function syncControls() {
    const $ = (id) => document.getElementById(id);
    if ($('gvpq-prefix')) $('gvpq-prefix').value = state.settings.prefix;
    if ($('gvpq-minwait')) $('gvpq-minwait').value = state.settings.minWaitSeconds;
    if ($('gvpq-maxwait')) $('gvpq-maxwait').value = state.settings.maxWaitMinutes;
    if ($('gvpq-download')) $('gvpq-download').checked = state.settings.autoDownload;
    if ($('gvpq-outputfolder')) $('gvpq-outputfolder').value = state.settings.outputFolder || '';
    if ($('gvpq-requirevideo')) $('gvpq-requirevideo').checked = state.settings.requireVideoSignal;
    if ($('gvpq-avatar')) $('gvpq-avatar').checked = state.settings.activateAvatarEachScene;
    if ($('gvpq-avatarindex')) $('gvpq-avatarindex').value = state.settings.avatarMenuIndex;
    if ($('gvpq-busyretry')) $('gvpq-busyretry').checked = state.settings.busyRetryEnabled !== false;
    if ($('gvpq-busyinitial')) $('gvpq-busyinitial').value = state.settings.busyRetryInitialMinutes;
    if ($('gvpq-busyincrement')) $('gvpq-busyincrement').value = state.settings.busyRetryIncrementMinutes;
    if ($('gvpq-bound')) $('gvpq-bound').textContent = state.boundUrl ? `Bound: ${state.boundUrl.replace(location.origin, '')}` : 'Not bound to a chat';
    if ($('gvpq-bg-name')) $('gvpq-bg-name').textContent = state.backgroundImage?.name ? `Background: ${state.backgroundImage.name}` : 'No background image selected';
    renderProgress();
  }

  async function waitUntilFinished(baseline, busyBaselineCount = 0) {
    const started = now();
    const minWait = Math.max(5, Number(state.settings.minWaitSeconds) || 20) * 1000;
    const maxWait = Math.max(1, Number(state.settings.maxWaitMinutes) || 8) * 60 * 1000;
    const baselineHints = countCompletionHints();
    let sawGenerating = false;
    let lastDomChange = now();
    let meaningfulMutation = false;
    let resultLikeMutation = false;

    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        const target = mutation.target?.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target?.parentElement;
        if (target && isInsideExtension(target)) continue;
        lastDomChange = now();
        if (now() - started > 2500) meaningfulMutation = true;

        for (const node of mutation.addedNodes || []) {
          const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
          if (!el || isInsideExtension(el)) continue;
          const label = `${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''} ${el.innerText || ''}`.toLowerCase().slice(0, 1200);
          // Don't treat the user's own prompt (which often contains the word "video") as completion.
          if (/download|play video|open video|view video|save video|share video|generated video|video is ready|video ready/.test(label)) {
            resultLikeMutation = true;
          }
          if (el.matches?.('video, canvas, iframe') || el.querySelector?.('video, canvas, iframe')) {
            resultLikeMutation = true;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'src', 'href'] });

    try {
      while (state.running && !state.paused) {
        await sleep(1000);

        if (state.forceFinishRequested) {
          state.forceFinishRequested = false;
          return countVideoSignals();
        }

        const currentBusyCount = countBusyResponsesOnPage();
        if (currentBusyCount > busyBaselineCount) {
          throw makeBusyRetryError('Gemini says the maximum number of video requests are already running right now.');
        }

        const error = pageHasErrorSinceSubmit();
        if (error) throw new Error(`Gemini page shows: “${error}”`);

        const generating = findGenerationIndicator() || findStopButton();
        if (generating) sawGenerating = true;

        const signals = countVideoSignals();
        const hints = countCompletionHints();
        const hasNewVideo = signals.videos > baseline.videos;
        const hasNewDownload = signals.downloads > baseline.downloads;
        const hasNewHint = hints.media > baselineHints.media || hints.actions > baselineHints.actions;
        const elapsed = now() - started;
        const domStableFor = now() - lastDomChange;
        const generationEnded = sawGenerating && !generating && domStableFor >= 4500;
        const resultSettled = !generating && (hasNewVideo || hasNewDownload || hasNewHint || resultLikeMutation) && domStableFor >= 5500;

        if (elapsed >= minWait) {
          if (generationEnded || resultSettled) return signals;

          // Last-resort beta-UI fallback: Gemini changed the page after submission and then
          // remained completely settled for a while after a reasonable generation window.
          // This avoids waiting forever on custom Avatar components that expose no <video> tag.
          if (!state.settings.requireVideoSignal && meaningfulMutation && !generating && elapsed >= Math.max(minWait, 35000) && domStableFor >= 9000) {
            return signals;
          }
        }

        if (elapsed > maxWait) {
          throw new Error('Timed out waiting for Gemini to finish this scene. If the video is visibly complete, use “Mark finished + continue”.');
        }
      }

      throw new Error('Queue paused.');
    } finally {
      observer.disconnect();
    }
  }

  async function submitCurrentScene() {
    if (!state.scenes.length) throw new Error('Load a scene file first.');
    if (state.currentIndex >= state.scenes.length) {
      setStatus('All scenes complete.', 'ok');
      state.running = false;
      return;
    }

    if (state.boundUrl && currentConversationKey() !== state.boundUrl) {
      throw new Error('This queue is bound to a different Gemini conversation. Open that chat or re-bind here.');
    }

    await activateAvatarTool();
    await attachBackgroundImage();

    const editor = findPromptEditor();
    if (!editor) throw new Error('Could not find Gemini’s prompt box.');

    const scene = state.scenes[state.currentIndex];
    const prompt = composePrompt(scene);
    const baseline = countVideoSignals();
    const busyBaselineCount = countBusyResponsesOnPage();
    setStatus(`Sending ${scene.title}…`);
    setEditorText(editor, prompt);
    await sleep(500);

    const send = findSendButton();
    if (!send) throw new Error('Could not find Gemini’s Send button.');
    send.click();
    state.lastSubmittedAt = now();
    await sleep(1200);
    setStatus(`Generating ${scene.title}…`);

    const finalSignals = await waitUntilFinished(baseline, busyBaselineCount);
    let downloadWarning = '';
    if (state.settings.autoDownload) {
      setStatus(`Revealing Download for ${scene.title}…`);
      try {
        const savedAs = await downloadSceneWithConfirmation(scene, state.currentIndex);
        setStatus(`Download started: ${savedAs}`, 'ok');
        // Give Gemini/Chrome a moment to settle before starting the next generation.
        await sleep(1200);
      } catch (err) {
        downloadWarning = err?.message || String(err);
        setStatus(`Download failed for ${scene.title}; continuing queue. ${downloadWarning}`, 'error');
        await sleep(1000);
      }
    }

    state.currentIndex += 1;
    state.busyRetryCount = 0;
    state.cooldownUntil = 0;
    await saveState();
    if (downloadWarning) {
      setStatus(`Finished ${scene.title}. Download failed, but the queue continued.`, 'error');
    } else {
      setStatus(`Finished ${scene.title}.`, 'ok');
    }
  }

  async function runQueue() {
    if (state.running && !state.paused) return;
    state.running = true;
    state.paused = false;

    try {
      while (state.running && !state.paused && state.currentIndex < state.scenes.length) {
        try {
          await submitCurrentScene();
          if (state.currentIndex < state.scenes.length) {
            setStatus('Waiting before next scene…');
            await sleep(2500);
          }
        } catch (err) {
          if (err?.gvpqCode === 'busy_video_slots') {
            const scene = state.scenes[state.currentIndex];
            await waitForBusyCooldown(scene?.title || `Scene ${state.currentIndex + 1}`);
            continue;
          }
          throw err;
        }
      }
      if (state.currentIndex >= state.scenes.length) {
        state.running = false;
        setStatus('Queue complete.', 'ok');
      }
    } catch (err) {
      state.running = false;
      state.paused = true;
      setStatus(err.message || String(err), 'error');
      await saveState();
    }
  }

  async function handleFile(file) {
    const text = await file.text();
    const scenes = parseScenes(text);
    state.scenes = scenes;
    state.currentIndex = 0;
    state.running = false;
    state.paused = false;
    state.busyRetryCount = 0;
    state.cooldownUntil = 0;
    await saveState();
    setStatus(`Loaded ${scenes.length} scene${scenes.length === 1 ? '' : 's'}.`, 'ok');
    renderProgress();
  }

  function mount() {
    const root = document.createElement('div');
    root.id = APP_ID;
    root.innerHTML = `
      <div class="gvpq-header">
        <strong>Gemini Video Queue</strong>
        <button id="gvpq-collapse" title="Collapse">−</button>
      </div>
      <div id="gvpq-body">
        <div class="gvpq-row gvpq-file-row">
          <label class="gvpq-file-btn">Load scenes<input id="gvpq-file" type="file" accept=".txt,.md,text/plain,text/markdown"></label>
          <button id="gvpq-bind">Bind to this chat</button>
        </div>
        <div id="gvpq-bound" class="gvpq-muted"></div>
        <div id="gvpq-progress" class="gvpq-progress">No scenes loaded</div>
        <div id="gvpq-status" class="gvpq-status">Idle</div>

        <div class="gvpq-controls">
          <button id="gvpq-start" class="gvpq-primary">Start / Resume</button>
          <button id="gvpq-pause">Pause</button>
          <button id="gvpq-next">Send one</button>
          <button id="gvpq-retry">Retry current</button>
          <button id="gvpq-finish">Mark finished + continue</button>
        </div>

        <details>
          <summary>Settings</summary>
          <label>Prompt prefix
            <input id="gvpq-prefix" type="text" placeholder="@avatarHandle">
          </label>
          <div class="gvpq-two">
            <label>Min wait (sec)
              <input id="gvpq-minwait" type="number" min="5" max="300">
            </label>
            <label>Timeout (min)
              <input id="gvpq-maxwait" type="number" min="1" max="30">
            </label>
          </div>
          <label class="gvpq-check"><input id="gvpq-avatar" type="checkbox"> Click + and select Avatar before every scene</label>
          <label>Avatar position in + menu
            <input id="gvpq-avatarindex" type="number" min="1" max="20" value="2">
          </label>
          <label class="gvpq-check"><input id="gvpq-busyretry" type="checkbox"> Auto-retry when Gemini says the max number of video requests are already running</label>
          <div class="gvpq-two">
            <label>Busy cooldown start (min)
              <input id="gvpq-busyinitial" type="number" min="1" max="120" value="10">
            </label>
            <label>Extra cooldown after each consecutive busy response (min)
              <input id="gvpq-busyincrement" type="number" min="0" max="60" value="5">
            </label>
          </div>
          <label>Background/reference image
            <input id="gvpq-bg-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
          </label>
          <div class="gvpq-row">
            <span id="gvpq-bg-name" class="gvpq-muted">No background image selected</span>
            <button id="gvpq-bg-clear" type="button">Clear image</button>
          </div>
          <div class="gvpq-muted">When set, the same image is pasted once into every scene after Avatar is selected. The + menu is never used for the image.</div>
          <label class="gvpq-check"><input id="gvpq-requirevideo" type="checkbox"> Wait for a new video/download signal</label>
          <label class="gvpq-check"><input id="gvpq-download" type="checkbox"> Auto-download each completed video</label>
          <label>Download subfolder
            <input id="gvpq-outputfolder" type="text" placeholder="YouTube">
          </label>
          <div class="gvpq-muted">Saved inside Chrome’s configured Downloads folder. Example: Downloads/YouTube/Scene_027.mp4 or Downloads/YouTube/LaserDisc/Scene_027.mp4</div>
          <button id="gvpq-reset" class="gvpq-danger">Reset queue</button>
        </details>
      </div>
    `;
    document.documentElement.appendChild(root);

    const $ = (id) => document.getElementById(id);
    $('gvpq-file').addEventListener('change', e => e.target.files?.[0] && handleFile(e.target.files[0]));
    $('gvpq-bg-file').addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!String(file.type || '').startsWith('image/')) {
        setStatus('Background file must be an image.', 'error');
        return;
      }
      try {
        setStatus('Saving background image…');
        const dataUrl = await fileToDataUrl(file);
        state.backgroundImage = { name: file.name, type: file.type || 'image/png', dataUrl };
        await saveState();
        syncControls();
        setStatus(`Saved background image: ${file.name}`, 'ok');
      } catch (err) {
        setStatus(`Could not save background image: ${err.message || err}`, 'error');
      } finally {
        e.target.value = '';
      }
    });
    $('gvpq-bg-clear').addEventListener('click', async () => {
      state.backgroundImage = null;
      await saveState();
      syncControls();
      setStatus('Background image cleared.', 'ok');
    });
    $('gvpq-bind').addEventListener('click', async () => {
      state.boundUrl = currentConversationKey();
      await saveState();
      syncControls();
      setStatus('Bound to this Gemini conversation.', 'ok');
    });
    $('gvpq-start').addEventListener('click', runQueue);
    $('gvpq-pause').addEventListener('click', async () => {
      state.paused = true;
      state.running = false;
      await saveState();
      setStatus('Paused.');
    });
    $('gvpq-next').addEventListener('click', async () => {
      if (state.running) return;
      state.running = true;
      state.paused = false;
      try { await submitCurrentScene(); }
      catch (err) { setStatus(err.message || String(err), 'error'); }
      finally { state.running = false; await saveState(); }
    });
    $('gvpq-retry').addEventListener('click', async () => {
      if (state.running) return;
      setStatus('Ready to retry current scene.');
      runQueue();
    });
    $('gvpq-finish').addEventListener('click', async () => {
      if (state.running) {
        state.forceFinishRequested = true;
        setStatus('Marking current scene finished…', 'ok');
        return;
      }
      if (state.currentIndex < state.scenes.length) {
        state.currentIndex += 1;
        state.busyRetryCount = 0;
        state.cooldownUntil = 0;
        await saveState();
        renderProgress();
        setStatus('Current scene marked finished. Click Start / Resume to continue.', 'ok');
      }
    });
    $('gvpq-reset').addEventListener('click', async () => {
      state.scenes = [];
      state.currentIndex = 0;
      state.running = false;
      state.paused = false;
      state.busyRetryCount = 0;
      state.cooldownUntil = 0;
      await saveState();
      setStatus('Queue reset.');
      renderProgress();
    });
    $('gvpq-collapse').addEventListener('click', () => {
      const body = $('gvpq-body');
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      $('gvpq-collapse').textContent = hidden ? '−' : '+';
    });

    const settingMap = {
      'gvpq-prefix': ['prefix', 'value'],
      'gvpq-minwait': ['minWaitSeconds', 'value'],
      'gvpq-maxwait': ['maxWaitMinutes', 'value'],
      'gvpq-download': ['autoDownload', 'checked'],
      'gvpq-outputfolder': ['outputFolder', 'value'],
      'gvpq-requirevideo': ['requireVideoSignal', 'checked'],
      'gvpq-avatar': ['activateAvatarEachScene', 'checked'],
      'gvpq-avatarindex': ['avatarMenuIndex', 'value'],
      'gvpq-busyretry': ['busyRetryEnabled', 'checked'],
      'gvpq-busyinitial': ['busyRetryInitialMinutes', 'value'],
      'gvpq-busyincrement': ['busyRetryIncrementMinutes', 'value']
    };
    Object.entries(settingMap).forEach(([id, [key, prop]]) => {
      $(id).addEventListener('change', async (e) => {
        state.settings[key] = prop === 'checked' ? e.target.checked : e.target.value;
        await saveState();
      });
    });

    syncControls();
  }

  (async () => {
    await loadState();
    mount();
  })();
})();
