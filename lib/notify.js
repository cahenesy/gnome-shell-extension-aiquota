import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {formatAbsolute, formatDuration, formatPercent} from './format.js';

/**
 * Threshold notifications.
 *
 * Fires at most once per (quota, threshold, window). The window is identified by
 * its reset time, so a new window re-arms both thresholds automatically and a
 * quota that hovers around 75% does not nag on every poll.
 *
 * State is handed in and out rather than owned here, so it can be persisted
 * across shell restarts — otherwise every login would re-announce a limit you
 * already know about.
 */

const SOURCE_TITLE = 'AI Quota';
const ICON_NAME = 'utilities-system-monitor-symbolic';

export class Notifier {
    constructor(state = {}) {
        // { [quotaId]: {window: <iso|null>, fired: ['warn','critical']} }
        this._state = state && typeof state === 'object' ? {...state} : {};
        this._source = null;
    }

    get state() {
        return this._state;
    }

    /** Restored from the on-disk cache so a shell restart does not re-announce. */
    set state(value) {
        this._state = value && typeof value === 'object' ? {...value} : {};
    }

    _ensureSource() {
        if (this._source)
            return this._source;

        this._source = new MessageTray.Source({
            title: SOURCE_TITLE,
            iconName: ICON_NAME,
        });
        // If the source goes away (user dismissed everything), build a new one
        // next time rather than pushing into a destroyed object.
        this._source.connect('destroy', () => {
            this._source = null;
        });
        Main.messageTray.add(this._source);
        return this._source;
    }

    /**
     * @param {object[]} quotas normalised quota records
     * @param {object} options {providerLabels, warn, critical, enabled}
     */
    evaluate(quotas, {providerLabels = {}, warn = 75, critical = 90, enabled = true} = {}) {
        const liveIds = new Set();

        for (const quota of quotas) {
            liveIds.add(quota.id);

            const windowKey = quota.resetsAt ? quota.resetsAt.toISOString() : 'none';
            let entry = this._state[quota.id];

            // A new window means a fresh budget: re-arm.
            if (!entry || entry.window !== windowKey) {
                entry = {window: windowKey, fired: []};
                this._state[quota.id] = entry;
            }

            if (quota.percent === null || quota.percent === undefined)
                continue;

            // Dropping back below a threshold within the same window (extra
            // credit purchased, limits adjusted) re-arms it too.
            entry.fired = entry.fired.filter(level =>
                (level === 'critical' && quota.percent >= critical) ||
                (level === 'warn' && quota.percent >= warn));

            const level =
                quota.percent >= critical ? 'critical'
                    : quota.percent >= warn ? 'warn'
                        : null;

            if (!level || entry.fired.includes(level))
                continue;

            entry.fired.push(level);
            if (level === 'critical' && !entry.fired.includes('warn'))
                entry.fired.push('warn'); // Jumped straight past the warning.

            if (enabled)
                this._notify(quota, level, providerLabels[quota.provider] ?? quota.provider);
        }

        // Forget quotas that no longer exist, so the state file cannot grow
        // without bound as upstreams rename their windows.
        for (const id of Object.keys(this._state)) {
            if (!liveIds.has(id))
                delete this._state[id];
        }
    }

    _notify(quota, level, providerLabel) {
        const source = this._ensureSource();

        const title = level === 'critical'
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

        const notification = new MessageTray.Notification({
            source,
            title,
            body: parts.join(' '),
            urgency: level === 'critical'
                ? MessageTray.Urgency.HIGH
                : MessageTray.Urgency.NORMAL,
            isTransient: false,
        });

        source.addNotification(notification);
    }

    destroy() {
        // Leave delivered notifications alone — they belong to the user now.
        this._source = null;
    }
}
