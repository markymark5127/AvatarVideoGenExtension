(() => {
  const GUARD_ID = 'gvpq-completion-guard';
  const ROOT_ID = 'gvpq-root';
  const MIN_RESULT_AGE_MS = 12_000;
  const RESULT_STABLE_MS = 3_500;
  const NO_NATIVE_FALLBACK_MS = 25_000;
  const POLL_MS = 750;
  const MUTATION_DEBOUNCE_MS = 150;

  let session = null;
  let pollTimer = null;
  let mutationPollTimer = null;

  const now = () => Date.now();
  const qsAll = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function isExtensionNode(el) {
    return !!el?.closest?.(`#${ROOT_ID}`) || el?.id === GUARD_ID;
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function labelFor(el) {
    if (!el) return '';
    const aria = el.getAttribute?.('aria-label') || '';
    const title = el.getAttribute?.('title') || '';
    const text = (el.innerText || el.textContent || '').trim();
    return `${aria} ${title} ${text}`.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function resultSignature(el) {
    if (!el) return '';
    const src = String(
      el.currentSrc ||
      el.getAttribute?.('src') ||
      el.getAttribute?.('poster') ||
      el.getAttribute?.('href') ||
      ''
    );
    return `${el.tagName || ''}|${labelFor(el).slice(0, 350)}|${src}`;
  }

  function resultCandidates() {
    return qsAll('video, canvas, iframe, button, a, [role="button"], [role="status"], [aria-label], [title]')
      .filter(el => visible(el) && !isExtensionNode(el));
  }

  function hasNearbyVideoAction(el) {
    let node = el;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      const controls = qsAll('button, a, [role="button"]', node);
      if (controls.some(control => {
        if (!visible(control) || isExtensionNode(control)) return false;
        return /\b(download|download video|play video|open video|view video|save video|share video)\b/.test(labelFor(control));
      })) return true;
    }
    return false;
  }

  function isStrongResult(el) {
    if (!visible(el) || isExtensionNode(el)) return false;

    const tag = el.tagName;
    const label = labelFor(el);
    const completionLabel = /\b(generated video|video is ready|video ready|download video|play video|open video|view video|save video|share video)\b/;

    if (completionLabel.test(label)) return true;

    if (tag === 'VIDEO') {
      return Boolean(el.currentSrc || el.getAttribute('src') || el.getAttribute('poster') || el.readyState > 0 || hasNearbyVideoAction(el));
    }

    if (tag === 'CANVAS' || tag === 'IFRAME') {
      return hasNearbyVideoAction(el);
    }

    if ((tag === 'BUTTON' || tag === 'A' || el.getAttribute('role') === 'button') && /\b(download|play|open|view|save|share)\b/.test(label) && /video/.test(label)) {
      return true;
    }

    return false;
  }

  function snapshotResults() {
    const nodes = new Set();
    const signatures = new Map();
    for (const el of resultCandidates()) {
      nodes.add(el);
      signatures.set(el, resultSignature(el));
    }
    return { nodes, signatures };
  }

  function nativeGenerationIndicator() {
    const candidates = qsAll('button, [role="status"], [role="progressbar"], [aria-live], [aria-label], [title], [aria-busy="true"]')
      .filter(el => visible(el) && !isExtensionNode(el));

    return candidates.find(el => {
      if (el.getAttribute?.('aria-busy') === 'true') return true;
      const label = labelFor(el).slice(0, 500);
      return /\b(stop response|stop generating|stop generation|cancel generation|generating video|creating your video|creating video|rendering video|preparing video)\b/.test(label);
    }) || null;
  }

  function findNewResultEvidence() {
    if (!session) return null;

    const candidates = resultCandidates();
    for (let i = candidates.length - 1; i >= 0; i--) {
      const el = candidates[i];
      if (!isStrongResult(el)) continue;

      const currentSignature = resultSignature(el);
      if (!session.baseline.nodes.has(el)) {
        return { el, signature: currentSignature, reason: 'new result element' };
      }

      const oldSignature = session.baseline.signatures.get(el) || '';
      if (currentSignature !== oldSignature) {
        return { el, signature: currentSignature, reason: 'result element changed' };
      }
    }

    return null;
  }

  function ensureGuardElement() {
    let guard = document.getElementById(GUARD_ID);
    if (!guard) {
      guard = document.createElement('div');
      guard.id = GUARD_ID;
      guard.setAttribute('role', 'status');
      guard.setAttribute('aria-label', 'Generating video completion guard');
      guard.setAttribute('data-gvpq-completion-guard', 'armed');
      Object.assign(guard.style, {
        position: 'fixed',
        left: '-10000px',
        top: '0',
        width: '1px',
        height: '1px',
        opacity: '0',
        pointerEvents: 'none',
        overflow: 'hidden'
      });
      (document.body || document.documentElement).appendChild(guard);
    }
    return guard;
  }

  function removeGuardElement() {
    document.getElementById(GUARD_ID)?.remove();
  }

  function setRootDiagnostic(value) {
    const root = document.getElementById(ROOT_ID);
    if (root) root.dataset.completionGuard = value;
  }

  function clearSession(reason = 'cleared') {
    if (session) console.debug('[GVQ Guard]', reason);
    session = null;
    removeGuardElement();
    setRootDiagnostic(reason);
  }

  function armForSubmission() {
    const baseline = snapshotResults();
    session = {
      startedAt: now(),
      baseline,
      sawNativeGenerating: false,
      evidenceSignature: '',
      evidenceStableSince: 0
    };
    ensureGuardElement();
    setRootDiagnostic('armed');
    console.debug('[GVQ Guard] Armed completion guard for scene submission.');
  }

  function extensionIsActivelySending() {
    const status = document.getElementById('gvpq-status');
    const text = (status?.textContent || '').trim().toLowerCase();
    return text.startsWith('sending ');
  }

  function poll() {
    if (!session) return;

    const root = document.getElementById(ROOT_ID);
    if (!root) {
      clearSession('extension-unmounted');
      return;
    }

    const elapsed = now() - session.startedAt;
    const nativeGenerating = nativeGenerationIndicator();
    if (nativeGenerating) session.sawNativeGenerating = true;

    const evidence = findNewResultEvidence();
    const hasStartConfidence = session.sawNativeGenerating || elapsed >= NO_NATIVE_FALLBACK_MS;
    const safeToConfirm = !nativeGenerating && elapsed >= MIN_RESULT_AGE_MS && hasStartConfidence;

    if (evidence && safeToConfirm) {
      const key = `${evidence.reason}|${evidence.signature}`;
      if (session.evidenceSignature !== key) {
        session.evidenceSignature = key;
        session.evidenceStableSince = now();
        setRootDiagnostic('candidate');
        console.debug('[GVQ Guard] Completion candidate:', evidence.reason, evidence.el);
      } else if (now() - session.evidenceStableSince >= RESULT_STABLE_MS) {
        console.debug('[GVQ Guard] Confirmed completed video result. Releasing queue.');
        clearSession('confirmed');
        return;
      }
    } else {
      session.evidenceSignature = '';
      session.evidenceStableSince = 0;
      setRootDiagnostic(nativeGenerating ? 'generating' : 'waiting-result');
    }
  }

  function scheduleMutationPoll() {
    if (!session || mutationPollTimer) return;
    mutationPollTimer = setTimeout(() => {
      mutationPollTimer = null;
      poll();
    }, MUTATION_DEBOUNCE_MS);
  }

  document.addEventListener('click', event => {
    const target = event.target?.closest?.('button, [role="button"], a');
    if (!target) return;

    if (target.id === 'gvpq-pause' || target.id === 'gvpq-reset' || target.id === 'gvpq-finish') {
      clearSession(`manual-${target.id.replace('gvpq-', '')}`);
      return;
    }

    if (!extensionIsActivelySending()) return;
    if (isExtensionNode(target)) return;

    const label = labelFor(target);
    if (/\b(send|submit)\b/.test(label)) {
      armForSubmission();
    }
  }, true);

  const observer = new MutationObserver(scheduleMutationPoll);

  const startObserver = () => {
    if (!document.body) {
      requestAnimationFrame(startObserver);
      return;
    }
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-label', 'title', 'src', 'poster', 'href', 'aria-busy']
    });
    pollTimer = setInterval(poll, POLL_MS);
  };

  startObserver();
})();
