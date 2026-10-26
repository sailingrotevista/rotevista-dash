'use strict';

// Increment only when a deliberate, one-time configuration migration is needed.
const THRESHOLD_POLICY_VERSION = 1;
const PLUGIN_BASE_TCPA_MINUTES = 10;
const { COLLISION_THRESHOLD_DEFAULTS } = require('./collisionPipeline');

function prepareCollisionConfig(options = {}) {
    const previous = options.aisAlerter || {};
    const ais = {
        enabled: true,
        ignoreOwnTarget: '106125',
        vectorMinutes: 15,
        criticalProximity: 45,
        baseTcpaMinutes: PLUGIN_BASE_TCPA_MINUTES,
        ...previous,
    };
    const migrated = !(previous.thresholdPolicyVersion >= THRESHOLD_POLICY_VERSION);
    for (const [group, prefix] of [['pleasureCraft', 'yacht'], ['commercialShips', 'commercial'], ['workboats', 'work']]) {
        ais[group] = { redCpa: COLLISION_THRESHOLD_DEFAULTS[`${prefix}RedCpaMeters`], ...previous[group] };
        if (migrated) {
            ais[group].redCpa = COLLISION_THRESHOLD_DEFAULTS[`${prefix}RedCpaMeters`];
            delete ais[group].orangeCpa;
            delete ais[group].maxTcpa;
        }
    }
    if (migrated) {
        ais.baseTcpaMinutes = PLUGIN_BASE_TCPA_MINUTES;
        ais.thresholdPolicyVersion = THRESHOLD_POLICY_VERSION;
    }
    return { config: { ...options, aisAlerter: ais }, migrated };
}

module.exports = { prepareCollisionConfig, THRESHOLD_POLICY_VERSION, PLUGIN_BASE_TCPA_MINUTES };
