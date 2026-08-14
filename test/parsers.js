#!/usr/bin/env -S gjs -m

import GLib from 'gi://GLib';

import * as claude from '../providers/claude.js';
import * as grok from '../providers/grok.js';
import * as codex from '../providers/codex.js';
import {
    clampPercent, formatAbsolute, formatDuration, formatPercent,
    parseHexColor, parseTimestamp, severityFor,
} from '../lib/format.js';
import {mergeContinuity} from '../lib/continuity.js';

/**
 * Headless parser tests: `gjs -m test/parsers.js`
 *
 * These cover the parsing and normalisation layer only — no shell, no network.
 * That is deliberate: the response shapes are undocumented and will drift, and
 * this is the layer where drift shows up first.
 */

const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        failures.push(`${name}\n    ${e.message}`);
    }
}

function eq(actual, expected, what = 'value') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${what}: expected ${b}, got ${a}`);
}

function ok(condition, what) {
    if (!condition)
        throw new Error(`expected ${what}`);
}

function fixture(name) {
    const path = GLib.build_filenamev([HERE, 'fixtures', name]);
    const [success, contents] = GLib.file_get_contents(path);
    if (!success)
        throw new Error(`could not read fixture ${name}`);
    return new TextDecoder().decode(contents);
}

function json(name) {
    return JSON.parse(fixture(name));
}

function byId(quotas, id) {
    const found = quotas.find(q => q.id === id);
    if (!found)
        throw new Error(`no quota with id ${id} (have: ${quotas.map(q => q.id).join(', ')})`);
    return found;
}

// ---------------------------------------------------------------- timestamps

check('parseTimestamp handles ISO 8601 with sub-millisecond precision', () => {
    const d = parseTimestamp('2026-08-14T18:50:00.487164+00:00');
    ok(d instanceof Date, 'a Date');
    eq(d.toISOString(), '2026-08-14T18:50:00.487Z');
});

check('parseTimestamp handles the 9-digit fractional seconds xAI emits', () => {
    const d = parseTimestamp('2026-08-14T18:44:31.913980721Z');
    eq(d.toISOString(), '2026-08-14T18:44:31.913Z');
});

check('parseTimestamp distinguishes epoch seconds from epoch milliseconds', () => {
    // The single most likely bug in this codebase: three upstreams, three units.
    const seconds = parseTimestamp(1786852800);           // statusline / headers
    const millis = parseTimestamp(1786744255443);         // .credentials.json
    eq(seconds.getUTCFullYear(), 2026, 'seconds treated as seconds');
    eq(millis.getUTCFullYear(), 2026, 'millis treated as millis');
    ok(Math.abs(seconds.getTime() - millis.getTime()) < 1000 * 60 * 60 * 24 * 60,
        'both land in the same era');
});

check('parseTimestamp rejects junk instead of producing Invalid Date', () => {
    for (const bad of [null, undefined, '', '  ', 'not a date', 0, -1, NaN, {}, []])
        eq(parseTimestamp(bad), null, `parseTimestamp(${JSON.stringify(bad)})`);
});

check('parseTimestamp accepts numeric strings', () => {
    eq(parseTimestamp('1786852800').toISOString(), parseTimestamp(1786852800).toISOString());
});

// ------------------------------------------------------------------ clamping

check('clampPercent bounds to 0..100 and rejects non-numbers', () => {
    eq(clampPercent(49), 49);
    eq(clampPercent('31.5'), 31.5);
    eq(clampPercent(-5), 0);
    eq(clampPercent(140), 100);
    eq(clampPercent(null), null);
    eq(clampPercent(undefined), null);
    eq(clampPercent('abc'), null);
    eq(clampPercent(Infinity), null);
});

// ----------------------------------------------------------------- formatting

check('formatDuration reads naturally at each scale', () => {
    const now = new Date('2026-08-14T14:00:00Z');
    const at = iso => new Date(iso);
    eq(formatDuration(at('2026-08-14T18:48:00Z'), now), '4h 48m');
    eq(formatDuration(at('2026-08-17T05:00:00Z'), now), '2d 15h');
    eq(formatDuration(at('2026-08-14T14:00:38Z'), now), '38s');
    eq(formatDuration(at('2026-08-14T14:03:00Z'), now), '3m');
    eq(formatDuration(at('2026-08-16T14:00:00Z'), now), '2d');
    eq(formatDuration(at('2026-08-14T17:00:00Z'), now), '3h');
});

check('formatDuration never counts down past zero', () => {
    const now = new Date('2026-08-14T14:00:00Z');
    eq(formatDuration(new Date('2026-08-14T13:00:00Z'), now), 'now');
    eq(formatDuration(null, now), null);
});

check('formatPercent distinguishes zero from almost-zero', () => {
    eq(formatPercent(0), '0%');
    eq(formatPercent(0.4), '<1%');
    eq(formatPercent(48.6), '49%');
    eq(formatPercent(null), '—');
});

check('formatAbsolute produces a readable local timestamp', () => {
    const text = formatAbsolute(new Date('2026-08-14T18:50:00Z'));
    ok(typeof text === 'string' && text.length > 0, 'a non-empty string');
    ok(/2026/.test(text), 'the year to be present');
});

check('severityFor bands on the configured thresholds', () => {
    eq(severityFor(10, 75, 90), 'normal');
    eq(severityFor(74.9, 75, 90), 'normal');
    eq(severityFor(75, 75, 90), 'warn');
    eq(severityFor(89.9, 75, 90), 'warn');
    eq(severityFor(90, 75, 90), 'critical');
    eq(severityFor(null, 75, 90), 'unknown');
});

check('parseHexColor handles both long and short forms', () => {
    eq(parseHexColor('#000000'), {r: 0, g: 0, b: 0});
    eq(parseHexColor('#fff'), {r: 1, g: 1, b: 1});
    eq(parseHexColor('33d17a').r.toFixed(3), (0x33 / 255).toFixed(3));
    eq(parseHexColor('nope'), null);
    eq(parseHexColor(null), null);
});

// -------------------------------------------------------------------- Claude

check('claude: limits[] is preferred over the named windows', () => {
    const {quotas} = claude.parseUsage(json('claude-usage.json'));
    // Three limits entries, no spend (disabled) — and crucially not also the
    // legacy five_hour/seven_day duplicates.
    eq(quotas.length, 3, 'quota count');
    eq(quotas.map(q => q.id),
        ['claude.session', 'claude.weekly_all', 'claude.weekly_scoped.fable']);
});

check('claude: session window maps percent, reset and active flag', () => {
    const {quotas} = claude.parseUsage(json('claude-usage.json'));
    const session = byId(quotas, 'claude.session');
    eq(session.label, 'Session');
    eq(session.short, '5h');
    eq(session.percent, 9);
    eq(session.active, true);
    eq(session.hidable, false);
    eq(session.resetsAt.toISOString(), '2026-08-14T18:50:00.487Z');
});

check('claude: a scoped weekly limit is named after its model', () => {
    const {quotas} = claude.parseUsage(json('claude-usage.json'));
    const scoped = byId(quotas, 'claude.weekly_scoped.fable');
    eq(scoped.label, 'Weekly · Fable');
    eq(scoped.resetsAt, null);
});

check('claude: an empty, inactive, never-resetting limit is marked hidable', () => {
    const {quotas} = claude.parseUsage(json('claude-usage.json'));
    eq(byId(quotas, 'claude.weekly_scoped.fable').hidable, true);
    // ...but a real window is never hidden, even at 0%.
    eq(byId(quotas, 'claude.weekly_all').hidable, false);
});

check('claude: disabled spend produces no quota', () => {
    const {quotas} = claude.parseUsage(json('claude-usage.json'));
    ok(!quotas.some(q => q.id === 'claude.spend'), 'no spend quota when disabled');
});

check('claude: falls back to the named windows when limits[] is absent', () => {
    const {quotas} = claude.parseUsage(json('claude-usage-legacy.json'));
    eq(quotas.map(q => q.id), [
        'claude.five_hour', 'claude.seven_day', 'claude.seven_day_opus', 'claude.spend',
    ]);
    eq(byId(quotas, 'claude.five_hour').percent, 82.5);
    eq(byId(quotas, 'claude.five_hour').active, true);
    eq(byId(quotas, 'claude.seven_day_opus').label, 'Weekly · Opus');
});

check('claude: null legacy windows are skipped, not rendered as 0%', () => {
    const {quotas} = claude.parseUsage(json('claude-usage-legacy.json'));
    ok(!quotas.some(q => q.id === 'claude.seven_day_sonnet'),
        'a null window to be omitted rather than shown as empty');
});

check('claude: enabled spend appears and carries API severity', () => {
    const {quotas} = claude.parseUsage(json('claude-usage-legacy.json'));
    const spend = byId(quotas, 'claude.spend');
    eq(spend.percent, 30);
    eq(spend.severity, 'warn', 'severity "warning" normalised to "warn"');
});

check('claude: plan metadata is threaded through', () => {
    const {meta} = claude.parseUsage(json('claude-usage.json'),
        {plan: 'max', tier: 'default_claude_max_5x'});
    eq(meta, {plan: 'max', tier: 'default_claude_max_5x'});
});

check('claude: an unknown limit kind is surfaced, not dropped', () => {
    const {quotas} = claude.parseUsage({
        limits: [{kind: 'monthly_cowork', percent: 12, resets_at: null, is_active: true}],
    });
    eq(quotas.length, 1);
    eq(quotas[0].label, 'Monthly cowork');
    eq(quotas[0].id, 'claude.monthly_cowork');
});

check('claude: an empty payload yields no quotas rather than throwing', () => {
    for (const empty of [{}, {limits: []}, null, undefined])
        eq(claude.parseUsage(empty).quotas.length, 0, `parseUsage(${JSON.stringify(empty)})`);
});

// ---------------------------------------------------------------------- Grok

check('grok: per-product gauges plus an optional pool', () => {
    const {quotas} = grok.parseBilling(json('grok-billing.json'));
    eq(quotas.map(q => q.id), ['grok.grokbuild', 'grok.grokchat', 'grok.pool']);
    eq(byId(quotas, 'grok.grokbuild').label, 'Build');
    eq(byId(quotas, 'grok.grokchat').label, 'Chat');
    eq(byId(quotas, 'grok.grokbuild').percent, 31);
    eq(byId(quotas, 'grok.grokchat').percent, 18);
    eq(byId(quotas, 'grok.pool').percent, 49);
});

check('grok: the pool is optional only because the products already sum to it', () => {
    const withProducts = grok.parseBilling(json('grok-billing.json'));
    eq(byId(withProducts.quotas, 'grok.pool').optional, true);

    const withoutProducts = grok.parseBilling(json('grok-billing-ondemand.json'));
    eq(byId(withoutProducts.quotas, 'grok.pool').optional, false,
        'the pool must not be optional when it is the only reading');
});

check('grok: every product shares the billing period reset', () => {
    const {quotas} = grok.parseBilling(json('grok-billing.json'));
    for (const q of quotas)
        eq(q.resetsAt.toISOString(), '2026-08-14T14:27:21.250Z', `${q.id} reset`);
});

check('grok: on-demand appears only once a cap is set', () => {
    const capped = grok.parseBilling(json('grok-billing-ondemand.json'));
    const onDemand = byId(capped.quotas, 'grok.on-demand');
    eq(onDemand.percent, 25, '1250 of 5000');

    const uncapped = grok.parseBilling(json('grok-billing.json'));
    ok(!uncapped.quotas.some(q => q.id === 'grok.on-demand'),
        'no on-demand quota when the cap is zero');
});

check('grok: the period type becomes readable metadata', () => {
    eq(grok.parseBilling(json('grok-billing.json')).meta.tier, 'weekly period');
    eq(grok.parseBilling(json('grok-billing-ondemand.json')).meta.tier, 'monthly period');
});

check('grok: accepts a bare config object as well as the API envelope', () => {
    const enveloped = grok.parseBilling(json('grok-billing.json'));
    const bare = grok.parseBilling(json('grok-billing.json').config);
    eq(bare.quotas.map(q => q.percent), enveloped.quotas.map(q => q.percent));
});

check('grok: log tail returns the most recent billing record', () => {
    const result = grok.parseLogTail(fixture('grok-log-tail.jsonl'));
    ok(result !== null, 'a result');
    eq(result.source, 'log');
    eq(result.stale, true);
    // 48.0 is the last billing line; 42.0 precedes it and must not win.
    eq(byId(result.quotas, 'grok.pool').percent, 48);
    eq(result.meta.plan, 'Example Plan');
    eq(result.fetchedAt.toISOString(), '2026-08-14T13:57:34.426Z');
});

check('grok: log tail ignores the truncated first line and non-billing lines', () => {
    // The fixture opens mid-JSON, exactly as a byte-offset tail does.
    const result = grok.parseLogTail(fixture('grok-log-tail.jsonl'));
    ok(result !== null, 'the truncated leading line not to break parsing');
    eq(grok.parseLogTail('not json at all\n'), null);
    eq(grok.parseLogTail(''), null);
    eq(grok.parseLogTail(null), null);
});

check('grok: camelCase product names are split for display', () => {
    const {quotas} = grok.parseBilling({
        config: {productUsage: [{product: 'GrokDeepSearch', usagePercent: 5}]},
    });
    eq(quotas[0].label, 'Deep Search');
    eq(quotas[0].id, 'grok.grokdeepsearch');
});

// --------------------------------------------------------------------- Codex

check('codex: primary and secondary windows map to session and weekly', () => {
    const now = Date.parse('2026-08-14T14:00:00Z');
    const {quotas} = codex.parseUsage(json('codex-usage.json'), now);
    const session = byId(quotas, 'codex.session');
    eq(session.percent, 64);
    eq(session.label, '5-hour', 'label derived from window_minutes, not hardcoded');
    eq(session.resetsAt.toISOString(), '2026-08-14T15:10:00.000Z', 'relative reset resolved');

    const weekly = byId(quotas, 'codex.weekly');
    eq(weekly.percent, 22.5);
    eq(weekly.label, 'Weekly');
});

check('codex: additional and code-review limits are surfaced', () => {
    const {quotas} = codex.parseUsage(json('codex-usage.json'));
    eq(byId(quotas, 'codex.cloud-tasks').percent, 11);
    eq(byId(quotas, 'codex.cloud-tasks').label, 'cloud tasks');
    eq(byId(quotas, 'codex.code-review').hidable, true, 'an empty review quota is hidable');
});

check('codex: also accepts the CLI stream shape (rate_limits.primary)', () => {
    const {quotas} = codex.parseUsage({
        rate_limits: {
            primary: {used_percent: 12, window_minutes: 300, resets_in_seconds: 600},
            secondary: {used_percent: 3, window_minutes: 10080, resets_in_seconds: 60000},
        },
    }, Date.parse('2026-08-14T14:00:00Z'));
    eq(quotas.map(q => q.id), ['codex.session', 'codex.weekly']);
    eq(quotas[0].resetsAt.toISOString(), '2026-08-14T14:10:00.000Z');
});

check('codex: falls back to used/limit counters when no percent key is present', () => {
    const {quotas} = codex.parseUsage({
        rate_limit: {primary_window: {used: 25, limit: 200, window_minutes: 300}},
    });
    eq(quotas[0].percent, 12.5);
});

check('codex: an empty payload yields no quotas rather than throwing', () => {
    for (const empty of [{}, null, undefined, {rate_limit: {}}])
        eq(codex.parseUsage(empty).quotas.length, 0, `parseUsage(${JSON.stringify(empty)})`);
});

// ---------------------------------------------------------------- continuity

check('continuity: a quota missing from the new reading is carried at 0%', () => {
    // Observed live: GrokChat drops out of productUsage entirely once its usage
    // is zero, which happens at every weekly reset.
    const now = new Date('2026-08-14T14:30:00Z');
    const previous = [
        {id: 'grok.grokbuild', label: 'Build', percent: 31, resetsAt: new Date('2026-08-14T14:27:00Z'), lastSeenAt: new Date('2026-08-14T14:20:00Z')},
        {id: 'grok.grokchat', label: 'Chat', percent: 18, resetsAt: new Date('2026-08-14T14:27:00Z'), lastSeenAt: new Date('2026-08-14T14:20:00Z')},
    ];
    const incoming = [
        {id: 'grok.grokbuild', label: 'Build', percent: 1, resetsAt: new Date('2026-08-21T14:27:00Z')},
    ];

    const merged = mergeContinuity(previous, incoming, {now});
    eq(merged.map(q => q.id), ['grok.grokbuild', 'grok.grokchat'], 'both gauges survive');
    eq(merged[0].percent, 1);
    eq(merged[0].carried, false);
    eq(merged[1].percent, 0, 'the absent quota reads as zero, not as its old value');
    eq(merged[1].carried, true);
    eq(merged[1].resetsAt.toISOString(), '2026-08-21T14:27:00.000Z',
        'carried quota adopts the current window, not the expired one');
});

check('continuity: order is preserved so gauges do not shuffle', () => {
    const now = new Date('2026-08-14T14:30:00Z');
    const seen = new Date('2026-08-14T14:20:00Z');
    const previous = [
        {id: 'a', percent: 1, resetsAt: null, lastSeenAt: seen},
        {id: 'b', percent: 2, resetsAt: null, lastSeenAt: seen},
        {id: 'c', percent: 3, resetsAt: null, lastSeenAt: seen},
    ];
    // Upstream returns them in a different order, with 'b' missing and 'd' new.
    const incoming = [{id: 'c', percent: 9, resetsAt: null}, {id: 'a', percent: 8, resetsAt: null}, {id: 'd', percent: 7, resetsAt: null}];

    const merged = mergeContinuity(previous, incoming, {now});
    eq(merged.map(q => q.id), ['a', 'b', 'c', 'd'],
        'previous positions held, new quota appended');
});

check('continuity: a long-absent quota is retired rather than kept forever', () => {
    const now = new Date('2026-08-14T14:30:00Z');
    const previous = [
        {id: 'claude.seven_day_opus', percent: 5, resetsAt: null,
            lastSeenAt: new Date('2026-08-01T00:00:00Z')},  // 13 days ago
    ];
    const merged = mergeContinuity(previous, [{id: 'claude.session', percent: 4, resetsAt: null}], {now});
    eq(merged.map(q => q.id), ['claude.session'],
        'a limit the vendor removed eventually disappears');
});

check('continuity: a quota with no lastSeenAt is not resurrected', () => {
    const now = new Date('2026-08-14T14:30:00Z');
    const merged = mergeContinuity([{id: 'x', percent: 5, resetsAt: null}], [], {now});
    eq(merged.length, 0);
});

check('continuity: fresh readings always win over carried state', () => {
    const now = new Date('2026-08-14T14:30:00Z');
    const previous = [{id: 'x', percent: 90, resetsAt: null, lastSeenAt: now, carried: true}];
    const merged = mergeContinuity(previous, [{id: 'x', percent: 12, resetsAt: null}], {now});
    eq(merged[0].percent, 12);
    eq(merged[0].carried, false);
});

check('continuity: empty inputs are handled', () => {
    eq(mergeContinuity([], []).length, 0);
    eq(mergeContinuity(null, null).length, 0);
    eq(mergeContinuity(undefined, [{id: 'x', percent: 1, resetsAt: null}]).length, 1);
});

// ----------------------------------------------------------- cross-provider

check('every quota record satisfies the shared contract', () => {
    const results = [
        claude.parseUsage(json('claude-usage.json')),
        claude.parseUsage(json('claude-usage-legacy.json')),
        grok.parseBilling(json('grok-billing.json')),
        grok.parseBilling(json('grok-billing-ondemand.json')),
        codex.parseUsage(json('codex-usage.json')),
    ];

    const seen = new Set();
    for (const {quotas} of results) {
        for (const q of quotas) {
            ok(typeof q.id === 'string' && q.id.length > 0, `${q.id}: an id`);
            ok(typeof q.provider === 'string', `${q.id}: a provider`);
            ok(typeof q.label === 'string' && q.label.length > 0, `${q.id}: a label`);
            ok(typeof q.percent === 'number' && q.percent >= 0 && q.percent <= 100,
                `${q.id}: percent in 0..100, got ${q.percent}`);
            ok(q.resetsAt === null || q.resetsAt instanceof Date,
                `${q.id}: resetsAt is a Date or null`);
            ok(typeof q.active === 'boolean', `${q.id}: an active flag`);
            ok(['normal', 'warn', 'critical'].includes(q.severity),
                `${q.id}: a known severity, got ${q.severity}`);
            ok(q.id.startsWith(`${q.provider}.`), `${q.id}: id namespaced by provider`);
        }
        // Ids must be unique within a single reading, or the panel will
        // reuse one gauge for two quotas.
        const ids = quotas.map(q => q.id);
        eq(ids.length, new Set(ids).size, 'ids unique within a reading');
        ids.forEach(id => seen.add(id));
    }
    ok(seen.size > 0, 'at least one quota across all fixtures');
});

// ----------------------------------------------------------------- reporting

if (failures.length === 0) {
    print(`✓ ${passed} checks passed`);
} else {
    print(`✗ ${failures.length} failed, ${passed} passed\n`);
    for (const failure of failures)
        print(`  ✗ ${failure}`);
}

imports.system.exit(failures.length === 0 ? 0 : 1);
