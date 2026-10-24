// Local-only synthetic contacts. Live contacts never enter this evaluator.
export class MixedAisSimulation {
  constructor(generate, evaluate) {
    this.generate = generate;
    this.evaluate = evaluate;
    this.reset();
  }

  reset() {
    this.targets = [];
    this.startedAt = null;
    this.lastTick = null;
    this.evasiveId = null;
  }

  tick(own, now, vectorMinutes = 15, propulsion = 'AUTO') {
    if (!this.targets.length) {
      this.targets = this.generate(own.position, own.hdg, own.cog, own.sog).targets.map(t => ({
        ...t, id: `sim:${t.id}`, name: `SIM · ${t.name}`, isSimulated: true,
      }));
      this.evasiveId = this.targets[2]?.id;
      this.startedAt = now;
      this.lastTick = now;
    }
    const dt = Math.max(0, (now - this.lastTick) / 1000);
    const previousElapsed = (this.lastTick - this.startedAt) / 1000;
    const elapsed = (now - this.startedAt) / 1000;
    this.lastTick = now;
    this.targets = this.targets.map(t => {
      const turnSeconds = t.id === this.evasiveId
        ? Math.max(0, Math.min(elapsed, 47) - Math.max(previousElapsed, 32)) : 0;
      const cog = (t.cog + turnSeconds * 3) % 360;
      const radians = cog * Math.PI / 180;
      const distance = t.sog * 1852 / 3600 * dt;
      const lat = t.lat + distance * Math.cos(radians) / 111139;
      const lon = t.lon + distance * Math.sin(radians) / (111139 * Math.cos(t.lat * Math.PI / 180));
      const trail = (t.trail || []).filter(p => p.t >= now - vectorMinutes * 60000);
      if (!trail.length || now - trail.at(-1).t >= 30000) trail.push({ lat, lon, t: now });
      return { ...t, lat, lon, cog, trail: trail.slice(-60), age: 0, isProjected: false, contactLost: false };
    });
    const result = this.evaluate(own.position, own.hdg, own.cog, own.sog, this.targets, propulsion);
    this.targets = result.targets;
    const output = this.targets;
    if (elapsed > 60 && this.targets.every(t => t.tcpa !== null && t.tcpa < 0 && t.risk !== 'RED' && t.risk !== 'ORANGE')) {
      this.reset();
    }
    return output;
  }
}

export function mergeAisTargets(realTargets, simulatedTargets) {
  const realIds = new Set(realTargets.map(t => t.id));
  return [...realTargets, ...simulatedTargets.filter(t => !realIds.has(t.id))];
}
