'use strict';
// Shared source scoring/lock for received speeds. No smoothing or derived values.
class ReceivedSpeedNormalizer {
    constructor(path,defaults,config={}) {
        this.path=path;
        this.config={...defaults,...config};
        for(const [name,value] of Object.entries(this.config))if(!Number.isFinite(value)||value<=0)throw new TypeError(`Invalid sensor setting: ${name}`);
        for(const name of ['maxSources','maxSamplesPerSource','promotionMinimumFixes'])if(!Number.isInteger(this.config[name]))throw new TypeError(`Invalid sensor count: ${name}`);
        this.sources=new Map();this.selectedSource=null;this.lastObservationId=null;this.challenger=null;
    }
    ingest(measurement) {
        if(measurement?.path!==this.path || typeof measurement.source!=='string' || !measurement.source.trim() ||
            !Number.isFinite(measurement.receivedAt)) return false;
        const time=typeof measurement.timestamp==='number'?measurement.timestamp:typeof measurement.timestamp==='string'?Date.parse(measurement.timestamp):NaN;
        const now=measurement.receivedAt;
        if(!Number.isFinite(time)||time>now||now-time>=this.config.maxAgeMs)return false;
        for(const [id,state] of this.sources)if(now-state.receivedAt>this.config.sourceRetentionMs)this.sources.delete(id);
        const source=measurement.source.trim(),previous=this.sources.get(source);
        if(previous&&(time<previous.timestamp||(time===previous.timestamp&&!(measurement.value===null&&previous.valid))))return false;
        if(!previous&&this.sources.size>=this.config.maxSources){
            const oldest=[...this.sources.values()].filter(state=>state.source!==this.selectedSource).sort((a,b)=>a.receivedAt-b.receivedAt)[0];
            if(!oldest)return false;this.sources.delete(oldest.source);
        }
        const valid=typeof measurement.value==='number'&&Number.isFinite(measurement.value)&&measurement.value>=0&&measurement.value<=this.config.maximumSpeedMps;
        const timestamps=previous?.timestamps || [];
        if(valid&&time> (previous?.timestamp ?? -Infinity))timestamps.push(time);
        const recent=timestamps.filter(t=>t>=now-this.config.historyWindowMs&&!(time===t&&!valid)).slice(-this.config.maxSamplesPerSource);
        this.sources.set(source,{timestamps:recent,source,value:valid?measurement.value:null,valid,timestamp:time,receivedAt:now});
        return valid;
    }
    assess(state,now) {
        const ageMs=now-state.timestamp;
        const eligible=Boolean(state.valid&&ageMs>=0&&ageMs<this.config.maxAgeMs);
        const timestamps=state.timestamps.filter(t=>t>=now-this.config.historyWindowMs&&t<=now);
        const intervals=timestamps.slice(1).map((time,i)=>time-timestamps[i]).sort((a,b)=>a-b);
        const middle=Math.floor(intervals.length/2);
        const period=intervals.length ? intervals.length%2?intervals[middle]:(intervals[middle-1]+intervals[middle])/2 : null;
        const frequency=period===null?null:Math.min(1,this.config.referencePeriodMs/period);
        const freshness=Math.max(0,Math.min(1,1-ageMs/this.config.maxAgeMs));
        return {source:state.source,eligible,score:eligible?100*(freshness*this.config.freshnessWeight+(frequency??0)*this.config.frequencyWeight)/
                (this.config.freshnessWeight+(frequency===null?0:this.config.frequencyWeight)):null,
            ageMs,typicalIntervalMs:period,frequency,freshness,samples:timestamps.length};
    }
    getSourceDiagnostics(now=Date.now()) {
        return [...this.sources.values()].map(state=>({...this.assess(state,now),selected:state.source===this.selectedSource}));
    }
    tick(now=Date.now()) {
        if(!Number.isFinite(now))throw new TypeError('A finite sensor snapshot time is required');
        for(const [id,state] of this.sources)if(now-state.receivedAt>this.config.sourceRetentionMs)this.sources.delete(id);
        const assessments=new Map([...this.sources.values()].map(state=>[state.source,this.assess(state,now)]));
        const candidates=[...this.sources.values()].filter(state=>assessments.get(state.source).eligible)
            .sort((a,b)=>assessments.get(b.source).score-assessments.get(a.source).score||b.timestamp-a.timestamp||a.source.localeCompare(b.source));
        const best=candidates[0],current=this.sources.get(this.selectedSource);
        const currentUsable=current&&assessments.get(current.source).eligible;
        let chosen=currentUsable?current:best;
        let selectionReason=!currentUsable?(best?(this.selectedSource===null?'INITIAL':'FAILOVER'):'NO_VALID_SOURCE'):'LOCKED';
        if(!currentUsable)this.challenger=null;
        else if(!best||best.source===current.source||assessments.get(best.source).score-assessments.get(current.source).score<this.config.promotionScoreMargin)this.challenger=null;
        else {
            if(this.challenger?.source!==best.source)this.challenger={source:best.source,since:now,firstTimestamp:best.timestamp,lastTimestamp:best.timestamp,fixes:1};
            else if(best.timestamp>this.challenger.lastTimestamp){this.challenger.fixes++;this.challenger.lastTimestamp=best.timestamp;}
            const c=this.challenger;
            if(now-c.since>=this.config.promotionHoldMs&&best.timestamp-c.firstTimestamp>=this.config.promotionHoldMs&&c.fixes>=this.config.promotionMinimumFixes){chosen=best;selectionReason='PREFERRED_SOURCE';this.challenger=null;}
        }
        const previous=this.selectedSource;
        if(chosen)this.selectedSource=chosen.source;
        const state=chosen||this.sources.get(this.selectedSource),valid=Boolean(chosen);
        const observationId=valid?JSON.stringify([state.source,state.timestamp]):null;
        const measurement={value:valid?state.value:null,valid,status:valid?'VALID':state?state.valid?'STALE':'INVALID':'UNAVAILABLE',
            source:state?.source??null,sourceScore:valid?assessments.get(state.source).score:null,selectionReason,timestamp:state?.timestamp??null,receivedAt:state?.receivedAt??null,
            ageMs:state?now-state.timestamp:null,validityMs:this.config.maxAgeMs,
            expiresAt:state?state.timestamp+this.config.maxAgeMs:null,observationId,
            isNewObservation:observationId!==null&&observationId!==this.lastObservationId,
            sourceChanged:previous!==null&&previous!==this.selectedSource};
        if(observationId!==null)this.lastObservationId=observationId;
        return measurement;
    }
}
module.exports={ReceivedSpeedNormalizer};
