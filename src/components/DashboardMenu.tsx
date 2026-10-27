import { useState } from 'react';
import { useViewportHeight } from '../hooks/useViewportHeight';
import { buildDashboardModeUrl } from '../utils/dashboardModes.mjs';

export function DashboardMenu() {
  useViewportHeight();
  const [layoutDebug, setLayoutDebug] = useState(new URLSearchParams(window.location.search).get('layoutDebug') === '1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = async (mode: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const access = await fetch('/rotevista-alert-session', { cache: 'no-store' });
      if (!access.ok) throw new Error('Dashboard controls unavailable. Update the server plugin or start the dev server.');
      const session = await access.json();
      const response = await fetch('/rotevista-dashboard-mode', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rotevista-Alert-Key': session.token },
        body: JSON.stringify({mode,sessionId:session.sessionId}),
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not change dashboard mode.');
      window.location.assign(buildDashboardModeUrl(window.location.href, 'live', layoutDebug));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not change dashboard mode.'); setBusy(false); }
  };
  return (
    <main className="dashboard-menu">
      <div className="dashboard-menu-panel">
        <header>
          <p className="dashboard-menu-eyebrow">ROTEVISTA</p>
          <h1>Sailing Dashboard</h1>
          <p>Choose the shared mode for all dashboards connected to this server.</p>
        </header>
        <label className="dashboard-menu-debug">
          <input type="checkbox" checked={layoutDebug} onChange={event => setLayoutDebug(event.target.checked)} />
          <span><strong>Layout debug</strong><small>Show screen measurements for troubleshooting.</small></span>
        </label>
        <div className="dashboard-menu-options">
          <button type="button" disabled={busy} onClick={() => start('live')}>
            <strong>Live data</strong><span>Use your boat and AIS data from Signal K.</span>
          </button>
          <button type="button" disabled={busy} onClick={() => start('simulation')}>
            <strong>Simulation</strong><span>Try the dashboard with a simulated boat and targets.</span>
          </button>
          <button type="button" disabled={busy} onClick={() => start('mixed')}>
            <strong>Live + simulated targets</strong><span>Use real boat data and AIS, with extra targets marked SIM.</span>
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        <p><a href="?gpsDebug=1">Own GPS debug</a></p>
        <p className="dashboard-menu-hint">Mode changes affect all devices on this server. Layout debug applies only to this screen.</p>
      </div>
    </main>
  );
}
