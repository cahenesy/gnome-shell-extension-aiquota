#!/usr/bin/env -S gjs -m

import Cairo from 'cairo';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {GAUGE_HEIGHT, paintGauge} from '../lib/gaugepaint.js';
import {createSession} from '../lib/http.js';
import {formatPercent, severityFor} from '../lib/format.js';
import {PROVIDERS} from '../providers/index.js';

/**
 * Render a preview PNG: `gjs -m test/render.js [output.png] [--demo]`
 *
 * Draws the panel row plus a matrix of every visual state. It exists to answer
 * a question no assertion can: does this actually read as a gauge?
 *
 * By default it uses your real live readings, which is the useful thing while
 * developing. `--demo` substitutes illustrative numbers instead — use that for
 * anything committed or published, so a screenshot does not disclose how much
 * of your own quota you have spent.
 */

const DEMO = ARGV.includes('--demo');
const OUT = ARGV.find(a => !a.startsWith('--')) ??
    GLib.build_filenamev([GLib.get_tmp_dir(), 'aiquota-preview.png']);

const SCALE = 4;                    // render at 4x so the shapes are legible
const GAUGE_W = 13;
const PANEL_H = 34;
const COLORS = {normal: '#33d17a', warn: '#f6b73c', critical: '#e01b24'};
const PANEL_BG = {r: 0.13, g: 0.13, b: 0.14};
const FG = {r: 1, g: 1, b: 1, a: 1};
const PAPER_BG = {r: 0.10, g: 0.10, b: 0.11};

const loop = new GLib.MainLoop(null, false);

function colorFor(percent, severity) {
    const level = (severity && severity !== 'normal')
        ? severity
        : severityFor(percent, 75, 90);
    return COLORS[level] ?? COLORS.normal;
}

function font(cr, {size = 11, bold = false} = {}) {
    cr.selectFontFace('Cantarell',
        Cairo.FontSlant.NORMAL,
        bold ? Cairo.FontWeight.BOLD : Cairo.FontWeight.NORMAL);
    cr.setFontSize(size * SCALE);
}

function measure(cr, str, opts) {
    font(cr, opts);
    return cr.textExtents(str).xAdvance;
}

function text(cr, str, x, y, {alpha = 0.85, ...opts} = {}) {
    font(cr, opts);
    cr.setSourceRGBA(1, 1, 1, alpha);
    cr.moveTo(x, y);
    cr.showText(str);
}

/** Width one panel item occupies, including its glyph and tag. */
function itemWidth(cr, item) {
    let w = GAUGE_W * SCALE;
    if (item.glyph)
        w += 2 * SCALE + measure(cr, item.glyph, {size: 9, bold: true});
    if (item.tag)
        w += 2 * SCALE + measure(cr, item.tag, {size: 8});
    return w;
}

/** Draw one gauge plus its provider letter, returning the width consumed. */
function drawItem(cr, x, centerY, item) {
    const w = GAUGE_W * SCALE;
    const h = GAUGE_HEIGHT * SCALE;
    const y = Math.round(centerY - h / 2);
    const baseline = centerY + 4.5 * SCALE;

    cr.save();
    cr.translate(x, y);
    paintGauge(cr, {
        width: w, height: h, scale: SCALE,
        percent: item.percent, state: item.state,
        fillColor: item.fillColor, outline: FG,
    });
    cr.restore();

    let used = w;
    if (item.glyph) {
        used += 2 * SCALE;
        text(cr, item.glyph, x + used, baseline, {size: 9, bold: true, alpha: 0.7});
        used += measure(cr, item.glyph, {size: 9, bold: true});
    }
    if (item.tag) {
        used += 2 * SCALE;
        text(cr, item.tag, x + used, baseline, {size: 8, alpha: 0.55});
        used += measure(cr, item.tag, {size: 8});
    }
    return used;
}

/** Illustrative readings, chosen to show all three colour bands at once. */
function demoItems() {
    return [
        {percent: 41, glyph: 'C', tag: '5h', caption: '41%', subcaption: 'Session'},
        {percent: 78, glyph: 'C', tag: 'wk', caption: '78%', subcaption: 'Weekly'},
        {percent: 93, glyph: 'G', tag: 'bld', caption: '93%', subcaption: 'Build'},
        {percent: 12, glyph: 'G', tag: 'cht', caption: '12%', subcaption: 'Chat'},
    ].map(item => ({
        ...item,
        state: 'ok',
        fillColor: colorFor(item.percent),
    }));
}

