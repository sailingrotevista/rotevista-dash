'use strict';

const unwrap = node => node && typeof node === 'object' && 'value' in node ? node.value : node;
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
function record(node, transform = value => value) {
    const value = transform(unwrap(node));
    if (value === undefined || value === null) return null;
    const timestamp = Date.parse(node?.timestamp);
    return {value,timestamp:Number.isFinite(timestamp)?timestamp:null,source:text(node?.$source)};
}
const positive = value => numeric(value) !== null && value > 0 ? value : null;
const nonnegative = value => numeric(value) !== null && value >= 0 ? value : null;
const angle = value => numeric(value) !== null && value >= 0 && value < Math.PI*2 ? value*180/Math.PI : null;

// Preserve received measurements separately from cached navigation fallbacks,
// projected coordinates and classifications inferred by our own engine.
function extractReportedAis(vessel) {
    const nav=vessel.navigation || {},design=vessel.design || {},ais=vessel.sensors?.ais || {};
    const communication=unwrap(vessel.communication) || {};
    const destination=nav.destination || {};
    const callsignNode = communication.callsignVhf;
    const callsignRecord = callsignNode && typeof callsignNode === 'object'
        ? record(callsignNode,text)
        : record(vessel.communication,value=>text(value?.callsignVhf)) || record(callsignNode,text);
    return {
        name:record(vessel.name,text),
        position:record(nav.position,value=>value && numeric(value.latitude)!==null && numeric(value.longitude)!==null &&
            Math.abs(value.latitude)<=90 && Math.abs(value.longitude)<=180 ? {lat:value.latitude,lon:value.longitude} : null),
        sog:record(nav.speedOverGround,value=>nonnegative(value)!==null ? value*1.94384449 : null),
        cog:record(nav.courseOverGroundTrue,angle),
        heading:record(nav.headingTrue,angle),
        navigationState:record(nav.state,value=>typeof value==='number' && Number.isInteger(value) ? String(value) : text(value)),
        aisClass:record(ais.class,value=>typeof value==='string' && ['A','B'].includes(value.trim().toUpperCase()) ? value.trim().toUpperCase() : null),
        shipType:record(design.aisShipType,value=>{
            const id=numeric(typeof value==='object' && value!==null ? value.id ?? value.code : value);
            const name=typeof value==='object' && value!==null ? text(value.name) : null;
            return id!==null || name ? {id,name} : null;
        }),
        length:record(design.length,value=>positive(unwrap(value?.overall ?? value))),
        beam:record(design.beam,positive),
        draft:record(design.draft,value=>{
            if (numeric(value)!==null) return nonnegative(value)!==null ? {metres:value,basis:'reported'} : null;
            for(const basis of ['current','maximum']) {
                const metres=nonnegative(unwrap(value?.[basis]));
                if(metres!==null) return {metres,basis};
            }
            return null;
        }),
        fromBow:record(ais.fromBow,nonnegative),
        fromCenter:record(ais.fromCenter,numeric),
        callsign:callsignRecord,
        destination:record(destination.commonName ?? destination,text),
        eta:record(destination.eta,text),
    };
}
module.exports={extractReportedAis};
