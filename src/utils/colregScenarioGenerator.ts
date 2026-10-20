import { AisTarget } from '../types';
import { degToRad, radToDeg } from './math';

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

export function generateRandomColregScenario(
  myGps: { lat: number; lon: number },
  myHdg: number,
  myCog: number,
  mySog: number
): { target: AisTarget; colregCase: ColregCase } {
  const cases: ColregCase[] = ['HEAD_ON', 'CROSSING_GIVE_WAY', 'CROSSING_STAND_ON', 'OVERTAKING'];
  const selectedCase = cases[Math.floor(Math.random() * cases.length)];
  const tpl = TARGET_TEMPLATES[Math.floor(Math.random() * TARGET_TEMPLATES.length)];

  let relBearingDeg = 0; // Bearing relative to my heading
  let targetCog = 0;
  let targetSog = 10.0;

  // We want:
  // t = 0..14s: GREEN (dist > 1050m or TCPA > 6.0min)
  // t = 15s: ORANGE (dist <= 1000m or TCPA <= 6.0min)
  // t = 35..40s: RED (dist <= 600m or TCPA <= 3.2min)

  switch (selectedCase) {
    case 'HEAD_ON':
      relBearingDeg = (Math.random() - 0.5) * 8; // ~ 0° dritto di prua
      targetCog = (myCog + 180 + (Math.random() - 0.5) * 6 + 360) % 360;
      targetSog = 10.0 + Math.random() * 2.0;
      break;

    case 'CROSSING_GIVE_WAY':
      // Target coming from starboard (45°..65° relative bearing), crossing our bow
      relBearingDeg = 48 + Math.random() * 15;
      targetCog = (myCog - 90 + (Math.random() - 0.5) * 10 + 360) % 360;
      targetSog = 11.0 + Math.random() * 2.0;
      break;

    case 'CROSSING_STAND_ON':
      // Target coming from port (295°..315° relative bearing), crossing left to right
      relBearingDeg = 305 + Math.random() * 15;
      targetCog = (myCog + 90 + (Math.random() - 0.5) * 10 + 360) % 360;
      targetSog = 9.5 + Math.random() * 2.0;
      break;

    case 'OVERTAKING':
      // Fast target approaching from poppa (190°..210° relative bearing) at 15-18 kts
      relBearingDeg = 195 + Math.random() * 15;
      targetCog = (myCog + (Math.random() - 0.5) * 6 + 360) % 360;
      targetSog = Math.max(14.0, mySog + 8.0 + Math.random() * 3.0);
      break;
  }

  // Calculate relative closing velocity in m/s
  const myVx = mySog * 0.514444 * Math.sin(degToRad(myCog));
  const myVy = mySog * 0.514444 * Math.cos(degToRad(myCog));
  const tVx = targetSog * 0.514444 * Math.sin(degToRad(targetCog));
  const tVy = targetSog * 0.514444 * Math.cos(degToRad(targetCog));

  const relVx = tVx - myVx;
  const relVy = tVy - myVy;
  const relClosingSpeed = Math.sqrt(relVx * relVx + relVy * relVy); // m/s

  // At t = 15s, distance should be ~ 960 meters.
  // Therefore, initial distance at t = 0s is:
  const distAt15s = 960; // meters
  const initialDist = distAt15s + relClosingSpeed * 15; // meters

  const bearingTrueRad = degToRad((myHdg + relBearingDeg + 360) % 360);
  const dLat = (initialDist * Math.cos(bearingTrueRad)) / 111139;
  const dLon = (initialDist * Math.sin(bearingTrueRad)) / (111139 * Math.cos(degToRad(myGps.lat)));

  const lat = myGps.lat + dLat;
  const lon = myGps.lon + dLon;

  const target: AisTarget = {
    id: `urn:mrn:imo:mmsi:${tpl.mmsi}`,
    name: tpl.name,
    type: tpl.type,
    lat,
    lon,
    cog: Math.round(targetCog),
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
    crossDir: 'In Avvicinamento',
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

  return { target, colregCase: selectedCase };
}

export function recalculateArpaForTargets(
  myGps: { lat: number; lon: number },
  myHdg: number,
  myCog: number,
  mySog: number,
  targets: AisTarget[],
  myPropulsion: 'AUTO' | 'SAIL' | 'MOTOR' = 'AUTO'
): { targets: AisTarget[]; topThreat: AisTarget | null } {
  let highestThreat: AisTarget | null = null;
  const isOwnSailing = myPropulsion === 'SAIL' || myPropulsion === 'AUTO';
  const mySpeedMs = mySog * 0.514444;
  const myVx = mySpeedMs * Math.sin(degToRad(myCog));
  const myVy = mySpeedMs * Math.cos(degToRad(myCog));

  const updatedTargets = targets.map(v => {
    if (!v.isMoving || v.sog < 0.3) return v;

    const tSpeedMs = v.sog * 0.514444;
    const tvx = tSpeedMs * Math.sin(degToRad(v.cog));
    const tvy = tSpeedMs * Math.cos(degToRad(v.cog));

    const vx = tvx - myVx;
    const vy = tvy - myVy;

    const x0 = (v.lon - myGps.lon) * 111139 * Math.cos(degToRad(myGps.lat));
    const y0 = (v.lat - myGps.lat) * 111139;

    const currentDist = Math.round(Math.sqrt(x0 * x0 + y0 * y0));

    let v2 = vx * vx + vy * vy;
    if (v2 < 0.000001) v2 = 0.000001;

    const t_sec = -(x0 * vx + y0 * vy) / v2;
    const rawCpa = Math.sqrt((x0 + vx * t_sec) * (x0 + vx * t_sec) + (y0 + vy * t_sec) * (y0 + vy * t_sec));

    const bearingNow = (radToDeg(Math.atan2(x0, y0)) + 360) % 360;
    const relBearingNow = (bearingNow - myHdg + 360) % 360;

    const rawCogDiff = Math.abs(myCog - v.cog) % 360;
    const cogAngularDiff = rawCogDiff > 180 ? 360 - rawCogDiff : rawCogDiff;

    const isCommercial = (v.type >= 70 && v.type <= 89) || (v.type >= 40 && v.type <= 49) || v.type === 60 || (v.length && v.length >= 40);
    const baseRedCpa = isCommercial ? 800 : 300;
    const baseOrangeCpa = isCommercial ? 1852 : 700;
    const maxTcpaWindow = isCommercial ? 15 : 10;

    let tcpa = -1;
    let cpa: number | null = null;

    if (t_sec < 0) {
      tcpa = -1;
      cpa = null;
    } else if (rawCpa > baseOrangeCpa * 1.5 || t_sec / 60.0 > maxTcpaWindow) {
      tcpa = -1;
      cpa = Math.round(rawCpa);
    } else {
      tcpa = parseFloat((t_sec / 60.0).toFixed(1));
      cpa = Math.round(rawCpa);
    }

    const isTcpaThreat = tcpa >= 0 && cpa !== null;

    let risk: 'GREEN' | 'ORANGE' | 'RED' | 'GREY' = 'GREEN';
    let riskMsg = 'NESSUN RISCHIO';

    const wasRed = v.risk === 'RED';
    const redCpaThresh = wasRed ? baseRedCpa + 50 : baseRedCpa;
    const redTcpaThresh = wasRed ? 3.8 : 3.5;
    const redDistThresh = wasRed ? 450 : 400;

    if (isTcpaThreat && tcpa <= maxTcpaWindow) {
      if ((cpa <= redCpaThresh && tcpa <= redTcpaThresh) || currentDist <= redDistThresh) {
        risk = 'RED';
        riskMsg = 'RISCHIO COLLISIONE!';
      } else if ((cpa <= baseOrangeCpa && tcpa <= 6.0) || currentDist <= 1000) {
        risk = 'ORANGE';
        riskMsg = 'ATTENZIONE INCROCIO';
      }
    } else if (t_sec < 0) {
      if (currentDist <= 150) {
        risk = 'ORANGE';
        riskMsg = 'PROSSIMITÀ IN ALLONTANAMENTO';
      } else {
        risk = 'GREEN';
        riskMsg = 'NESSUN RISCHIO';
      }
    } else if (currentDist <= redDistThresh) {
      risk = 'RED';
      riskMsg = 'PROSSIMITÀ CRITICA!';
    } else if (currentDist <= 1000) {
      risk = 'ORANGE';
      riskMsg = 'PROSSIMITÀ ATTENZIONE';
    }

    // COLREG Analysis & Evasive Maneuver
    const bearingCpa = (radToDeg(Math.atan2(x0 + vx * t_sec, y0 + vy * t_sec)) + 360) % 360;
    const relBearingCpa = (bearingCpa - myHdg + 360) % 360;
    const passSector = Math.floor(((relBearingCpa + 45) % 360) / 90);
    const passSide = passSector === 1 ? 'Dritta' : passSector === 3 ? 'Sinistra' : relBearingCpa < 180 ? 'Dritta' : 'Sinistra';

    const bearingTargetToMe = (bearingNow + 180) % 360;
    const relBearingTargetToMe = (bearingTargetToMe - v.cog + 360) % 360;
    const crossesBow = (relBearingNow < 180 && relBearingCpa >= 180) || (relBearingNow >= 180 && relBearingCpa < 180);
    const isReciprocalCourse = Math.abs(cogAngularDiff - 180) <= 25.0;

    // Bow / Stern Crossing Distance (BCD)
    const hdgRad = degToRad(myHdg);
    const xRelOwn = x0 * Math.cos(hdgRad) - y0 * Math.sin(hdgRad);
    const yRelOwn = x0 * Math.sin(hdgRad) + y0 * Math.cos(hdgRad);
    const vxRelOwn = vx * Math.cos(hdgRad) - vy * Math.sin(hdgRad);
    const vyRelOwn = vx * Math.sin(hdgRad) + vy * Math.cos(hdgRad);

    let bcdTxt = '';
    if (Math.abs(vxRelOwn) > 0.01) {
      const tCross = -xRelOwn / vxRelOwn;
      if (tCross > 0) {
        const bcdMeters = yRelOwn + vyRelOwn * tCross;
        if (bcdMeters > 0) {
          bcdTxt = `Taglia a PRUA a ${bcdMeters < 1852 ? Math.round(bcdMeters) + 'm' : (bcdMeters / 1852).toFixed(2) + ' NM'}`;
        } else {
          bcdTxt = `Sfila a POPPA a ${Math.abs(bcdMeters) < 1852 ? Math.round(Math.abs(bcdMeters)) + 'm' : (Math.abs(bcdMeters) / 1852).toFixed(2) + ' NM'}`;
        }
      }
    }

    // Evasive maneuver simulation: find smallest turn to starboard to achieve safe CPA >= 0.5 NM (926m)
    let suggestedTurn = 15;
    if (mySog >= 1.0) {
      for (let turn = 10; turn <= 45; turn += 5) {
        const newCogRad = degToRad((myCog + turn + 360) % 360);
        const myVxNew = mySpeedMs * Math.sin(newCogRad);
        const myVyNew = mySpeedMs * Math.cos(newCogRad);
        const vxNew = tvx - myVxNew;
        const vyNew = tvy - myVyNew;
        let v2New = vxNew * vxNew + vyNew * vyNew;
        if (v2New < 0.000001) v2New = 0.000001;
        const tSecNew = -(x0 * vxNew + y0 * vyNew) / v2New;
        if (tSecNew >= 0) {
          const cpaNew = Math.sqrt((x0 + vxNew * tSecNew) ** 2 + (y0 + vyNew * tSecNew) ** 2);
          if (cpaNew >= 926) {
            suggestedTurn = turn;
            break;
          }
        }
      }
    }
    const targetCourseStbd = Math.round((myHdg + suggestedTurn + 360) % 360);

    const isTargetSailing = v.type === 36 || (typeof v.type === 'string' && String(v.type).toLowerCase().includes('sail'));

    let crossOutcome = bcdTxt || (crossesBow ? 'Passa a Prua' : `Sfila a ${passSide}`);
    let crossRule = '';

    if (t_sec < 0) {
      crossOutcome = 'In Allontanamento';
      crossRule = '';
    } else if (relBearingTargetToMe > 112.5 && relBearingTargetToMe < 247.5 && mySog > v.sog + 0.3) {
      crossOutcome = `Sorpasso a ${passSide}`;
      crossRule = `Accosta di +15° per passare a poppa`;
    } else if (relBearingNow > 112.5 && relBearingNow < 247.5 && v.sog > mySog + 0.3) {
      crossOutcome = `Ti Sorpassa a ${passSide}`;
      crossRule = 'MANTIENI ROTTA (Nave sorpassata)';
    } else if (v.type === 30) {
      crossOutcome = bcdTxt || (crossesBow ? 'Passa a Prua' : `Sfila a ${passSide}`);
      crossRule = `DAI PRECEDENZA (Peschereccio - Accosta a dritta +${suggestedTurn}° -> Rotta ${targetCourseStbd}°)`;
    } else if (isCommercial) {
      crossOutcome = bcdTxt || (crossesBow ? 'Passa a Prua' : `Sfila a ${passSide}`);
      crossRule = `ATTENZIONE COMMERCIALE (Accosta a dritta +${suggestedTurn}° -> Rotta ${targetCourseStbd}°)`;
    } else if (isOwnSailing && !isTargetSailing) {
      crossOutcome = bcdTxt || (crossesBow ? 'Passa a Prua' : `Sfila a ${passSide}`);
      crossRule = 'MANTIENI ROTTA (Nave a vela ha precedenza su motore)';
    } else if (isOwnSailing && isTargetSailing) {
      crossOutcome = bcdTxt || (crossesBow ? 'Passa a Prua' : `Sfila a ${passSide}`);
      if (relBearingNow > 0 && relBearingNow <= 112.5) {
        crossRule = `DAI PRECEDENZA (Vela su dritta - Accosta +${suggestedTurn}° -> Rotta ${targetCourseStbd}°)`;
      } else {
        crossRule = 'MANTIENI ROTTA (Vela vs Vela - Precedenza su dritta)';
      }
    } else if (!isOwnSailing && isTargetSailing) {
      crossOutcome = bcdTxt || (crossesBow ? 'Passa a Prua' : `Sfila a ${passSide}`);
      crossRule = `DAI PRECEDENZA (Nave a vela - Accosta a dritta +${suggestedTurn}° -> Rotta ${targetCourseStbd}°)`;
    } else if (isReciprocalCourse && (relBearingNow >= 350 || relBearingNow <= 10) && (cpa === null || cpa < 400)) {
      crossOutcome = 'Rotta Frontale';
      crossRule = `ACCOSTA A DRITTA (+20° -> Rotta ${(Math.round(myHdg + 20) % 360)}°)`;
    } else {
      crossOutcome = bcdTxt || (crossesBow ? 'Passa a Prua' : `Sfila a ${passSide}`);
      if (relBearingNow > 0 && relBearingNow <= 112.5) {
        crossRule = `DAI PRECEDENZA (Accosta a dritta +${suggestedTurn}° -> Rotta ${targetCourseStbd}°)`;
      } else {
        crossRule = 'MANTIENI ROTTA (Monitora, accosta a dritta se non cede)';
      }
    }

    const crossDir = crossRule ? `${crossOutcome}\n👉 ${crossRule}` : crossOutcome;

    let clockHour = Math.round(relBearingNow / 30) % 12;
    if (clockHour === 0) clockHour = 12;

    const angleOff = Math.round(relBearingNow <= 180 ? relBearingNow : 360 - relBearingNow);
    const sideName = relBearingNow <= 180 ? 'Dritta' : 'Sinistra';
    const sightingTxt = `${angleOff}° a ${sideName} (ore ${clockHour})`;

    const updated: AisTarget = {
      ...v,
      dist: currentDist,
      cpa,
      tcpa,
      risk,
      riskMsg,
      crossDir,
      crossOutcome,
      crossRule,
      sightingTxt,
    };

    // Track highest threat
    if (updated.risk === 'RED' || updated.risk === 'ORANGE') {
      if (!highestThreat) {
        highestThreat = updated;
      } else {
        const riskPriority = { RED: 3, ORANGE: 2, GREEN: 1, GREY: 0 };
        const p1 = riskPriority[updated.risk];
        const p2 = riskPriority[highestThreat.risk];
        if (p1 > p2) {
          highestThreat = updated;
        } else if (p1 === p2) {
          const tcpa1 = updated.tcpa >= 0 ? updated.tcpa : 999;
          const tcpa2 = highestThreat.tcpa >= 0 ? highestThreat.tcpa : 999;
          if (tcpa1 < tcpa2) highestThreat = updated;
        }
      }
    }

    return updated;
  });

  return { targets: updatedTargets, topThreat: highestThreat };
}
