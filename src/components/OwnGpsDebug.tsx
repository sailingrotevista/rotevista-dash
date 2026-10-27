import { copyText } from '../utils/clipboard.mjs';
import { useEffect, useState } from 'react';
import { applyNormalizedSessionPosition } from '../utils/measurementReset.mjs';
import { resolveOwnShipNavigation } from '../utils/ownShipNavigation.mjs';
import policy from '../../shared/windDataPolicy.json';

// Read-only diagnostic; bounded local log, no server mode or source changes.
export function OwnGpsDebug() {
  const [rows, setRows] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => {
    if (paused) return;
    let disposed = false, busy = false, controller: AbortController | null = null;
    let frame: any = null, key = '', received = 0, rtt = 0, error = '';
    const store = { raw: {}, timestamps: {}, positionExpiresAt:undefined as number | null | undefined };
    const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v.toFixed(0) : '--';
    const date = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? new Date(v).toISOString() : '--';
    const tick = () => {
      const now = Date.now();
      const p = frame?.raw?.['navigation.position'];
      const measurement = frame?.positionMeasurement;
      const timestamp = frame?.rawTimes?.['navigation.position'];
      const navigation = resolveOwnShipNavigation(store.raw, store.timestamps, now, policy, store.positionExpiresAt);
      const line = [new Date(now).toISOString(),
        `GPS ${navigation.position ? 'VALID' : 'STALE / UNAVAILABLE'}`,
        `mode=${frame?.mode ?? '--'} rev=${frame?.revision ?? '--'}`,
        `lat=${p?.latitude ?? '--'} lon=${p?.longitude ?? '--'}`,
        `source=${measurement?.source ?? (frame?.mode === 'simulation' ? 'SIMULATION' : '--')}`,
        `sourceStatus=${measurement?.status ?? '--'} sourceValid=${measurement?.valid ?? '--'}`,
        `fix=${date(timestamp)}`,
        `expires=${date(measurement?.expiresAt)} window=${number(measurement?.validityMs)}ms`,
        `ageAtServer=${number(frame ? frame.serverNow - timestamp : null)}ms`,
        `ageHere=${number(now - store.timestamps['navigation.position'])}ms`,
        `responseAge=${received ? number(now - received) : '--'}ms RTT=${number(rtt)}ms`,
        `score=${number(measurement?.sourceScore)} reason=${measurement?.selectionReason ?? '--'}`,
        error ? `ERROR=${error}` : '',
      ].filter(Boolean).join(' | ');
      setRows(previous => [line, ...previous].slice(0, 300));
      if (busy) return;
      busy = true; controller = new AbortController();
      const abortController = controller;
      const started = performance.now();
      const timeout = setTimeout(() => abortController.abort(), 4000);
      void fetch('/rotevista-dashboard', {cache:'no-store',signal:abortController.signal})
        .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
        .then(next => {
          if (disposed) return;
          if (!Number.isFinite(next.serverNow) || !next.rawTimes) throw new Error('Invalid dashboard frame');
          received = Date.now(); rtt = performance.now() - started; error = ''; frame = next;
          const nextKey = `${next.generation}:${next.revision}:${next.serverNow}`;
          if (nextKey !== key) {
            // Same clock mapping and validity resolver as the dashboard.
            applyNormalizedSessionPosition(store, next.raw?.['navigation.position'], next.rawTimes['navigation.position'], next.serverNow, received, next.positionMeasurement?.expiresAt);
            key = nextKey;
          }
        }).catch(cause => { if (!disposed) error = String(cause.message || cause); })
        .finally(() => {clearTimeout(timeout); busy = false;});
    };
    tick(); const timer = setInterval(tick, 1000);
    return () => {disposed = true;clearInterval(timer);controller?.abort();};
  }, [paused]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([[...rows].reverse().join('\n')], {type:'text/plain'}));
    const link = document.createElement('a'); link.href = url; link.download = 'own-gps-debug.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <main style={{height:'100dvh',overflow:'auto',background:'#101820',color:'#e2e8f0',padding:16,boxSizing:'border-box'}}>
    <header style={{position:'sticky',top:-16,background:'#101820',paddingBottom:12}}>
      <h1 style={{fontSize:22}}>Own GPS debug</h1>
      <p>Read-only · One row per second · Latest 300 rows · GPS deadline: supplied by Normalizer (legacy fallback {policy.positionMaxAgeMs / 1000}s)</p>
      <p>Uses the same GPS validity rule as the dashboard in this separate page. This does not measure another open tab. Source timestamps are preserved.</p>
      <nav style={{display:'flex',gap:12,flexWrap:'wrap'}}>
        <a href="?menu=1" style={{color:'#38bdf8'}}>Dashboard menu</a>
        <button onClick={() => setPaused(value => !value)}>{paused ? 'Resume' : 'Pause'}</button>
        <button onClick={() => setRows([])}>Clear log</button>
        <button onClick={async () => setCopyStatus(await copyText([...rows].reverse().join('\n')) ? 'Log copied' : 'Could not copy. Use Download log.')}>Copy log</button>
        <button onClick={download}>Download log</button>
        <span role="status">{copyStatus}</span>
      </nav>
    </header>
    <pre style={{fontSize:12,lineHeight:1.7,whiteSpace:'pre-wrap',overflowWrap:'anywhere',userSelect:'text'}}>{rows.join('\n\n')}</pre>
  </main>;
}
