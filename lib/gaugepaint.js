import {parseHexColor} from './format.js';

/**
 * The gauge drawing itself, deliberately free of St and Clutter.
 *
 * Keeping the paint pure means it can be rendered to a PNG headlessly
 * (`gjs -m test/render.js`) and looked at, rather than only ever being visible
 * inside a running shell where nothing can assert on it.
 */

export const GAUGE_HEIGHT = 16;   // logical px; matches the panel icon size
const CORNER_RADIUS = 2.5;
const OUTLINE_WIDTH = 1;
const STALE_FILL_ALPHA = 0.4;
const OUTLINE_ALPHA = 0.75;

/** Trace a rounded rectangle; Cairo has no primitive for it. */
export function roundedRect(cr, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/**
 * @param {Cairo.Context} cr
 * @param {object} spec
 * @param {number} spec.width   surface width in device px
 * @param {number} spec.height  surface height in device px
 * @param {number} spec.scale   HiDPI scale factor
 * @param {?number} spec.percent 0..100, or null when there is no reading
 * @param {string} spec.state   'ok' | 'stale' | 'unknown' | 'error'
 * @param {string} spec.fillColor '#rrggbb'
 * @param {object} spec.outline {r,g,b,a} in 0..1
 */
export function paintGauge(cr, {width, height, scale, percent, state, fillColor, outline}) {
    if (width <= 0 || height <= 0)
        return;

    const stroke = OUTLINE_WIDTH * scale;
    // Inset by half the stroke so the outline lands on whole pixels.
    const x = stroke / 2;
    const y = stroke / 2;
    const w = width - stroke;
    const h = height - stroke;
    const radius = CORNER_RADIUS * scale;

    const hasReading = percent !== null && percent !== undefined;
    const dashed = state !== 'ok';

    // --- fill --------------------------------------------------------------
    if (hasReading && percent > 0) {
        const rgb = parseHexColor(fillColor) ?? {r: 1, g: 1, b: 1};
        const alpha = state === 'ok' ? 1 : STALE_FILL_ALPHA;

        // Clip to the capsule, then paint a plain rectangle up from the bottom —
        // far simpler than intersecting two rounded shapes.
        cr.save();
        roundedRect(cr, x, y, w, h, radius);
        cr.clip();

        const fillHeight = Math.max(1, (h * percent) / 100);
        cr.rectangle(x, y + h - fillHeight, w, fillHeight);
        cr.setSourceRGBA(rgb.r, rgb.g, rgb.b, alpha);
        cr.fill();
        cr.restore();
    }

    // --- outline -----------------------------------------------------------
    cr.setLineWidth(stroke);
    cr.setSourceRGBA(outline.r, outline.g, outline.b, outline.a * OUTLINE_ALPHA);
    if (dashed)
        cr.setDash([2 * scale, 2 * scale], 0);
    roundedRect(cr, x, y, w, h, radius);
    cr.stroke();
    cr.setDash([], 0);

    // --- error strike ------------------------------------------------------
    if (state === 'error') {
        cr.setLineWidth(stroke);
        cr.setSourceRGBA(outline.r, outline.g, outline.b, outline.a);
        cr.moveTo(x + w * 0.15, y + h * 0.8);
        cr.lineTo(x + w * 0.85, y + h * 0.2);
        cr.stroke();
    }
}
