'use strict';
const {deriveVmg}=require('./derivedData/vmg');

// Received measurements retain their provenance. Calculated values are separate
// from instruments: VMG is derived here from normalized inputs.
class SensorDerivedData {
    constructor() { this.current = null; }

    process(snapshot) {
        if (!snapshot || !Number.isFinite(snapshot.sampledAt) || !snapshot.measurements) throw new TypeError('A normalized sensor snapshot is required');
        this.current = this.copy(snapshot);
        this.current.derived = {vmg:deriveVmg(this.current)};
        return this.getSnapshot();
    }

    copy(snapshot) {
        return { sampledAt: snapshot.sampledAt,
            ...(snapshot.derived ? {derived:Object.fromEntries(Object.entries(snapshot.derived).map(([name,m])=>[name,{...m,inputs:m.inputs.map(input=>({...input}))}]))} : {}),
            measurements: Object.fromEntries(
            Object.entries(snapshot.measurements).map(([path, measurement]) => [path, { ...measurement,
                value: measurement.value && typeof measurement.value === 'object' ? { ...measurement.value } : measurement.value,
            }]),
        ) };
    }

    getSnapshot() { return this.current ? this.copy(this.current) : null; }
}

module.exports = { SensorDerivedData };
