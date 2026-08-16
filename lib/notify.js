import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {evaluateThresholds, notificationCopy} from './notify-policy.js';

/**
 * Threshold notifications.
 *
 * Rising edge only: each threshold fires once, then stays quiet until usage
 * falls back below it. State is handed in and out rather than owned here, so
 * it can be persisted across shell restarts — otherwise every login would
 * re-announce a limit you already know about.
 */

const SOURCE_TITLE = 'AI Quota';
const ICON_NAME = 'utilities-system-monitor-symbolic';

export class Notifier {
    constructor(state = {}) {
        // { [quotaId]: {fired: ['warn','critical']} }
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
        const {state, events} = evaluateThresholds(this._state, quotas, {warn, critical});
        this._state = state;

        if (!enabled)
            return;

        for (const {quota, level} of events)
            this._notify(quota, level, providerLabels[quota.provider] ?? quota.provider);
    }

    _notify(quota, level, providerLabel) {
        const source = this._ensureSource();
        const {title, body} = notificationCopy(quota, level, providerLabel);

        const notification = new MessageTray.Notification({
            source,
            title,
            body,
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
