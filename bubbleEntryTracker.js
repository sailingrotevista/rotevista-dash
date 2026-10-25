'use strict';

const BUBBLE_ENTRY_CONFIG = { exitMarginMeters: 10 };

// Observe geometry before harbor classification: learning a port must not
// turn an already present neighbour into a new bubble entry.
class BubbleEntryTracker {
    constructor(config = {}) {
        this.config = { ...BUBBLE_ENTRY_CONFIG, ...config };
        this.targets = new Map();
    }

    update(target, ownPosition, bubbleMeters = 45) {
        const bubble = Number.isFinite(bubbleMeters) && bubbleMeters > 0 ? bubbleMeters : 45;
        const distance = target.currentHullClearanceMeters;
        if (!Number.isFinite(distance) || target.isProjected || target.contactLost) return this.targets.get(target.id)?.entered === true;
        const signature = [target.lat, target.lon, ownPosition.lat, ownPosition.lon].join(':');
        let state = this.targets.get(target.id);
        if (!state || state.bubble !== bubble) {
            state = { bubble, signature, outside: distance > bubble + this.config.exitMarginMeters, entered: false };
            this.targets.set(target.id, state);
            return false;
        }
        // Static metadata/hull changes alone cannot establish an entry.
        if (state.signature === signature) return state.entered;
        state.signature = signature;
        if (distance > bubble + this.config.exitMarginMeters) {
            state.outside = true;
            state.entered = false;
        } else if (distance <= bubble && state.outside) {
            state.entered = true;
        }
        return state.entered;
    }

    prune(activeIds) {
        for (const id of this.targets.keys()) if (!activeIds.has(id)) this.targets.delete(id);
    }
}

module.exports = { BubbleEntryTracker, BUBBLE_ENTRY_CONFIG };
