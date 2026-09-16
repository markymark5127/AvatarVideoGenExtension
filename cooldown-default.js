(() => {
  const MIGRATION_KEY = 'gvpq_busy_initial_15_migrated';
  const TARGET_MINUTES = 15;
  const OLD_DEFAULT_MINUTES = 10;

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  async function setViaUi() {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const input = document.getElementById('gvpq-busyinitial');
      if (input) {
        input.value = String(TARGET_MINUTES);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  async function migrate() {
    try {
      const stored = await chrome.storage.local.get(['gvpq', MIGRATION_KEY]);
      if (stored[MIGRATION_KEY]) return;

      const current = Number(stored.gvpq?.settings?.busyRetryInitialMinutes);
      const shouldMigrate = !Number.isFinite(current) || current === OLD_DEFAULT_MINUTES;

      if (shouldMigrate) {
        const updatedThroughUi = await setViaUi();

        // Fallback for unusual load timing where the queue UI never mounted.
        if (!updatedThroughUi) {
          const latest = await chrome.storage.local.get('gvpq');
          const gvpq = latest.gvpq || {};
          gvpq.settings = { ...(gvpq.settings || {}), busyRetryInitialMinutes: TARGET_MINUTES };
          await chrome.storage.local.set({ gvpq });
        }
      }

      await chrome.storage.local.set({ [MIGRATION_KEY]: true });
    } catch (err) {
      console.warn('[GVQ] Could not migrate busy cooldown default to 15 minutes:', err);
    }
  }

  migrate();
})();
