#!/usr/bin/env -S gjs -m

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {PROVIDERS} from '../providers/index.js';
import {createSession} from '../lib/http.js';
import {formatAbsolute, formatDuration, formatPercent} from '../lib/format.js';

/**
 * Live smoke test: `gjs -m test/smoke.js`
 *
 * Hits the real endpoints with your real credentials and prints what the panel
 * would show. Not part of the automated suite — it needs network and a signed-in
 * account, and its whole purpose is to tell you whether an undocumented upstream
 * has changed shape.
 *
 * Prints no tokens.
 */

const loop = new GLib.MainLoop(null, false);
const session = createSession();
const cancellable = new Gio.Cancellable();

function line(text = '') {
    print(text);
}

async function probe(provider) {
    line(`\n${provider.label}  [${provider.id}]${provider.unverified ? '  ⚠ unverified' : ''}`);
    line('─'.repeat(56));

    if (!provider.detect()) {
        line('  not installed on this machine — skipped');
        return;
    }

    let result;
    try {
        result = await provider.fetchQuota({session, cancellable});
    } catch (e) {
        line(`  fetch threw: ${e.message}`);
        result = null;
    }

    if (!result?.ok) {
        if (result)
            line(`  live fetch unavailable: ${result.error} (${result.authState})`);
        if (provider.readFallback) {
            line('  trying offline fallback…');
            try {
                result = await provider.readFallback(cancellable);
            } catch (e) {
                line(`  fallback threw: ${e.message}`);
                result = null;
            }
        }
        if (!result?.ok) {
            line('  no reading available');
            return;
        }
    }

    const age = result.fetchedAt ? formatAbsolute(result.fetchedAt) : 'unknown';
    line(`  source: ${result.source}${result.stale ? ' (stale)' : ''}   fetched: ${age}`);
    if (result.meta?.plan || result.meta?.tier)
        line(`  plan: ${result.meta.plan ?? '—'}   ${result.meta.tier ?? ''}`);
    line('');

    for (const q of result.quotas) {
        const bar = '█'.repeat(Math.round(q.percent / 5)).padEnd(20, '░');
        const flags = [
            q.active ? 'active' : null,
            q.optional ? 'optional' : null,
            q.hidable ? 'hidable' : null,
        ].filter(Boolean).join(' ');
        line(`  ${bar} ${formatPercent(q.percent).padStart(5)}  ${q.label}`);
        line(`  ${' '.repeat(20)}        id=${q.id}${flags ? `  [${flags}]` : ''}`);
        if (q.resetsAt) {
            line(`  ${' '.repeat(20)}        resets in ${formatDuration(q.resetsAt)} — ${formatAbsolute(q.resetsAt)}`);
        } else {
            line(`  ${' '.repeat(20)}        no reset scheduled`);
        }
        line('');
    }
}

(async () => {
    try {
        for (const provider of PROVIDERS)
            await probe(provider);
    } catch (e) {
        line(`\nunexpected failure: ${e.message}\n${e.stack ?? ''}`);
    } finally {
        session.abort();
        loop.quit();
    }
})();

loop.run();
