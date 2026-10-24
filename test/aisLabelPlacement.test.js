const { test } = require('node:test');
const assert = require('node:assert/strict');
const helpers = import('../src/utils/aisLabelPlacement.mjs');
const base = { anchor: { x: 300, y: 300 }, width: 130, height: 50,
  viewport: { left: 8, top: 8, right: 792, bottom: 592 } };

test('avoids a course vector even when the preferred side intersects it', async () => {
    const { chooseAisLabelPlacement } = await helpers;
    const result = chooseAisLabelPlacement({ ...base, preferredSide: 'right',
        segments: [{ from: base.anchor, to: { x: 700, y: 300 } }] });
    assert.equal(result.side, 'left');
});

test('avoids both forward vector and past trail by using a vertical position', async () => {
    const { chooseAisLabelPlacement } = await helpers;
    const result = chooseAisLabelPlacement({ ...base, segments: [
        { from: base.anchor, to: { x: 700, y: 300 } },
        { from: { x: 100, y: 300 }, to: base.anchor },
    ] });
    assert.ok(['top', 'bottom'].includes(result.side));
});

test('keeps a label inside the screen near its right edge', async () => {
    const { chooseAisLabelPlacement } = await helpers;
    const result = chooseAisLabelPlacement({ ...base, anchor: { x: 770, y: 300 } });
    assert.ok(result.rect.right <= base.viewport.right);
    assert.ok(result.rect.left >= base.viewport.left);
});

test('avoids panels and already placed labels', async () => {
    const { chooseAisLabelPlacement } = await helpers;
    const first = chooseAisLabelPlacement(base);
    const next = chooseAisLabelPlacement({ ...base, obstacles: [{ rect: first.rect, weight: 20 }] });
    assert.notEqual(next.side, first.side);
    assert.ok(next.rect.right <= first.rect.left || next.rect.left >= first.rect.right ||
        next.rect.bottom <= first.rect.top || next.rect.top >= first.rect.bottom);
});

test('holds the previous position for a minor preference change but moves away from a route', async () => {
    const { chooseAisLabelPlacement } = await helpers;
    const stable = chooseAisLabelPlacement({ ...base, previousSide: 'right', preferredSide: 'left' });
    assert.equal(stable.side, 'right');
    const blocked = chooseAisLabelPlacement({ ...base, previousSide: 'right',
        segments: [{ from: base.anchor, to: { x: 700, y: 300 } }] });
    assert.notEqual(blocked.side, 'right');
});

test('handles a vertical route and escapes received AIS text for HTML labels', async () => {
    const { chooseAisLabelPlacement, escapeAisLabelText } = await helpers;
    const result = chooseAisLabelPlacement({ ...base, preferredSide: 'top',
        segments: [{ from: base.anchor, to: { x: 300, y: 10 } }] });
    assert.notEqual(result.side, 'top');
    assert.equal(escapeAisLabelText('<img src="x"> & boat'), '&lt;img src=&quot;x&quot;&gt; &amp; boat');
});
