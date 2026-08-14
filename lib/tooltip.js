import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * A hover tooltip for panel gauges.
 *
 * Panel buttons have no native tooltip, and the built-in menu is the wrong
 * affordance for a glance — opening a menu to read a number defeats the point
 * of a top-bar gauge. So: a small floating label, parented to uiGroup so it can
 * escape the panel's clip, shown after a short delay and hidden on leave.
 */

const SHOW_DELAY_MS = 350;
const HIDE_DELAY_MS = 120;
const EDGE_MARGIN = 8;
const FADE_MS = 120;

export class Tooltip {
    constructor() {
        this._box = new St.BoxLayout({
            style_class: 'aiquota-tooltip',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
            reactive: false,
            opacity: 0,
        });

        this._title = new St.Label({style_class: 'aiquota-tooltip-title'});
        this._box.add_child(this._title);

        this._body = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'aiquota-tooltip-body',
        });
        this._box.add_child(this._body);

        Main.layoutManager.uiGroup.add_child(this._box);

        this._showTimeout = 0;
        this._hideTimeout = 0;
        this._source = null;
    }

    /**
     * Queue the tooltip for `actor`.
     *
     * @param {Clutter.Actor} actor the hovered gauge
     * @param {string} title bold first line
     * @param {string[]} lines subsequent lines
     */
    scheduleFor(actor, title, lines) {
        this._clearHide();
        this._source = actor;
        this._pending = {title, lines};

        if (this._box.visible) {
            // Already open on a sibling gauge: swap content immediately rather
            // than making the user wait out the delay again.
            this._render();
            return;
        }

        this._clearShow();
        this._showTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOW_DELAY_MS, () => {
            this._showTimeout = 0;
            this._render();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Update in place if the tooltip is currently showing for `actor`. */
    refreshFor(actor, title, lines) {
        if (this._source !== actor || !this._box.visible)
            return;
        this._pending = {title, lines};
        this._render();
    }

    scheduleHide() {
        this._clearShow();
        if (this._hideTimeout)
            return;
        this._hideTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY_MS, () => {
            this._hideTimeout = 0;
            this.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    hide() {
        this._clearShow();
        this._clearHide();
        this._source = null;
        if (!this._box.visible)
            return;
        this._box.ease({
            opacity: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._box.hide(),
        });
    }

    _render() {
        if (!this._source || !this._pending)
            return;

        this._title.text = this._pending.title;

        this._body.destroy_all_children();
        for (const line of this._pending.lines) {
            this._body.add_child(new St.Label({
                style_class: 'aiquota-tooltip-line',
                text: line,
            }));
        }

        this._box.show();
        this._position();
        this._box.ease({
            opacity: 255,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _position() {
        const source = this._source;
        if (!source || !source.get_stage())
            return;

        const [sourceX, sourceY] = source.get_transformed_position();
        const sourceWidth = source.get_transformed_size()[0];
        const [, natWidth] = this._box.get_preferred_width(-1);
        const [, natHeight] = this._box.get_preferred_height(natWidth);

        const monitor = Main.layoutManager.findMonitorForActor(source) ??
            Main.layoutManager.primaryMonitor;

        // Centre under the gauge, then keep it on the monitor.
        let x = Math.round(sourceX + sourceWidth / 2 - natWidth / 2);
        x = Math.max(
            monitor.x + EDGE_MARGIN,
            Math.min(x, monitor.x + monitor.width - natWidth - EDGE_MARGIN)
        );

        let y = Math.round(sourceY + source.get_transformed_size()[1] + EDGE_MARGIN);
        // If it would fall off the bottom (bottom panel, tiny screen), flip above.
        if (y + natHeight > monitor.y + monitor.height - EDGE_MARGIN)
            y = Math.round(sourceY - natHeight - EDGE_MARGIN);

        this._box.set_position(x, y);
    }

    _clearShow() {
        if (this._showTimeout) {
            GLib.source_remove(this._showTimeout);
            this._showTimeout = 0;
        }
    }

    _clearHide() {
        if (this._hideTimeout) {
            GLib.source_remove(this._hideTimeout);
            this._hideTimeout = 0;
        }
    }

    destroy() {
        this._clearShow();
        this._clearHide();
        this._source = null;
        this._pending = null;
        this._box?.destroy();
        this._box = null;
    }
}
