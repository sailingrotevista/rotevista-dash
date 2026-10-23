import { AisTarget } from '../types';
import { degToRad } from './math';
import '../../collisionPipeline.js';

const { CollisionPipeline } = (globalThis as any).RotevistaCollisionPipeline;
const simCollisionPipeline = new CollisionPipeline();

export interface TargetTemplate {
  name: string;
  mmsi: string;
  type: number;
  length: number;
  beam: number;
  draft: number | null;
  callsign: string;
  flag: string;
  destination: string;
  aisClass: 'A' | 'B';
}

const TARGET_TEMPLATES: TargetTemplate[] = [
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

export type ColregCase = 'HEAD_ON' | 'CROSSING_GIVE_WAY' | 'CROSSING_STAND_ON' | 'OVERTAKING';

function buildTargetFromInverseCpa(
  tpl: TargetTemplate,
  myGps: { lat: number; lon: number },
  myCog: number,
  mySog: number,
  targetCog: number,
  targetSog: number,
  tcpaSec: number,
  cpaOffsetMeters: number
): AisTarget {
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
    callsign: tpl.callsign,
    length: tpl.length,
    beam: tpl.beam,
    draft: tpl.draft,
    destination: tpl.destination,
    eta: '18:00',
    aisClass: tpl.aisClass,
    flag: tpl.flag,
    inCluster: false,
    trail: [{ lat, lon }],
  };
}

export function generateRandomColregScenario(
  myGps: { lat: number; lon: number },
  _myHdg: number,
  myCog: number,
  mySog: number
): { target: AisTarget; targets: AisTarget[]; colregCase: ColregCase } {
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

  return { target: t1, targets: [t1, t2, t3], colregCase: 'CROSSING_GIVE_WAY' };
}

export function recalculateArpaForTargets(
  myGps: { lat: number; lon: number },
  myHdg: number,
  myCog: number,
  mySog: number,
  targets: AisTarget[],
  _myPropulsion: 'AUTO' | 'SAIL' | 'MOTOR' = 'AUTO'
): { targets: AisTarget[]; topThreat: AisTarget | null } {
  const now = Date.now();
  let highestThreat: AisTarget | null = null;

  const ownShipInput = {
    lat: myGps.lat,
    lon: myGps.lon,
    sog: mySog,
    cog: myCog,
    hdg: myHdg,
  };

  const updatedTargets = targets.map(v => {
    if (!v.isMoving || v.sog < 0.3) return v.crossDir ? { ...v, crossDir: '', crossRule: '' } : v;

    const evalRes = simCollisionPipeline.evaluateTarget(
      ownShipInput,
      {
        id: v.id,
        mmsi: v.id,
        name: v.name,
        lat: v.lat,
        lon: v.lon,
        sog: v.sog,
        cog: v.cog,
        shipType: typeof v.type === 'number' ? v.type : parseInt(String(v.type), 10) || 0,
        lastUpdate: now - (v.age || 0) * 1000,
        isClassB: v.aisClass !== 'A',
        length: v.length,
        beam: v.beam,
      },
      now
    );

    const bearingNow = evalRes ? evalRes.bearingNowDeg : 0;
    const relBearingNow = (bearingNow - myHdg + 360) % 360;
    const cpa = evalRes && !evalRes.isDiverging ? evalRes.cpaNominalMeters : null;
    const tcpa = evalRes && !evalRes.isDiverging && evalRes.tcpaMinutes >= 0 ? evalRes.tcpaMinutes : -1;
    const isDeferred = evalRes ? Boolean(evalRes.isDeferred) : false;
    const trend = evalRes ? evalRes.trend : 'STABLE';

    let risk: 'GREEN' | 'ORANGE' | 'RED' | 'GREY' = 'GREEN';
    let riskMsg = 'NESSUN RISCHIO';
    if (evalRes && evalRes.alertState === 'RED') {
      risk = 'RED';
      riskMsg = 'RISCHIO COLLISIONE!';
    } else if (evalRes && evalRes.alertState === 'ORANGE') {
      risk = 'ORANGE';
      riskMsg = 'ATTENZIONE INCROCIO';
    }

    const crossOutcome = evalRes && evalRes.isDiverging ? 'In Allontanamento' : 'In Avvicinamento';
    const crossRule = '';
    const crossDir = '';

    let clockHour = Math.round(relBearingNow / 30) % 12;
    if (clockHour === 0) clockHour = 12;
    const angleOff = Math.round(relBearingNow <= 180 ? relBearingNow : 360 - relBearingNow);
    const sideName = relBearingNow <= 180 ? 'Dritta' : 'Sinistra';
    const sightingTxt = `${angleOff}° a ${sideName} (ore ${clockHour})`;

    const updated: AisTarget = {
      ...v,
      dist: evalRes ? Math.round(evalRes.rangeMeters) : v.dist,
      cpa,
      tcpa,
      risk,
      isDeferred,
      trend,
      riskMsg,
      crossDir,
      crossOutcome,
      crossRule,
      sightingTxt,
    };

    if ((updated.risk === 'RED' || updated.risk === 'ORANGE') && !updated.isDeferred) {
      if (!highestThreat) {
        highestThreat = updated;
      } else {
        const riskPriority = { RED: 3, ORANGE: 2, GREEN: 1, GREY: 0 };
        const p1 = riskPriority[updated.risk];
        const p2 = riskPriority[highestThreat.risk];
        if (p1 > p2) {
          highestThreat = updated;
        } else if (p1 === p2) {
          const cpa1 = updated.cpa !== null && updated.cpa >= 0 ? updated.cpa : updated.dist;
          const cpa2 = highestThreat.cpa !== null && highestThreat.cpa >= 0 ? highestThreat.cpa : highestThreat.dist;
          const tcpa1 = updated.tcpa !== null && updated.tcpa > 0 ? updated.tcpa : 999;
          const tcpa2 = highestThreat.tcpa !== null && highestThreat.tcpa > 0 ? highestThreat.tcpa : 999;
          if ((cpa1 + tcpa1 * 60) < (cpa2 + tcpa2 * 60)) highestThreat = updated;
        }
      }
    }

    return updated;
  });

  return { targets: updatedTargets, topThreat: highestThreat };
}

