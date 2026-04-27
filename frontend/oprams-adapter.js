/**
 * Adapter for AHS Operational RAMS (Easy Travel template).
 *
 * Wires the standalone OP RAMS app up to the OP RAMS backend:
 *   - Gates the page behind the session cookie (redirects to login if missing)
 *   - Injects "Cloud Save", "Cloud Open…", user email + "Log out" into the header
 *   - Snapshots ALL localStorage keys with the app's prefix into a single JSON
 *     blob and posts it to /assessments — this is how the whole RAMS state
 *     (auto-saved fields, brand colours, logo dataUrl, etc.) round-trips.
 *
 * Persistence model:
 *   The OP RAMS app persists state by writing every input/contenteditable into
 *   localStorage directly (LS_PREFIX = "easytravel.ramsv1." + brand.* keys).
 *   It has no single in-memory state object to serialise. Easiest reliable
 *   round-trip is to mirror the whole prefix-bucket to the server.
 */
(function () {
  const LOGIN_PAGE = 'index.html';
  const LS_PREFIX = 'easytravel.ramsv1.';
  const BRAND_PREFIX = 'brand.';

  // Track which saved record (if any) is currently loaded.
  let currentId = null;

  // ---------- Auth gate ----------
  (async function gate() {
    try {
      const { user } = await window.api.me();
      whenReady(() => injectHeader(user));
    } catch {
      window.location.href = LOGIN_PAGE;
    }
  })();

  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------- Header augmentation ----------
  function injectHeader(user) {
    const actions = document.querySelector('.header-right');
    if (!actions) {
      console.warn('[oprams-adapter] .header-right not found — skipping header inject');
      return;
    }

    // Build cloud buttons matching the existing header style (.btn .btn-outline / .btn-primary .btn-sm).
    const cloudWrap = document.createElement('div');
    cloudWrap.style.cssText = 'display:inline-flex;gap:6px;align-items:center;padding-right:8px;margin-right:4px;border-right:1px solid rgba(0,0,0,0.12)';

    const btnCloudOpen = document.createElement('button');
    btnCloudOpen.type = 'button';
    btnCloudOpen.id = 'op-btnCloudOpen';
    btnCloudOpen.className = 'btn btn-outline btn-sm';
    btnCloudOpen.title = 'Open a saved RAMS from your account';
    btnCloudOpen.textContent = 'Cloud Open…';
    btnCloudOpen.addEventListener('click', openSavedModal);

    const btnCloudSave = document.createElement('button');
    btnCloudSave.type = 'button';
    btnCloudSave.id = 'op-btnCloudSave';
    btnCloudSave.className = 'btn btn-primary btn-sm';
    btnCloudSave.title = 'Save this RAMS to your account';
    btnCloudSave.textContent = 'Cloud Save';
    btnCloudSave.addEventListener('click', handleCloudSave);

    cloudWrap.appendChild(btnCloudOpen);
    cloudWrap.appendChild(btnCloudSave);
    actions.insertBefore(cloudWrap, actions.firstChild);

    // User badge + logout
    const badge = document.createElement('div');
    badge.style.cssText = 'display:inline-flex;gap:6px;align-items:center;margin-left:8px;padding-left:8px;border-left:1px solid rgba(0,0,0,0.12);font-size:12px';
    badge.innerHTML = `
      <span style="color:#666;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(user.email)}">${escapeHtml(user.email)}</span>
      ${user.role === 'admin' ? `<a href="admin.html" class="btn btn-outline btn-sm" style="text-decoration:none">Admin</a>` : ''}
      <button type="button" id="op-btnLogout" class="btn btn-outline btn-sm">Log out</button>
    `;
    actions.appendChild(badge);
    document.getElementById('op-btnLogout').addEventListener('click', async () => {
      try { await window.api.logout(); } catch {}
      window.location.href = LOGIN_PAGE;
    });

    // If the URL says ?id=<uuid>, auto-load that record on entry.
    const params = new URLSearchParams(window.location.search);
    const idFromUrl = params.get('id');
    if (idFromUrl) loadById(idFromUrl);
  }

  // ---------- State snapshot / restore ----------
  // Read every localStorage key matching the OP RAMS prefixes into a plain
  // object. Returns { keys: { "easytravel.ramsv1.ra.forms": "...", ... } }.
  function snapshotState() {
    const keys = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith(LS_PREFIX) || k.startsWith(BRAND_PREFIX)) {
          keys[k] = localStorage.getItem(k);
        }
      }
    } catch (err) {
      console.error('[oprams-adapter] snapshot failed', err);
    }
    return { keys, savedAt: new Date().toISOString() };
  }

  // Replace local state with the saved state, then reload so the app's own
  // DOMContentLoaded → restoreAll() rehydrates the DOM from localStorage.
  function applyStateAndReload(state) {
    if (!state || typeof state !== 'object') return;
    const keys = state.keys || {};
    try {
      // Wipe existing entries under our prefixes so a load is a true replace,
      // not a merge (otherwise stale rows from the previous record would survive).
      const toDelete = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith(LS_PREFIX) || k.startsWith(BRAND_PREFIX))) {
          toDelete.push(k);
        }
      }
      toDelete.forEach(k => localStorage.removeItem(k));

      // Write the saved snapshot.
      Object.entries(keys).forEach(([k, v]) => {
        if (typeof v === 'string') localStorage.setItem(k, v);
      });
    } catch (err) {
      console.error('[oprams-adapter] apply state failed', err);
      alert('Could not load record into local storage: ' + (err && err.message || 'unknown'));
      return;
    }
    // Reload so the app's init runs with the new state present.
    location.reload();
  }

  // ---------- Save (push to server) ----------
  async function handleCloudSave() {
    const btn = document.getElementById('op-btnCloudSave');
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    try {
      const state = snapshotState();
      const name = derivePrettyName();

      if (currentId) {
        await window.api.updateAssessment(currentId, { name, state });
      } else {
        // Ask the user to confirm/edit the name on first save.
        const userName = prompt('Save this RAMS to your account as:', name);
        if (userName == null) {
          if (btn) { btn.disabled = false; btn.textContent = original; }
          return; // cancelled
        }
        const finalName = (userName.trim() || name).slice(0, 250);
        const { assessment } = await window.api.createAssessment(finalName, state);
        currentId = assessment.id;
        rewriteUrlWithId(currentId);
      }
      if (btn) btn.textContent = 'Saved ✓';
      flashSaveIndicator('Cloud saved');
      setTimeout(() => { if (btn) { btn.textContent = original; btn.disabled = false; } }, 1500);
    } catch (err) {
      console.error('[oprams-adapter] cloud save failed', err);
      if (btn) { btn.textContent = 'Save failed'; btn.disabled = false; }
      setTimeout(() => { if (btn) btn.textContent = original; }, 2000);
      alert('Cloud save failed: ' + (err && err.message ? err.message : 'unknown error') +
            '\n\nYour work is still saved in this browser. Try Cloud Save again when you have a connection.');
    }
  }

  // Build a friendly record name from brand name + active sheet info.
  function derivePrettyName() {
    try {
      const brandName = (localStorage.getItem('brand.name') || '').trim();
      const date = new Date().toISOString().slice(0, 10);
      // Try to grab a project/site label from the first letterhead field if present.
      const firstHeadField = document.querySelector('[data-key*="title"], [data-key*="project"], [data-key*="site"], .letterhead [contenteditable]');
      let projectLabel = '';
      if (firstHeadField) {
        projectLabel = (firstHeadField.innerText || firstHeadField.textContent || '').trim().slice(0, 80);
      }
      const parts = [];
      if (brandName) parts.push(brandName);
      if (projectLabel) parts.push(projectLabel);
      parts.push('RAMS ' + date);
      return parts.join(' — ').slice(0, 250);
    } catch {
      return 'Operational RAMS — ' + new Date().toISOString().slice(0, 10);
    }
  }

  // Briefly flash a message in the existing #saveIndicator span.
  function flashSaveIndicator(msg) {
    const ind = document.getElementById('saveIndicator');
    if (!ind) return;
    const original = ind.textContent;
    ind.textContent = msg;
    setTimeout(() => { ind.textContent = original || 'Saved'; }, 1800);
  }

  function rewriteUrlWithId(id) {
    try {
      const u = new URL(window.location.href);
      if (id) u.searchParams.set('id', id); else u.searchParams.delete('id');
      window.history.replaceState(null, '', u.toString());
    } catch {}
  }

  // ---------- Saved records modal ----------
  async function openSavedModal() {
    const backdrop = document.createElement('div');
    backdrop.id = 'op-saved-backdrop';
    backdrop.style.cssText = `
      position:fixed;inset:0;background:rgba(17,24,39,0.55);z-index:9999;
      display:flex;align-items:center;justify-content:center;padding:20px;
      font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
    `;
    backdrop.innerHTML = `
      <div style="background:#fff;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,0.25);width:100%;max-width:560px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:16px 20px;border-bottom:1px solid #e6e8ec;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:15px;font-weight:700;color:#1f2a44">Your saved RAMS</div>
            <div style="font-size:12px;color:#6b7280;margin-top:2px">Cloud-synced — available from any device</div>
          </div>
          <button type="button" id="op-modal-close" class="btn btn-outline btn-sm">Close</button>
        </div>
        <div id="op-modal-body" style="padding:16px 20px;overflow:auto;flex:1">
          <div style="color:#6b7280;font-style:italic">Loading…</div>
        </div>
        <div style="padding:12px 20px;border-top:1px solid #e6e8ec;display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#6b7280">
          <span>Tip: click <b>Cloud Save</b> to push the current RAMS to your account.</span>
          <button type="button" id="op-modal-new" class="btn btn-outline btn-sm">Start blank</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.getElementById('op-modal-close').addEventListener('click', close);
    document.getElementById('op-modal-new').addEventListener('click', () => {
      if (!confirm('Start a blank RAMS? Unsaved changes in the current form will be lost.')) return;
      currentId = null;
      rewriteUrlWithId('');
      // Wipe local prefix keys so reload starts clean.
      try {
        const toDelete = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith(LS_PREFIX) || k.startsWith(BRAND_PREFIX))) toDelete.push(k);
        }
        toDelete.forEach(k => localStorage.removeItem(k));
      } catch {}
      window.location.href = window.location.pathname; // reload with no query
    });

    await populateSavedList(document.getElementById('op-modal-body'), close);
  }

  async function populateSavedList(container, close) {
    try {
      const { assessments } = await window.api.listAssessments();
      if (!assessments.length) {
        container.innerHTML = '<div style="color:#6b7280;font-style:italic">No saved RAMS yet. Fill in the form and click Cloud Save.</div>';
        return;
      }
      const rows = assessments.map((a) => {
        const updated = new Date(a.updated_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
        return `
          <div data-row="${a.id}" style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 12px;border:1px solid #e6e8ec;border-radius:8px;margin-bottom:8px">
            <div style="min-width:0;flex:1">
              <div style="font-weight:600;font-size:14px;color:#1f2a44;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(a.name)}</div>
              <div style="font-size:12px;color:#6b7280">Updated ${updated}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              <button type="button" data-load="${a.id}" class="btn btn-primary btn-sm">Load</button>
              <button type="button" data-rename="${a.id}" class="btn btn-outline btn-sm">Rename</button>
              <button type="button" data-del="${a.id}" class="btn btn-outline btn-sm" style="color:#c0392b;border-color:#c0392b">Delete</button>
            </div>
          </div>
        `;
      }).join('');
      container.innerHTML = rows;

      container.querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.dataset.load;
        if (!confirm('Load this RAMS? Any unsaved changes in the current form will be replaced.')) return;
        close();
        await loadById(id);
      }));

      container.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.dataset.rename;
        const row = container.querySelector(`[data-row="${id}"]`);
        const currentName = row?.querySelector('div > div')?.textContent || '';
        const newName = prompt('Rename to:', currentName);
        if (!newName || newName.trim() === currentName) return;
        try {
          await window.api.updateAssessment(id, { name: newName.trim().slice(0, 250) });
          if (row) row.querySelector('div > div').textContent = newName.trim();
        } catch (err) {
          alert('Rename failed: ' + (err && err.message || 'unknown'));
        }
      }));

      container.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.dataset.del;
        if (!confirm('Delete this RAMS from your account? This cannot be undone.')) return;
        try {
          await window.api.deleteAssessment(id);
          const row = container.querySelector(`[data-row="${id}"]`);
          if (row) row.remove();
          if (currentId === id) {
            currentId = null;
            rewriteUrlWithId('');
          }
          if (!container.querySelector('[data-row]')) {
            container.innerHTML = '<div style="color:#6b7280;font-style:italic">No saved RAMS yet.</div>';
          }
        } catch (err) {
          alert('Delete failed: ' + (err && err.message ? err.message : 'unknown error'));
        }
      }));
    } catch (err) {
      container.innerHTML = `<div style="color:#c0392b">Could not load your saved records: ${escapeHtml(err && err.message ? err.message : 'unknown error')}</div>`;
    }
  }

  async function loadById(id) {
    try {
      const { assessment } = await window.api.getAssessment(id);
      currentId = assessment.id;
      rewriteUrlWithId(currentId);
      applyStateAndReload(assessment.state);
    } catch (err) {
      console.error('[oprams-adapter] loadById failed', err);
      alert('Load failed: ' + (err && err.message || 'unknown'));
    }
  }
})();
