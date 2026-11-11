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

  // Track which saved record (if any) is currently loaded, and its name for
  // the "Cloud: <name>" label, so it is always plain what Cloud Save will
  // write to.
  let currentId = null;
  let currentName = null;

  // Which Cloud record the work held in this browser belongs to. It sits in
  // localStorage beside the work itself, but outside the app's prefixes, so
  // it is never snapshotted, exported or restored. It lets a refresh tell
  // "this is still that record, unsaved edits and all" from "the screen now
  // holds something else". The app's restore and Reset remove it too
  // (detachFromCloudRecord in oprams.html), so the key is named there as well.
  const HELD_KEY = 'oprams.cloud.record';
  function readHeld() {
    try {
      const h = JSON.parse(localStorage.getItem(HELD_KEY) || 'null');
      return h && h.id ? h : null;
    } catch { return null; }
  }
  function writeHeld(id, name) {
    try {
      if (id) localStorage.setItem(HELD_KEY, JSON.stringify({ id, name: name || '' }));
      else localStorage.removeItem(HELD_KEY);
    } catch {}
  }

  function setCurrent(id, name) {
    currentId = id || null;
    currentName = currentId ? (name || null) : null;
    writeHeld(currentId, currentName);
    updateCloudLabel();
  }

  function updateCloudLabel() {
    const el = document.getElementById('op-cloudLabel');
    if (!el) return;
    const text = currentId ? 'Cloud: ' + (currentName || 'record open') : 'Not saved to Cloud';
    el.textContent = text;
    el.title = currentId
      ? 'Cloud Save will update the Cloud record “' + (currentName || '') + '”'
      : 'Cloud Save will ask for a name and create a new Cloud record';
  }

  // A JSON restore in the app replaces what is on screen, so it lets go of
  // the open record (it also takes ?id= out of the address). Drop it here
  // too, so a Cloud Save in the moment before the reload cannot write the
  // restored client into the other client's record.
  window.addEventListener('oprams:cloud-detach', () => setCurrent(null));

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

    // Build cloud buttons matching the existing header style.
    const cloudWrap = document.createElement('div');
    cloudWrap.style.cssText = 'display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center;padding-right:8px;margin-right:4px;border-right:1px solid rgba(0,0,0,0.12)';

    const btnCloudOpen = document.createElement('button');
    btnCloudOpen.type = 'button';
    btnCloudOpen.id = 'op-btnCloudOpen';
    btnCloudOpen.className = 'btn btn-outline btn-sm';
    btnCloudOpen.title = 'Open a saved RAMS from your account';
    btnCloudOpen.textContent = 'Cloud Open\u2026';
    btnCloudOpen.addEventListener('click', openSavedModal);

    const btnCloudSave = document.createElement('button');
    btnCloudSave.type = 'button';
    btnCloudSave.id = 'op-btnCloudSave';
    btnCloudSave.className = 'btn btn-primary btn-sm';
    btnCloudSave.title = 'Save this RAMS to your account';
    btnCloudSave.textContent = 'Cloud Save';
    btnCloudSave.addEventListener('click', () => handleCloudSave(false));

    // Always creates a new record, so a client can be split off without
    // overwriting the one that is open.
    const btnSaveAsNew = document.createElement('button');
    btnSaveAsNew.type = 'button';
    btnSaveAsNew.id = 'op-btnSaveAsNew';
    btnSaveAsNew.className = 'btn btn-outline btn-sm';
    btnSaveAsNew.title = 'Save this RAMS as a new Cloud record, leaving the open one as it is';
    btnSaveAsNew.textContent = 'Save as new…';
    btnSaveAsNew.addEventListener('click', () => handleCloudSave(true));

    const cloudLabel = document.createElement('span');
    cloudLabel.id = 'op-cloudLabel';
    cloudLabel.style.cssText = 'font-size:12px;color:var(--text-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    cloudWrap.appendChild(cloudLabel);
    cloudWrap.appendChild(btnCloudOpen);
    cloudWrap.appendChild(btnCloudSave);
    cloudWrap.appendChild(btnSaveAsNew);
    actions.insertBefore(cloudWrap, actions.firstChild);
    updateCloudLabel();

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

    // Which record is on screen. The address names one (?id=) after Cloud
    // Open or Cloud Save; the held marker says which record the work in this
    // browser belongs to. When they agree, or there is no address, the work
    // in the browser IS that record, so keep it: a refresh, Reset branding or
    // signing in again must not fetch the record back over unsaved edits
    // (it used to, every time). Only an address naming a DIFFERENT record
    // fetches it, which is also what stops the load -> reload -> load loop.
    const params = new URLSearchParams(window.location.search);
    const idFromUrl = params.get('id');
    const held = readHeld();
    if (idFromUrl && (!held || held.id !== idFromUrl)) {
      loadById(idFromUrl);
    } else if (held) {
      setCurrent(held.id, held.name);
      rewriteUrlWithId(held.id);
      confirmHeld(held.id);
    }
  }

  // ---------- State snapshot / restore ----------
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

  // Returns false if nothing was reloaded because the write failed.
  function applyStateAndReload(state) {
    if (!state || typeof state !== 'object') return false;
    const keys = state.keys || {};
    try {
      const toDelete = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith(LS_PREFIX) || k.startsWith(BRAND_PREFIX))) {
          toDelete.push(k);
        }
      }
      toDelete.forEach(k => localStorage.removeItem(k));
      Object.entries(keys).forEach(([k, v]) => {
        if (typeof v === 'string') localStorage.setItem(k, v);
      });
    } catch (err) {
      console.error('[oprams-adapter] apply state failed', err);
      alert('Could not load record into local storage: ' + (err && err.message || 'unknown'));
      return false;
    }
    location.reload();
    return true;
  }

  // ---------- Save (push to server) ----------
  // asNew = the "Save as new\u2026" button: always ask for a name and create a
  // new record, even when one is open. Plain Cloud Save is as before: update
  // the open record, or ask for a name when none is open.
  async function handleCloudSave(asNew) {
    const btn = document.getElementById(asNew ? 'op-btnSaveAsNew' : 'op-btnCloudSave');
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }

    try {
      const state = snapshotState();
      const name = derivePrettyName();

      if (currentId && !asNew) {
        // State only: the record keeps the name it was given. Sending the
        // derived name here renamed the record on every save and undid any
        // Rename.
        const { assessment } = await window.api.updateAssessment(currentId, { state });
        setCurrent(currentId, assessment && assessment.name);
      } else {
        const userName = prompt(asNew ? 'Save as a new Cloud record, named:' : 'Save this RAMS to your account as:', name);
        if (userName == null) {
          if (btn) { btn.disabled = false; btn.textContent = original; }
          return;
        }
        const finalName = (userName.trim() || name).slice(0, 250);
        const { assessment } = await window.api.createAssessment(finalName, state);
        setCurrent(assessment.id, assessment.name);
        rewriteUrlWithId(currentId);
      }
      if (btn) btn.textContent = 'Saved \u2713';
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

  function derivePrettyName() {
    try {
      const brandName = (localStorage.getItem('brand.name') || '').trim();
      const date = new Date().toISOString().slice(0, 10);
      const firstHeadField = document.querySelector('[data-key*="title"], [data-key*="project"], [data-key*="site"], .letterhead [contenteditable]');
      let projectLabel = '';
      if (firstHeadField) {
        projectLabel = (firstHeadField.innerText || firstHeadField.textContent || '').trim().slice(0, 80);
      }
      const parts = [];
      if (brandName) parts.push(brandName);
      if (projectLabel) parts.push(projectLabel);
      parts.push('RAMS ' + date);
      return parts.join(' \u2014 ').slice(0, 250);
    } catch {
      return 'Operational RAMS \u2014 ' + new Date().toISOString().slice(0, 10);
    }
  }

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
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(17,24,39,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;';
    backdrop.innerHTML = `
      <div style="background:#fff;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,0.25);width:100%;max-width:560px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:16px 20px;border-bottom:1px solid #e6e8ec;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:15px;font-weight:700;color:#1f2a44">Your saved RAMS</div>
            <div style="font-size:12px;color:#6b7280;margin-top:2px">Cloud-synced \u2014 available from any device</div>
          </div>
          <button type="button" id="op-modal-close" class="btn btn-outline btn-sm">Close</button>
        </div>
        <div id="op-modal-body" style="padding:16px 20px;overflow:auto;flex:1">
          <div style="color:#6b7280;font-style:italic">Loading\u2026</div>
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
      setCurrent(null);
      rewriteUrlWithId('');
      try {
        const toDelete = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith(LS_PREFIX) || k.startsWith(BRAND_PREFIX))) toDelete.push(k);
        }
        toDelete.forEach(k => localStorage.removeItem(k));
      } catch {}
      window.location.href = window.location.pathname;
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
              <button type="button" data-del="${a.id}" class="btn btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger-brd)">Delete</button>
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
        const currentName = row ? row.querySelector('div > div').textContent : '';
        const newName = prompt('Rename to:', currentName);
        if (!newName || newName.trim() === currentName) return;
        try {
          const { assessment } = await window.api.updateAssessment(id, { name: newName.trim().slice(0, 250) });
          const saved = (assessment && assessment.name) || newName.trim();
          if (row) row.querySelector('div > div').textContent = saved;
          if (currentId === id) setCurrent(id, saved);
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
            setCurrent(null);
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
      container.innerHTML = '<div style="color:var(--danger)">Could not load your saved records: ' + escapeHtml(err && err.message ? err.message : 'unknown error') + '</div>';
    }
  }

  async function loadById(id) {
    try {
      const { assessment } = await window.api.getAssessment(id);
      // Sets the held marker too, so the reload that follows keeps this
      // record's work rather than fetching it again.
      setCurrent(assessment.id, assessment.name);
      rewriteUrlWithId(currentId);
      if (applyStateAndReload(assessment.state) === false) {
        // Only part of the record reached this browser: it is not that
        // record, so do not let Cloud Save write it back over the record.
        setCurrent(null);
        rewriteUrlWithId('');
      }
    } catch (err) {
      console.error('[oprams-adapter] loadById failed', err);
      alert('Load failed: ' + (err && err.message || 'unknown'));
    }
  }

  // The held record still there for this account? Picks up its current name
  // (it may have been renamed on another device). If it has gone (deleted
  // elsewhere, or another sign-in on this browser) let go of it, so Cloud
  // Save asks for a name instead of failing. The list call carries names
  // only, never the saved state. No answer (offline) changes nothing.
  async function confirmHeld(id) {
    try {
      const { assessments } = await window.api.listAssessments();
      if (currentId !== id) return;
      const hit = (assessments || []).find(a => a.id === id);
      if (hit) setCurrent(id, hit.name);
      else { setCurrent(null); rewriteUrlWithId(''); }
    } catch {}
  }
})();