async function liveItems() {
    if (DEMO)
        return demoItems();

    const session = createSession();
    const cancellable = new Gio.Cancellable();
    const items = [];

    for (const provider of PROVIDERS) {
        if (!provider.detect())
            continue;

        let result = null;
        try {
            result = await provider.fetchQuota({session, cancellable});
        } catch (e) {
            printerr(`  ${provider.id}: ${e.message}`);
        }

        let state = 'ok';
        if (!result?.ok && provider.readFallback) {
            result = await provider.readFallback(cancellable).catch(() => null);
            state = 'stale';
        }
        if (!result?.ok) {
            items.push({
                percent: null, state: 'error', fillColor: COLORS.normal,
                glyph: provider.glyph, tag: null,
                caption: 'unavailable', subcaption: provider.label,
            });
            continue;
        }
        if (result.stale)
            state = 'stale';

        // The same visibility rules the panel applies by default.
        for (const quota of result.quotas) {
            if (quota.optional || quota.hidable)
                continue;
            items.push({
                percent: quota.percent,
                state,
                fillColor: colorFor(quota.percent, quota.severity),
                glyph: provider.glyph,
                tag: quota.short,
                caption: formatPercent(quota.percent),
                subcaption: quota.label,
            });
        }
    }

    session.abort();
    return items;
}

const MATRIX = [
    {
        title: 'Fill levels',
        row: [0, 12, 38, 64, 78, 93, 100].map(p => ({
            percent: p, state: 'ok', fillColor: colorFor(p), caption: `${p}%`,
        })),
    },
    {
        title: 'Other states — none of these may read as a genuine 0%',
        row: [
            {percent: 0, state: 'ok', fillColor: COLORS.normal, caption: 'real 0%'},
            {percent: null, state: 'unknown', fillColor: COLORS.normal, caption: 'no reading'},
            {percent: 47, state: 'stale', fillColor: COLORS.normal, caption: 'stale 47%'},
            {percent: 93, state: 'stale', fillColor: COLORS.critical, caption: 'stale 93%'},
            {percent: null, state: 'error', fillColor: COLORS.normal, caption: 'error'},
        ],
    },
];

(async () => {
    try {
        print(DEMO ? 'Rendering demo readings…' : 'Fetching live readings…');
        const live = await liveItems();
        print(`  ${live.length} gauges`);

        const width = 820 * SCALE;
        const height = (PANEL_H + 130 + MATRIX.length * 88) * SCALE;

        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
        const cr = new Cairo.Context(surface);

        cr.setSourceRGB(PAPER_BG.r, PAPER_BG.g, PAPER_BG.b);
        cr.paint();

        // --- simulated top panel, right-aligned like the real thing --------
        cr.setSourceRGB(PANEL_BG.r, PANEL_BG.g, PANEL_BG.b);
        cr.rectangle(0, 0, width, PANEL_H * SCALE);
        cr.fill();

        const panelCenter = (PANEL_H / 2) * SCALE;
        text(cr, 'Activities', 16 * SCALE, panelCenter + 4 * SCALE, {size: 11, alpha: 0.75});
        const clock = '12:34';
        text(cr, clock, width / 2 - measure(cr, clock, {size: 11}) / 2,
            panelCenter + 4 * SCALE, {size: 11, alpha: 0.75});

        const gap = 6 * SCALE;
        const widths = live.map(item => itemWidth(cr, item));
        const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, live.length - 1);
        let px = width - 20 * SCALE - total;
        for (const [i, item] of live.entries()) {
            drawItem(cr, px, panelCenter, item);
            px += widths[i] + gap;
        }

        // --- live readings, spelled out ------------------------------------
        let y = (PANEL_H + 34) * SCALE;
        text(cr, DEMO
            ? 'Panel gauges, with the default visibility rules'
            : 'Live readings from your accounts, with the panel’s default visibility rules',
        16 * SCALE, y, {size: 9.5, bold: true, alpha: 0.92});
        y += 34 * SCALE;

        let lx = 18 * SCALE;
        for (const item of live) {
            drawItem(cr, lx, y, item);
            text(cr, item.caption, lx, y + 22 * SCALE, {size: 8.5, bold: true, alpha: 0.8});
            text(cr, item.subcaption, lx, y + 33 * SCALE, {size: 7.5, alpha: 0.5});
            lx += Math.max(
                92 * SCALE,
                measure(cr, item.subcaption, {size: 7.5}) + 16 * SCALE);
        }

        // --- state matrix ---------------------------------------------------
        y += 66 * SCALE;
        for (const group of MATRIX) {
            text(cr, group.title, 16 * SCALE, y, {size: 9.5, bold: true, alpha: 0.92});
            y += 30 * SCALE;
            let mx = 18 * SCALE;
            for (const item of group.row) {
                drawItem(cr, mx, y, {...item, glyph: null, tag: null});
                text(cr, item.caption, mx, y + 24 * SCALE, {size: 8, alpha: 0.6});
                mx += Math.max(72 * SCALE, measure(cr, item.caption, {size: 8}) + 20 * SCALE);
            }
            y += 58 * SCALE;
        }

        surface.flush();
        surface.writeToPNG(OUT);
        print(`Wrote ${OUT}`);
    } catch (e) {
        printerr(`render failed: ${e.message}\n${e.stack ?? ''}`);
    } finally {
        loop.quit();
    }
})();

loop.run();
