// Shared scenario implementation. Each environment owns an independent evaluator.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.RotevistaScenario = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createScenarioTools(pipeline, MARINA_DI_RAGUSA_SIM_DATA) {
const degToRad = degrees => degrees * Math.PI / 180;

const { CollisionPipeline, applyHarborProximityPolicy } = pipeline;
// Simulation deliberately keeps a shorter base window than the live plugin.
const SIM_BASE_TCPA_MINUTES = 5;
const DELAYED_WARNING_SECONDS = 120;
const simCollisionPipeline = new CollisionPipeline({ baseTcpaMinutes: SIM_BASE_TCPA_MINUTES });














const TARGET_TEMPLATES                   = [
  {
    name: 'S/Y ZEPHYR',
    mmsi: '247123456',
    type: 36,
    length: 14,
    beam: 4,
    draft: 2.1,
    callsign: 'IK2901',
    flag: '🇮🇹 ITA',
    destination: 'VALLETTA',
    aisClass: 'B',
  },
  {
    name: 'MV OCEAN CARRIER',
    mmsi: '235987654',
    type: 70,
    length: 125,
    beam: 18,
    draft: 6.2,
    callsign: 'MABC3',
    flag: '🇬🇧 GBR',
    destination: 'AUGUSTA',
    aisClass: 'A',
  },
  {
    name: 'MT MED SEA',
    mmsi: '211888999',
    type: 80,
    length: 155,
    beam: 22,
    draft: 7.8,
    callsign: 'DD8812',
    flag: '🇩🇪 DEU',
    destination: 'GELA',
    aisClass: 'A',
  },
  {
    name: 'EXPRESS FERRY',
    mmsi: '249555111',
    type: 60,
    length: 82,
    beam: 15,
    draft: 3.5,
    callsign: '9H8831',
    flag: '🇲🇹 MLT',
    destination: 'POZZALLO',
    aisClass: 'A',
  },
  {
    name: 'TUG HERCULES',
    mmsi: '247000123',
    type: 31,
    length: 28,
    beam: 8,
    draft: 3.8,
    callsign: 'IV9002',
    flag: '🇮🇹 ITA',
    destination: 'MALTA OFFSHORE',
    aisClass: 'A',
  },
  {
    name: 'MARE BLU III',
    mmsi: '247333222',
    type: 30,
    length: 22,
    beam: 6,
    draft: 2.5,
    callsign: 'IF5511',
    flag: '🇮🇹 ITA',
    destination: 'FISHING AREA',
    aisClass: 'B',
  },
];



function buildTargetFromInverseCpa(
  tpl                ,
  myGps                              ,
  myCog        ,
  mySog        ,
  targetCog        ,
  targetSog        ,
  tcpaSec        ,
  cpaOffsetMeters
)            {
  const myVx = mySog * 0.514444 * Math.sin(degToRad(myCog));
  const myVy = mySog * 0.514444 * Math.cos(degToRad(myCog));
  const tVx = targetSog * 0.514444 * Math.sin(degToRad(targetCog));
  const tVy = targetSog * 0.514444 * Math.cos(degToRad(targetCog));
  const relVx = tVx - myVx;
  const relVy = tVy - myVy;
  const relSpeed = Math.hypot(relVx, relVy) || 1;
  const perpX = -relVy / relSpeed;
  const perpY = relVx / relSpeed;

  const x0 = perpX * cpaOffsetMeters - relVx * tcpaSec;
  const y0 = perpY * cpaOffsetMeters - relVy * tcpaSec;
  const initialDist = Math.hypot(x0, y0);
  const lat = myGps.lat + y0 / 111139;
  const lon = myGps.lon + x0 / (111139 * Math.cos(degToRad(myGps.lat)));

  return {
    id: `urn:mrn:imo:mmsi:${tpl.mmsi}`,
    name: tpl.name,
    type: tpl.type,
    lat,
    lon,
    cog: Math.round((targetCog + 360) % 360),
    sog: parseFloat(targetSog.toFixed(1)),
    dist: Math.round(initialDist),
    isAnchored: false,
    isMoored: false,
    anchorState: 'UNDERWAY',
    swingRadius: null,
    anchorCenter: null,
    isMoving: true,
    risk: 'GREEN',
    riskMsg: 'NESSUN RISCHIO',
    cpa: null,
    tcpa: -1,
    crossDir: '',
    crossOutcome: 'In Avvicinamento',
    crossRule: '',
    sightingTxt: '',
    age: 0,
    isProjected: false,
    callsign: tpl.callsign,
    length: tpl.length,
    beam: tpl.beam,
    draft: tpl.draft,
    destination: tpl.destination,
    eta: '18:00',
    aisClass: tpl.aisClass,
    flag: tpl.flag,
    inCluster: false,
    trail: Array.from({ length: 31 }, (_, idx) => {
      const secAgo = (30 - idx) * 30;
      const distPast = ((targetSog * 1852) / 3600) * secAgo;
      const pLat = lat - (distPast * Math.cos(degToRad(targetCog))) / 111139;
      const pLon = lon - (distPast * Math.sin(degToRad(targetCog))) / (111139 * Math.cos(degToRad(lat)));
      return { lat: Number(pLat.toFixed(5)), lon: Number(pLon.toFixed(5)), t: Date.now() - secAgo * 1000 };
    }),
  };
}

