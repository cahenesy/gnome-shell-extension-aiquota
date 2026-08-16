#!/usr/bin/env -S gjs -m

import {evaluateThresholds, notificationCopy} from '../lib/notify-policy.js';

/**
 * Notification policy tests: `gjs -m test/notify.js`
 *
 * The Notifier itself talks to GNOME Shell's message tray, so the decision
 * procedure lives in a shell-free module and is what we exercise here.
 */

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

function quota(overrides = {}) {
    return {
        id: 'claude.session',
        provider: 'claude',
        label: 'Session',
        percent: 100,
        resetsAt: new Date('2026-08-16T20:00:00.493Z'),
        ...overrides,
    };
}

function levels(events) {
    return events.map(e => e.level);
}

function advance(state, quotas, options) {
    return evaluateThresholds(state, quotas, options);
}

// ---------------------------------------------------------------- rising edge

check('first crossing of the warning band emits warn once', () => {
    const {state, events} = advance({}, [quota({percent: 76})]);
    eq(levels(events), ['warn']);
    eq(state['claude.session'].fired, ['warn']);
});

check('staying at or above a fired threshold is silent', () => {
    const first = advance({}, [quota({percent: 76})]);
    const second = advance(first.state, [quota({percent: 80})]);
    eq(levels(second.events), []);
    eq(second.state['claude.session'].fired, ['warn']);
});

check('crossing critical after warn emits critical only', () => {
    const warned = advance({}, [quota({percent: 76})]);
    const {events, state} = advance(warned.state, [quota({percent: 92})]);
    eq(levels(events), ['critical']);
    eq(state['claude.session'].fired, ['warn', 'critical']);
});

check('jumping straight to 100% emits critical and swallows warn', () => {
    const {events, state} = advance({}, [quota({percent: 100})]);
    eq(levels(events), ['critical']);
    eq(state['claude.session'].fired, ['critical', 'warn']);
});

// The live Claude /oauth/usage payload moves resets_at by hundreds of
// milliseconds between polls of the same window. Treating that timestamp as
// a window identity re-arms every poll and re-notifies a 100% session.
check('a jittering reset time does not re-fire a still-exhausted quota', () => {
    const first = advance({}, [quota({
        percent: 100,
        resetsAt: new Date('2026-08-16T19:59:59.989Z'),
    })]);
    eq(levels(first.events), ['critical']);

    const second = advance(first.state, [quota({
        percent: 100,
        resetsAt: new Date('2026-08-16T20:00:00.152Z'),
    })]);
    eq(levels(second.events), [], 'no second notification');
    eq(second.state['claude.session'].fired, ['critical', 'warn']);
});

check('persisted fired state is honoured even when the stored window disagrees', () => {
    const persisted = {
        'claude.session': {
            window: '2026-08-16T20:00:00.493Z',
            fired: ['critical', 'warn'],
        },
    };
    const {events} = advance(persisted, [quota({
        percent: 100,
        resetsAt: new Date('2026-08-16T19:59:59.989Z'),
    })]);
    eq(levels(events), []);
});

check('dropping below a threshold re-arms it; recrossing fires again', () => {
    const fired = advance({}, [quota({percent: 100})]);
    const reset = advance(fired.state, [quota({percent: 10})]);
    eq(levels(reset.events), []);
    eq(reset.state['claude.session'].fired, []);

    const recrossed = advance(reset.state, [quota({percent: 76})]);
    eq(levels(recrossed.events), ['warn']);
});

check('hovering around the warning band does not nag on every poll', () => {
    const a = advance({}, [quota({percent: 76})]);
    const b = advance(a.state, [quota({percent: 76})]);
    const c = advance(b.state, [quota({percent: 74})]);
    const d = advance(c.state, [quota({percent: 76})]);
    eq(levels(a.events), ['warn']);
    eq(levels(b.events), []);
    eq(levels(c.events), []);
    eq(levels(d.events), ['warn'], 're-armed only after actually dropping below');
});

check('a missing percent does not emit and does not forget prior firings', () => {
    const fired = advance({}, [quota({percent: 92})]);
    const blank = advance(fired.state, [quota({percent: null})]);
    eq(levels(blank.events), []);
    eq(blank.state['claude.session'].fired, ['critical', 'warn']);
});

check('a vanished quota is dropped from state', () => {
    const fired = advance({}, [
        quota({id: 'claude.session', percent: 80}),
        quota({id: 'claude.weekly_all', percent: 10, label: 'Weekly'}),
    ]);
    const next = advance(fired.state, [
        quota({id: 'claude.weekly_all', percent: 10, label: 'Weekly'}),
    ]);
    eq(Object.keys(next.state), ['claude.weekly_all']);
});

// ---------------------------------------------------------------- copy

check('100% is exhausted, not nearly exhausted', () => {
    const {title, body} = notificationCopy(
        quota({percent: 100}), 'critical', 'Claude Code');
    eq(title, 'Claude Code: Session exhausted');
    if (!body.startsWith('100% used.'))
        throw new Error(`body should lead with "100% used.", got ${JSON.stringify(body)}`);
    if (/nearly/i.test(title) || /nearing/i.test(title) || /nearly/i.test(body))
        throw new Error(`copy must not say nearly/nearing at 100%: ${title} / ${body}`);
});

check('a displayed 100% (99.6 rounded) is also exhausted', () => {
    const {title} = notificationCopy(
        quota({percent: 99.6}), 'critical', 'Claude Code');
    eq(title, 'Claude Code: Session exhausted');
});

check('critical below 100% is still nearly exhausted', () => {
    const {title} = notificationCopy(
        quota({percent: 92}), 'critical', 'Claude Code');
    eq(title, 'Claude Code: Session nearly exhausted');
});

check('warning copy says running low', () => {
    const {title} = notificationCopy(
        quota({percent: 76}), 'warn', 'Claude Code');
    eq(title, 'Claude Code: Session running low');
});

// ---------------------------------------------------------------- reporting

if (failures.length === 0) {
    print(`✓ ${passed} checks passed`);
} else {
    print(`✗ ${failures.length} failed, ${passed} passed\n`);
    for (const failure of failures)
        print(`  ✗ ${failure}`);
}

imports.system.exit(failures.length === 0 ? 0 : 1);
