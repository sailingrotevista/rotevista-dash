// Local HTTP dashboards may not expose the secure Clipboard API.
export async function copyText(text, navigatorApi = globalThis.navigator, documentApi = globalThis.document) {
  if (!text) return false;
  try {
    if (navigatorApi?.clipboard?.writeText) {
      await navigatorApi.clipboard.writeText(text);
      return true;
    }
  } catch { /* Try the selection-based fallback if permission was denied. */ }
  if (!documentApi?.body) return false;
  const previousFocus = documentApi.activeElement;
  const selection = documentApi.getSelection?.();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const input = documentApi.createElement('textarea');
  input.value = text;
  input.readOnly = true;
  input.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;pointer-events:none;';
  documentApi.body.appendChild(input);
  try {
    input.focus();
    input.select();
    input.setSelectionRange(0, text.length);
    return documentApi.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    input.remove();
    previousFocus?.focus?.({ preventScroll: true });
    if (selection && ranges.length) {
      selection.removeAllRanges();
      ranges.forEach(range => selection.addRange(range));
    }
  }
}