function generateRandomColregScenario(
  myGps                              ,
  _myHdg        ,
  myCog        ,
  mySog
)                                                                      {
  simCollisionPipeline.targetStates.clear();
  const nonCommercial = TARGET_TEMPLATES.filter(t => t.type < 60).sort(() => Math.random() - 0.5);
  const tpl3 = nonCommercial[0];
  const remaining = TARGET_TEMPLATES.filter(t => t.mmsi !== tpl3.mmsi).sort(() => Math.random() - 0.5);
  const [tpl1, tpl2] = remaining;
  const crit1Sec = (tpl1.type >= 70 ? 10 : tpl1.type === 30 || tpl1.type === 31 ? 8 : 6) * 60;

  // 1. Target Primario: parte ORANGE (TCPA appena sopra soglia critica) e diventa RED dopo ~18s
  const t1 = buildTargetFromInverseCpa(tpl1, myGps, myCog, mySog, myCog - 95, 10.5, crit1Sec + 18, 95);

  // 2. Target Secondario: alterna tra seconda minaccia RED (4.2 min) e minaccia ORANGE (5.2 min)
  const isSecondRed = Math.random() < 0.5;
  const t2Cpa = isSecondRed ? -130 : (tpl2.type >= 70 ? 1100 : 480);
  const t2 = buildTargetFromInverseCpa(tpl2, myGps, myCog, mySog, myCog + 85, 9.8, isSecondRed ? 250 : 310, t2Cpa);

  // 3. Target Manovrante (non-commerciale): parte RED di prua (TCPA 3.5 min) ed esegue virata evasiva COLREG a t=32..47s
  const t3 = buildTargetFromInverseCpa(tpl3, myGps, myCog, mySog, myCog + 176, 11.5, 210, 85);

  // 4. Initially outside the prediction window. With steady motion, its TCPA
  // enters the five-minute window after about two minutes, triggering orange.
  // A separate identity keeps this target available in every random scenario.
  const delayedTemplate                 = {
    name: 'S/Y HORIZON', mmsi: '247999004', type: 36,
    length: 12, beam: 4, draft: 2, callsign: 'SIM004',
    flag: '🇮🇹 ITA', destination: 'SIMULATION', aisClass: 'B',
  };
  const t4 = buildTargetFromInverseCpa(delayedTemplate, myGps, myCog, mySog,
    myCog + 180, Math.max(mySog, 4), SIM_BASE_TCPA_MINUTES * 60 + DELAYED_WARNING_SECONDS, 350);

  return { target: t1, targets: [t1, t2, t3, t4], colregCase: 'CROSSING_GIVE_WAY' };
}

