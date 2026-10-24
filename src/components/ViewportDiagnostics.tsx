import { useEffect, useState } from 'react';

/** Optional on-device measurements: append ?layoutDebug=1 to the dashboard URL. */
export function ViewportDiagnostics() {
  const [measurements, setMeasurements] = useState('');
  const enabled = new URLSearchParams(window.location.search).get('layoutDebug') === '1';

  useEffect(() => {
    if (!enabled) return;
    const measure = () => {
      const viewport = window.visualViewport;
      const root = document.getElementById('root')?.getBoundingClientRect();
      const grid = document.querySelector('.main-container')?.getBoundingClientRect();
      const last = document.querySelector('.box-twd')?.getBoundingClientRect();
      const round = (value?: number) => value === undefined ? '--' : Math.round(value);
      setMeasurements([
        'LAYOUT v3',
        `Finestra ${window.innerWidth} × ${window.innerHeight}`,
        `Visibile ${round(viewport?.width)} × ${round(viewport?.height)}; top ${round(viewport?.offsetTop)}`,
        `App ${round(root?.height)}; griglia ${round(grid?.height)}`,
        `Fondo TWD ${round(last?.bottom)}; fondo app ${round(root?.bottom)}`,
      ].join('\n'));
    };
    measure();
    const timer = window.setInterval(measure, 500);
    return () => window.clearInterval(timer);
  }, [enabled]);

  if (!enabled) return null;
  return <output style={{
    position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 8px)', left: 8,
    zIndex: 10000, background: '#111e', color: '#fff', padding: 8, borderRadius: 6,
    font: '11px/1.4 monospace', whiteSpace: 'pre', pointerEvents: 'none',
  }}>{measurements}</output>;
}
