import * as claude from './claude.js';
import * as grok from './grok.js';
import * as codex from './codex.js';

/**
 * Provider registry.
 *
 * Each provider is a plain object exposing:
 *   id, label, glyph            identity for the panel and menu
 *   unverified                  true when the implementation has never been run
 *                               against a live account (currently: Codex)
 *   detect()                    sync; is this tool present on this machine?
 *   watchPaths()                credential files to monitor for refreshes
 *   fetchQuota({session, cancellable})  -> result
 *   readFallback(cancellable)   -> result | null   (offline / unauthenticated)
 *
 * A result is either
 *   {ok: true, source, quotas, meta, fetchedAt, stale?}
 * or
 *   {ok: false, authState: 'missing'|'expired'|'rejected', error}
 *
 * `authState` is what stops the poller from hammering an endpoint that will
 * keep saying no; it resumes when the credential file changes. A fetch that
 * throws instead is treated as a transient network problem and retried with
 * backoff.
 *
 * Module namespace objects are sealed, so providers are re-wrapped here rather
 * than annotated in place.
 */

function wrap(module, {readFallback = null} = {}) {
    return {
        id: module.id,
        label: module.label,
        glyph: module.glyph,
        unverified: module.unverified === true,
        detect: module.detect,
        watchPaths: module.watchPaths,
        fetchQuota: module.fetchQuota,
        readFallback,
    };
}

export const PROVIDERS = [
    wrap(claude, {readFallback: claude.readCachedFallback}),
    wrap(grok, {readFallback: grok.readLogFallback}),
    wrap(codex),
];

export function providerById(providerId) {
    return PROVIDERS.find(p => p.id === providerId) ?? null;
}
