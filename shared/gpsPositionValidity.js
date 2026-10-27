// Absolute deadline contract shared by server and browser. Speed policy stays
// in GpsNormalizer; older servers and local simulation retain their fallback.
(function(root, factory) {
  const api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  if(root) root.RotevistaGpsValidity=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function gpsPositionFresh(timestamp, now, expiresAt, legacyMaxAgeMs=5000) {
    const deadline=expiresAt===undefined ? timestamp+legacyMaxAgeMs : expiresAt;
    return Number.isFinite(timestamp)&&timestamp<=now&&Number.isFinite(deadline)&&
      deadline>=timestamp&&now<deadline;
  }
  return {gpsPositionFresh};
});
