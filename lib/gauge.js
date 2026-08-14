import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {GAUGE_HEIGHT, paintGauge} from './gaugepaint.js';

/**
 * The fill gauge: a rounded outline that fills from the bottom as quota is
 * consumed.
 *
 * Three states have to stay visually distinct, because conflating them is how a
 * monitor lies to you:
 *
 *   filled      we have a reading, and this is it
 *   empty       we have a reading, and it is genuinely zero  (solid outline, no fill)
 *   unknown     we have no reading                           (dashed outline, no fill)
 *   stale       we have an old reading                       (dashed outline, faded fill)
 *   error       the last fetch failed outright               (dashed outline, strike)
 *
 * "Empty" and "no idea" must never look the same.
 *
 * The drawing lives in gaugepaint.js so it can be rendered and inspected
 * outside a running shell.
 */

/**
 * Read a colour off the theme node.
 *
 * Clutter.Color (0–255 ints) became Cogl.Color (0–1 floats) during the GNOME 48
 * cycle, and both shapes are still in the wild. Normalise rather than guess.
 */
function themeColorToRgba(color) {
    if (!color)
        return {r: 1, g: 1, b: 1, a: 1};
    const scale = v => (v > 1 ? v / 255 : v);
    return {
        r: scale(color.red ?? 0),
        g: scale(color.green ?? 0),
        b: scale(color.blue ?? 0),
        a: scale(color.alpha ?? 255),
    };
}

export const Gauge = GObject.registerClass(
class Gauge extends St.DrawingArea {
    _init(params = {}) {
        super._init({
            style_class: 'aiquota-gauge',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: false,
            ...params,
        });

        this._percent = null;
        this._state = 'unknown';
        this._fillColor = '#33d17a';
        this._logicalWidth = 13;

        this.connect('repaint', () => this._repaint());
    }

    /**
     * @param {?number} percent 0..100, or null when there is no reading
     * @param {string} state 'ok' | 'stale' | 'unknown' | 'error'
     * @param {string} fillColor '#rrggbb'
     */
    setReading(percent, state, fillColor) {
        const changed =
            this._percent !== percent ||
            this._state !== state ||
            this._fillColor !== fillColor;
        this._percent = percent;
        this._state = state;
        this._fillColor = fillColor;
        if (changed)
            this.queue_repaint();
    }

    setLogicalWidth(width) {
        if (this._logicalWidth === width)
            return;
        this._logicalWidth = width;
        this._applySize();
    }

    _applySize() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.set_width(Math.round(this._logicalWidth * scale));
        this.set_height(Math.round(GAUGE_HEIGHT * scale));
        this.queue_repaint();
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this._applySize();
    }

    _repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            paintGauge(cr, {
                width,
                height,
                scale: St.ThemeContext.get_for_stage(global.stage).scale_factor,
                percent: this._percent,
                state: this._state,
                fillColor: this._fillColor,
                outline: themeColorToRgba(this.get_theme_node().get_foreground_color()),
            });
        } catch (e) {
            console.warn(`aiquota: gauge repaint failed: ${e}`);
        } finally {
            cr.$dispose();
        }
    }
});

/**
 * One panel entry: the gauge, its provider letter, and optionally the window tag.
 *
 * Reactive in its own right so the tooltip can track which quota the pointer is
 * actually over — the containing PanelMenu.Button only knows "somewhere in the
 * button".
 */
export const GaugeItem = GObject.registerClass(
class GaugeItem extends St.BoxLayout {
    _init(quotaId) {
        super._init({
            style_class: 'aiquota-item',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            track_hover: true,
        });

        this.quotaId = quotaId;
        this.quota = null;

        this._gauge = new Gauge();
        this.add_child(this._gauge);

        this._glyph = new St.Label({
            style_class: 'aiquota-glyph',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._glyph);

        this._tag = new St.Label({
            style_class: 'aiquota-tag',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._tag.visible = false;
        this.add_child(this._tag);
    }

    /**
     * @param {object} quota  normalised quota record
     * @param {object} style  {glyph, state, fillColor, showTag, gaugeWidth}
     */
    update(quota, style) {
        this.quota = quota;
        this._gauge.setLogicalWidth(style.gaugeWidth);
        this._gauge.setReading(quota.percent, style.state, style.fillColor);

        this._glyph.text = style.glyph ?? '';
        this._glyph.visible = Boolean(style.glyph);

        const tag = quota.short ?? null;
        this._tag.text = tag ?? '';
        this._tag.visible = Boolean(style.showTag && tag);
    }
});
