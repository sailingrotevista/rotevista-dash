const { test } = require('node:test');
const assert = require('node:assert/strict');
const geometry = import('../src/utils/mapViewport.mjs');

test('portrait tablet uses the wide free area left of the actual side panel', async () => {
    const { getAvailableMapArea, getMapCenterOffset } = await geometry;
    const area = getAvailableMapArea(768, 1024, { left: 340, right: 700, top: 78, bottom: 950 },
        { left: 16, right: 76, top: 110, bottom: 72 });
    assert.equal(area.right, 328);
    assert.equal(area.top, 110);
    const offset = getMapCenterOffset(768, 1024, area);
    const targetPixel = [768 / 2 - offset[0], 1024 / 2 - offset[1]];
    assert.deepEqual(targetPixel, [(area.left + area.right) / 2, (area.top + area.bottom) / 2]);
    assert.ok(targetPixel[0] < 340);
    assert.ok(targetPixel[1] < 700);
});

test('portrait phone places the target in the actual space below a compact panel', async () => {
    const { getAvailableMapArea, getMapCenterOffset } = await geometry;
    const area = getAvailableMapArea(402, 654, { left: 14, right: 334, top: 78, bottom: 400 },
        { right: 76, top: 110, bottom: 72 });
    assert.equal(area.top, 412);
    assert.equal(area.bottom, 582);
    const offset = getMapCenterOffset(402, 654, area);
    assert.equal(654 / 2 - offset[1], 497);
});

test('landscape selection remains left of the panel and keeps collision bounds in the same area', async () => {
    const { getAvailableMapArea } = await geometry;
    const area = getAvailableMapArea(874, 402, { left: 440, right: 800, top: 16, bottom: 386 },
        { right: 76, top: 80, bottom: 72 });
    assert.equal(area.right, 428);
    assert.equal(area.top, 80);
    // These are the exact paddings passed to fitBounds for collision inspection.
    assert.deepEqual([874 - area.right, 402 - area.bottom], [446, 72]);
});

test('panel resizing recalculates the center rather than keeping list dimensions', async () => {
    const { getAvailableMapArea, getMapCenterOffset } = await geometry;
    const area = bottom => getAvailableMapArea(402, 874, { left: 14, right: 334, top: 78, bottom }, { right: 76, top: 110, bottom: 72 });
    const oldOffset = getMapCenterOffset(402, 874, area(600));
    const newOffset = getMapCenterOffset(402, 874, area(420));
    assert.ok(newOffset[1] > oldOffset[1], 'shorter details panel moves target up within the expanded free area');
});

test('pan offsets use map-local coordinates and are independent of the map position in the page', async () => {
    const { getAvailableMapArea } = await geometry;
    const local = { left: 340, right: 700, top: 78, bottom: 950 };
    const pageOrigin = { x: 35, y: 62 };
    const pagePanel = { left: local.left + pageOrigin.x, right: local.right + pageOrigin.x, top: local.top + pageOrigin.y, bottom: local.bottom + pageOrigin.y };
    const converted = { left: pagePanel.left - pageOrigin.x, right: pagePanel.right - pageOrigin.x, top: pagePanel.top - pageOrigin.y, bottom: pagePanel.bottom - pageOrigin.y };
    assert.deepEqual(getAvailableMapArea(768, 1024, local), getAvailableMapArea(768, 1024, converted));
});
