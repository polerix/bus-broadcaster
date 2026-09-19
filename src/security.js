// Escaping helpers for untrusted text (Twitch chat, usernames, colours).
// Loaded as a classic <script> before main.js, and importable from Node tests
// (it only sets globalThis.BBSecurity).
(() => {
  const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"'`]/g, (c) => MAP[c]);
  const COLOR = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;
  const safeColor = (value, fallback = '#9b59b6') =>
    (typeof value === 'string' && COLOR.test(value.trim()) ? value.trim() : fallback);
  globalThis.BBSecurity = Object.freeze({ escapeHtml, safeColor });
})();
