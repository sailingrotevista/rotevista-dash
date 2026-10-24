const { test } = require('node:test');
const assert = require('node:assert/strict');

test('the base address opens the real dashboard and only the special URL opens the menu', async () => {
  const { shouldShowDashboardMenu } = await import('../src/utils/dashboardModes.mjs');
  assert.equal(shouldShowDashboardMenu(''), false);
  assert.equal(shouldShowDashboardMenu('?menu=1'), true);
  for (const query of ['?mode=live', '?simulate=1', '?simulate=mixed', '?layoutDebug=1']) {
    assert.equal(shouldShowDashboardMenu(query), false);
  }
  assert.equal(shouldShowDashboardMenu('?simulate=mixed&menu=1'), true);
});

test('mode selection retains the installed plugin path and replaces previous mode flags', async () => {
  const { buildDashboardModeUrl } = await import('../src/utils/dashboardModes.mjs');
  const address = 'http://venus.local:3000/@sailingrotevista/rotevista-dash/index.html?menu=1&simulate=mixed&layoutDebug=1';
  const live = new URL(buildDashboardModeUrl(address, 'live'));
  assert.equal(live.pathname, '/@sailingrotevista/rotevista-dash/index.html');
  assert.equal(live.search, '');
  const simulation = new URL(buildDashboardModeUrl(address, 'simulation', true));
  assert.equal(simulation.search, '?simulate=1&layoutDebug=1');
  const mixed = new URL(buildDashboardModeUrl(address, 'mixed'));
  assert.equal(mixed.search, '?simulate=mixed');
});