function recalculateArpaForTargets(
  myGps                              ,
  myHdg        ,
  myCog        ,
  mySog        ,
  targets             ,
  _myPropulsion                            = 'AUTO',
  safeBubbleMeters = 45,
  ownAtAnchor = false
)                                                        {
  const now = Date.now();

  const ownShipInput = {
    lat: myGps.lat,
    lon: myGps.lon,
    sog: mySog,
    cog: myCog,
    hdg: myHdg,
    isAnchored: ownAtAnchor,
  };

  const updatedTargets = targets.map(v => {
    const isStoppedOrMoored = !v.isMoving;
    const evalRes = simCollisionPipeline.evaluateTarget(
      ownShipInput,
      {
        id: v.id,
        mmsi: v.id,
        name: v.name,
        lat: v.lat,
        lon: v.lon,
        sog: isStoppedOrMoored ? 0 : v.sog,
        isMoving: !isStoppedOrMoored,
        cog: v.cog,
        shipType: typeof v.type === 'number' ? v.type : parseInt(String(v.type), 10) || 0,
        lastUpdate: now - (v.age || 0) * 1000,
        isClassB: v.aisClass !== 'A',
        length: v.length,
        beam: v.beam,
        isMoored: Boolean(v.isMoored || isStoppedOrMoored),
        inCluster: Boolean(v.inCluster),
        anchorState: v.anchorState,
        predictionStability: v.predictionStability,
      },
      now
    );

    const cpa = evalRes ? Math.round(evalRes.cpaNominalMeters) : null;
    const tcpa = evalRes && evalRes.tcpaMinutes >= 0 ? evalRes.tcpaMinutes : -1;
    const trend = evalRes ? evalRes.trend : 'STABLE';

    let risk                                      = 'GREEN';
    let riskMsg = 'NESSUN RISCHIO';
    if (evalRes && evalRes.alertState === 'RED') {
      risk = 'RED';
      riskMsg = evalRes.reason || 'RISCHIO COLLISIONE!';
    } else if (evalRes && evalRes.alertState === 'ORANGE') {
      risk = 'ORANGE';
      riskMsg = evalRes.reason || 'ATTENZIONE INCROCIO';
    }

    const updated            = {
      ...v,
      isMoving: !isStoppedOrMoored,
      dist: evalRes ? Math.round(evalRes.rangeMeters) : v.dist,
      cpa,
      tcpa,
      risk,
      trend,
      riskMsg,
      effectiveThresholds: evalRes?.effectiveThresholds,
      currentHullClearanceMeters: evalRes?.currentHullClearanceMeters,
      warningBasis: evalRes?.warningBasis,
      instabilityWarning: evalRes?.instabilityWarning,
      crossDir: evalRes ? evalRes.crossDir : '',
      crossOutcome: evalRes ? evalRes.crossOutcome : 'In Avvicinamento',
      crossRule: evalRes ? evalRes.crossRule : '',
      sightingTxt: evalRes ? evalRes.sightingTxt : '',
    };

    if (updated.inCluster && !updated.isMoving) {
      const area = MARINA_DI_RAGUSA_SIM_DATA.harborClusters.find(h => h.id === updated.clusterId);
      updated.proximityArea = area ? { id: area.id, lat: area.lat, lon: area.lon } : undefined;
      applyHarborProximityPolicy(updated, safeBubbleMeters);
      simCollisionPipeline.targetStates.delete(updated.id);
    } else {
      applyHarborProximityPolicy(updated, safeBubbleMeters);
    }
    return updated;
  });

  simCollisionPipeline.sortTargets(updatedTargets);
  const highestThreat = updatedTargets.find(v => (v.risk === 'RED' || v.risk === 'ORANGE')) || null;

  return { targets: updatedTargets, topThreat: highestThreat };
}


return { generateRandomColregScenario, recalculateArpaForTargets };
});
