export async function requestSharedAlertAction({ type, target, state, fetchImpl = fetch, timeoutMs = 5000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let submitted = false;
  const reject = message => Object.assign(new Error(message), { definite: true });
  try {
    const access = await fetchImpl('/rotevista-alert-session', {
      credentials:'same-origin',cache:'no-store',signal:controller.signal,
    });
    if (!access.ok) throw reject('Could not open dashboard alert controls. Check the connection.');
    const session = await access.json();
    if (session.sessionId !== state.sessionId) throw reject('Server restarted. Wait for the dashboard to reconnect before trying again.');
    if (typeof session.token !== 'string' || !session.token) throw reject('Dashboard alert controls are unavailable.');
    submitted = true;
    const response = await fetchImpl('/rotevista-alert-actions', {
      method:'POST',credentials:'same-origin',signal:controller.signal,
      headers:{'Content-Type':'application/json','X-Rotevista-Alert-Key':session.token},
      body:JSON.stringify({type,sessionId:state.sessionId,targetId:target?.id,
        expectedRisk:target?.risk,expectedAlertKind:target?.alertKind || 'COLLISION'}),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw reject(result?.error || 'Alert action rejected. Review the current alert before trying again.');
    if (!result || result.sessionId !== state.sessionId || !Number.isFinite(result.revision)) throw new Error('Invalid confirmation');
    return result;
  } catch (error) {
    if (error.definite) throw error;
    throw new Error(submitted
      ? 'Action not confirmed. It may have reached the server. Check the synchronized alert status before retrying.'
      : 'Could not reach dashboard alert controls. Check the connection and try again.');
  } finally { clearTimeout(timer); }
}
