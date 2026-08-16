import {formatAbsolute, formatDuration, formatPercent} from './format.js';

/**
 * Threshold notification decisions, kept free of GNOME Shell imports so the
 * tests can drive them headlessly.
 *
 * Rising edge only: a threshold fires once, then stays quiet until usage
 * actually falls back below it. A new window that starts at 0% re-arms
 * because the reading drops; a jittering reset timestamp (Claude's
 * resets_at moves by hundreds of milliseconds between polls of the same
 * window) does not.
 */

/**
 * @param {object} state { [quotaId]: {fired: string[]} }
 * @param {object[]} quotas normalised quota records
 * @param {object} options {warn, critical}
 * @returns {{state: object, events: {quota: object, level: string}[]}}
 */
export function evaluateThresholds(state, quotas, {warn = 75, critical = 90} = {}) {
    const incoming = state && typeof state === 'object' ? state : {};
    const next = {};
    const events = [];

    for (const quota of quotas ?? []) {
        const previous = incoming[quota.id];
        const priorFired = Array.isArray(previous?.fired) ? previous.fired : [];

        if (quota.percent === null || quota.percent === undefined) {
            next[quota.id] = {fired: [...priorFired]};
            continue;
        }

        const fired = priorFired.filter(level =>
            (level === 'critical' && quota.percent >= critical) ||
            (level === 'warn' && quota.percent >= warn));

        const level =
            quota.percent >= critical ? 'critical'
                : quota.percent >= warn ? 'warn'
                    : null;

        if (level && !fired.includes(level)) {
            fired.push(level);
            if (level === 'critical' && !fired.includes('warn'))
                fired.push('warn');
            events.push({quota, level});
        }

        next[quota.id] = {fired};
    }

    return {state: next, events};
}

/**
 * @param {object} quota
 * @param {'warn'|'critical'} level
 * @param {string} providerLabel
 * @returns {{title: string, body: string}}
 */
export function notificationCopy(quota, level, providerLabel) {
    // Match the displayed percentage: 99.6 shows as 100%, and 100% is
    // exhausted, not "nearly" there.
    const shown = typeof quota.percent === 'number' && Number.isFinite(quota.percent)
        ? Math.round(quota.percent)
        : null;
    const exhausted = shown !== null && shown >= 100;

    const title = exhausted
        ? `${providerLabel}: ${quota.label} exhausted`
        : level === 'critical'
            ? `${providerLabel}: ${quota.label} nearly exhausted`
            : `${providerLabel}: ${quota.label} running low`;

    const parts = [`${formatPercent(quota.percent)} used.`];
    if (quota.resetsAt) {
        const until = formatDuration(quota.resetsAt);
        const at = formatAbsolute(quota.resetsAt);
        parts.push(`Resets in ${until} — ${at}.`);
    } else {
        parts.push('No reset scheduled.');
    }

    return {title, body: parts.join(' ')};
}
