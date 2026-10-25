// These labels describe received values only; never infer status from SOG,
// tracker state, area membership, heading or vessel name.
export function formatReportedNavigationState(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 'NOT AVAILABLE';
  const text=String(value).trim();
  const known={'0':'UNDERWAY USING ENGINE','1':'AT ANCHOR','5':'MOORED','8':'UNDERWAY SAILING','15':'NOT DEFINED'};
  return known[text] || (/^\d+$/.test(text) ? `AIS STATUS CODE ${text}` : text.replace(/[_-]/g,' ').toUpperCase());
}
export function receivedAgeLabel(record,now=Date.now()) {
  if (!record) return null;
  if (!Number.isFinite(record.timestamp)) return 'Timestamp not available';
  if (record.timestamp>now+30000) return 'Source timestamp is in the future';
  const seconds=Math.max(0,Math.floor((now-record.timestamp)/1000));
  return seconds<60 ? `${seconds}s ago` : seconds<3600 ? `${Math.floor(seconds/60)}m ago` : `${Math.floor(seconds/3600)}h ago`;
}

function usefulText(value) {
  if (typeof value !== 'string') return null;
  const text=value.replace(/@+$/g,'').trim();
  const placeholder=text.toUpperCase().replace(/[_-]/g,' ').replace(/\s+/g,' ');
  return !text || /^(N\/?A|NONE|UNKNOWN|NOT AVAILABLE|NOT DECLARED|NOT DEFINED|UNDEFINED|NULL|UNAVAILABLE|UNSPECIFIED|[-?]+)$/.test(placeholder) ? null : text;
}

export function formatAisEta(value) {
  const text=usefulText(value);
  // A timezone is required: do not silently interpret an ambiguous ETA as local time.
  if (!text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) return null;
  const time=Date.parse(text);
  if (!Number.isFinite(time)) return null;
  const date=new Date(time);
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]}, ${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')} UTC`;
}

export function getAisInfo(target) {
  const raw=target.reportedAis;
  const destination=usefulText(raw ? raw.destination?.value : target.destination);
  const eta=formatAisEta(raw ? raw.eta?.value : target.eta);
  const state=usefulText(raw ? raw.navigationState?.value : target.reportedNavigationState);
  const formatted=state===null ? null : usefulText(formatReportedNavigationState(state));
  const status=target.isSimulated ? 'SIMULATED' : formatted;
  const cls=raw ? raw.aisClass?.value : target.aisClass;
  const aisClass=cls==='A'||cls==='B' ? cls : null;
  return {destination,eta,status,aisClass,visible:Boolean(destination||eta||status)};
}
