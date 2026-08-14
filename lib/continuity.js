/**
 * Panel continuity across resets.
 *
 * Observed live: xAI's billing payload drops `productUsage` entries whose usage
 * is zero (proto3 omits zero values), so the moment a weekly window rolls over,
 * GrokChat simply disappears from the response. Rendered naively, its gauge
 * vanishes from the panel, every gauge to its left shifts, and it reappears
 * later — which looks like a bug and destroys the muscle memory of "the third
 * gauge is my chat quota".
 *
 * So: a quota that has been reported recently but is missing from the current
 * reading is carried forward at 0%. That is not an invention — absence in these
 * payloads means "nothing used". It is dropped once it has been absent for
 * longer than a full window, which is also what correctly retires a limit type
 * the vendor has genuinely removed.
 *
 * Ordering is taken from the previous reading so gauges keep their positions;
 * genuinely new quotas are appended.
 */

/** A quota unseen for longer than this is retired rather than carried. */
export const CARRY_FORWARD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {object[]} previous last reading's quotas (may carry `lastSeenAt`)
 * @param {object[]} incoming this reading's quotas
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.maxAgeMs]
 * @returns {object[]} merged quotas, ordered for layout stability
 */
export function mergeContinuity(previous, incoming, options = {}) {
    const now = options.now ?? new Date();
    const maxAgeMs = options.maxAgeMs ?? CARRY_FORWARD_MS;

    const incomingById = new Map();
    for (const quota of incoming ?? [])
        incomingById.set(quota.id, quota);

    const previousById = new Map();
    for (const quota of previous ?? [])
        previousById.set(quota.id, quota);

    // The window the live reading is reporting against, used to give a carried
    // quota an honest reset time rather than a stale one.
    const currentReset = (incoming ?? []).find(q => q.resetsAt)?.resetsAt ?? null;

    const merged = [];
    const emitted = new Set();

    const emitFresh = quota => {
        emitted.add(quota.id);
        merged.push({...quota, lastSeenAt: now, carried: false});
    };

    const emitCarried = quota => {
        const lastSeenAt = quota.lastSeenAt ?? null;
        if (!lastSeenAt || now.getTime() - lastSeenAt.getTime() > maxAgeMs)
            return; // Retired: gone long enough that it is probably gone for good.

        emitted.add(quota.id);
        merged.push({
            ...quota,
            percent: 0,
            // Absence is only meaningful against the current window.
            resetsAt: currentReset ?? quota.resetsAt ?? null,
            severity: 'normal',
            carried: true,
            lastSeenAt,
        });
    };

    // Previous order first, so nothing moves sideways under the pointer.
    for (const quota of previous ?? []) {
        if (emitted.has(quota.id))
            continue;
        const fresh = incomingById.get(quota.id);
        if (fresh)
            emitFresh(fresh);
        else
            emitCarried(quota);
    }

    // Then anything genuinely new.
    for (const quota of incoming ?? []) {
        if (!emitted.has(quota.id))
            emitFresh(quota);
    }

    return merged;
}
