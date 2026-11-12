// Show/hide toggle for password boxes (12 Nov 2026). Used by the sign-in page and
// the admin page. Markup:
//   <div class="pw-wrap"><input type="password" ...><button class="pw-eye" data-pw-eye></button></div>
(function () {
  const svg = (body) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  const EYE = svg('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>');
  const EYE_OFF = svg('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>');

  /** Show (true) or hide (false) the password in the box beside this button. */
  function set(btn, shown) {
    const input = btn.parentNode && btn.parentNode.querySelector('input');
    if (input) input.type = shown ? 'text' : 'password';
    const label = shown ? 'Hide password' : 'Show password';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', shown ? 'true' : 'false');
    btn.title = label;
    btn.innerHTML = shown ? EYE_OFF : EYE;
  }

  function wire(root) {
    (root || document).querySelectorAll('button[data-pw-eye]').forEach((btn) => {
      if (btn.dataset.pwEyeWired) return;
      btn.dataset.pwEyeWired = '1';
      btn.type = 'button';
      set(btn, false);
      btn.addEventListener('click', () => set(btn, btn.getAttribute('aria-pressed') !== 'true'));
    });
  }

  /** Put every box back to hidden, e.g. before a form is sent. */
  function hideAll(root) {
    (root || document).querySelectorAll('button[data-pw-eye]').forEach((btn) => set(btn, false));
  }

  window.pwEye = { wire, hideAll, set, icons: { show: EYE, hide: EYE_OFF } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => wire());
  else wire();
})();
