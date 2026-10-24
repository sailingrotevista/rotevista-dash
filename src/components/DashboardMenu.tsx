import { useState } from 'react';
import { useViewportHeight } from '../hooks/useViewportHeight';
import { buildDashboardModeUrl } from '../utils/dashboardModes.mjs';

export function DashboardMenu() {
  useViewportHeight();
  const [layoutDebug, setLayoutDebug] = useState(new URLSearchParams(window.location.search).get('layoutDebug') === '1');
  const start = (mode: string) => window.location.assign(buildDashboardModeUrl(window.location.href, mode, layoutDebug));
  return (
    <main className="dashboard-menu">
      <div className="dashboard-menu-panel">
        <header>
          <p className="dashboard-menu-eyebrow">ROTEVISTA</p>
          <h1>Sailing Dashboard</h1>
          <p>Choose how to open the dashboard.</p>
        </header>
        <label className="dashboard-menu-debug">
          <input type="checkbox" checked={layoutDebug} onChange={event => setLayoutDebug(event.target.checked)} />
          <span><strong>Layout debug</strong><small>Show screen measurements for troubleshooting.</small></span>
        </label>
        <div className="dashboard-menu-options">
          <button type="button" onClick={() => start('live')}>
            <strong>Live data</strong><span>Use your boat and AIS data from Signal K.</span>
          </button>
          <button type="button" onClick={() => start('simulation')}>
            <strong>Simulation</strong><span>Try the dashboard with a simulated boat and targets.</span>
          </button>
          <button type="button" onClick={() => start('mixed')}>
            <strong>Live + simulated targets</strong><span>Use real boat data and AIS, with extra targets marked SIM.</span>
          </button>
        </div>
        <p className="dashboard-menu-hint">To return here, tap the status indicator on the dashboard.</p>
      </div>
    </main>
  );
}
