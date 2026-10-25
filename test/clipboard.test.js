const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../src/utils/clipboard.mjs');
function fakeDocument(success = true) {
  const state = { removed: false, focused: false };
  const input = { style: {}, focus() {}, select() {}, setSelectionRange(start, end) { state.range = [start, end]; }, remove() { state.removed = true; } };
  return { state, body: { appendChild(node) { state.text = node.value; } }, activeElement: { focus() { state.focused = true; } }, createElement() { return input; }, execCommand(command) { assert.equal(command, 'copy'); return success; } };
}
test('clipboard waits for successful API copy', async () => {
  const { copyText } = await load();
  let copied;
  assert.equal(await copyText('211265510', { clipboard: { async writeText(text) { copied = text; } } }), true);
  assert.equal(copied, '211265510');
});
test('HTTP without Clipboard API copies MMSI with temporary selection and restores focus', async () => {
  const { copyText } = await load(); const doc = fakeDocument();
  assert.equal(await copyText('211265510', {}, doc), true);
  assert.equal(doc.state.text, '211265510'); assert.deepEqual(doc.state.range, [0, 9]);
  assert.equal(doc.state.removed, true); assert.equal(doc.state.focused, true);
});
test('rejected Clipboard API falls back and failed copy is not reported as success', async () => {
  const { copyText } = await load(); const doc = fakeDocument(false);
  assert.equal(await copyText('211265510', { clipboard: { async writeText() { throw Error('Denied'); } } }, doc), false);
  assert.equal(doc.state.removed, true);
});
