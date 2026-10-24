export function shouldShowDashboardMenu(search) {
  const params = new URLSearchParams(search);
  return params.get('menu') === '1';
}

export function buildDashboardModeUrl(address, mode, layoutDebug = false) {
  const url = new URL(address);
  for (const key of ['menu', 'mode', 'simulate', 'layoutDebug']) url.searchParams.delete(key);
  if (mode === 'simulation') url.searchParams.set('simulate', '1');
  else if (mode === 'mixed') url.searchParams.set('simulate', 'mixed');
  if (layoutDebug) url.searchParams.set('layoutDebug', '1');
  return url.href;
}

export function openDashboardMenu() {
  const url = new URL(window.location.href);
  url.searchParams.set('menu', '1');
  window.location.assign(url.href);
}
