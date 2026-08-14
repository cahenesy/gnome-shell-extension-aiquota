import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {createSession, isCancelled} from './http.js';
import {mergeContinuity} from './continuity.js';
import {parseTimestamp} from './format.js';
import {readJson, watchFile, writePrivate} from './io.js';

/**
 * Polling orchestration.
 *
 * Design notes worth keeping in mind before changing anything here:
 *
 * - There is exactly one timer, set to the earliest due provider, rather than a
 *   fixed heartbeat. An idle machine therefore wakes once per interval, not
 *   every N seconds to discover there is nothing to do.
 *
 * - A rejected/expired/missing credential does not back off, it *stops*. No
 *   timer will ever fix a bad token, and retrying one is how you get an IP
 *   throttled. Polling resumes when the credential file changes on disk — which
 *   is precisely the moment the vendor's own CLI refreshed it.
 *
 * - Network failures back off geometrically and do keep retrying.
 *
 * - Everything is cancellable, and every timer id is tracked, because this runs
 *   inside gnome-shell and a leaked callback firing after disable() takes the
 *   whole session down with it.
 */

const MIN_INTERVAL_SECONDS = 180;
const BACKOFF_SECONDS = [60, 120, 300, 900];
const JITTER = 0.1;
const NEVER = Number.MAX_SAFE_INTEGER;

function jittered(seconds) {
    // Deterministic-enough spread so several providers do not fire in lockstep.
    const spread = seconds * JITTER;
    return seconds - spread + Math.random() * 2 * spread;
}

export class Poller {
    /**
     * @param {object[]} providers from providers/index.js
     * @param {object} options {getIntervalSeconds, getEnabledIds, onUpdate, cachePath}
     */
    constructor(providers, options) {
        this._providers = providers;
        this._getIntervalSeconds = options.getIntervalSeconds;
        this._getEnabledIds = options.getEnabledIds;
        this._onUpdate = options.onUpdate;
        this._cachePath = options.cachePath;

        this._session = null;
        this._cancellable = null;
        this._timeoutId = 0;
        this._unwatchers = [];
        this._running = false;

        /** @type {Map<string, object>} per-provider runtime state */
        this._state = new Map();
        for (const provider of providers) {
            this._state.set(provider.id, {
                nextAt: 0,
                backoffStep: 0,
                inFlight: false,
                blocked: null,   // authState string once blocked
                result: null,
            });
        }

        this._notifyState = {};
    }

    get notifyState() {
        return this._notifyState;
    }

    set notifyState(value) {
        this._notifyState = value ?? {};
    }

    /** Snapshot of every provider's latest reading, for the UI. */
    snapshot() {
        const out = {};
        for (const [id, state] of this._state)
            out[id] = state.result;
        return out;
    }

    start() {
        if (this._running)
            return;
        this._running = true;

        this._session = createSession();
        this._cancellable = new Gio.Cancellable();

        for (const provider of this._providers) {
            for (const path of provider.watchPaths?.() ?? []) {
                this._unwatchers.push(watchFile(path, () => {
                    // The CLI just wrote new credentials: unblock and re-poll.
                    const state = this._state.get(provider.id);
                    if (!state)
                        return;
                    state.blocked = null;
                    state.backoffStep = 0;
                    state.nextAt = 0;
                    this._reschedule();
                }));
            }
        }

        // The cache must land before the first fetch: it carries the previous
        // quota set, and _normalise() needs it to know which gauges to hold in
        // place. Racing it would silently drop continuity on every login.
        this._loadCache()
            .catch(e => console.warn(`aiquota: cache load failed: ${e}`))
            .finally(() => {
                if (this._running)
                    this._runDue();
            });
    }

    stop() {
        this._running = false;

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        for (const unwatch of this._unwatchers) {
            try {
                unwatch();
            } catch (e) {
                console.warn(`aiquota: unwatch failed: ${e}`);
            }
        }
        this._unwatchers = [];

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
    }

    /**
     * Poll now.
     * @param {boolean} force ignore the per-provider minimum interval
     * @returns {boolean} false if every provider was rate-limited by the floor
     */
    refreshNow(force = false) {
        if (!this._running)
            return false;

        const now = Date.now();
        let any = false;
        for (const provider of this._enabledProviders()) {
            const state = this._state.get(provider.id);
            if (state.blocked && !force)
                continue;
            if (force) {
                state.blocked = null;
                state.backoffStep = 0;
            }
            const floorAt = (state.result?.fetchedAt?.getTime() ?? 0) +
                MIN_INTERVAL_SECONDS * 1000;
            if (!force && now < floorAt)
                continue;
            state.nextAt = 0;
            any = true;
        }

        this._runDue();
        return any;
    }

    _enabledProviders() {
        const enabled = new Set(this._getEnabledIds());
        return this._providers.filter(p => enabled.has(p.id) && p.detect());
    }

    _intervalSeconds() {
        return Math.max(MIN_INTERVAL_SECONDS, this._getIntervalSeconds());
    }

    _runDue() {
        if (!this._running)
            return;

        const now = Date.now();
        for (const provider of this._enabledProviders()) {
            const state = this._state.get(provider.id);
            if (state.inFlight || state.blocked)
                continue;
            if (state.nextAt > now)
                continue;
            this._fetch(provider, state);
        }

        this._reschedule();
    }

    async _fetch(provider, state) {
        state.inFlight = true;
        const cancellable = this._cancellable;

        try {
            const result = await provider.fetchQuota({
                session: this._session,
                cancellable,
            });

            if (!this._running || cancellable?.is_cancelled())
                return;

            if (result?.ok) {
                state.result = this._normalise(result, state.result);
                state.backoffStep = 0;
                state.blocked = null;
                state.nextAt = Date.now() + jittered(this._intervalSeconds()) * 1000;
            } else {
                // Credentials are the problem. Stop polling; wait for the file.
                state.blocked = result?.authState ?? 'rejected';
                state.nextAt = NEVER;
                await this._applyFallback(provider, state, result?.error);
            }
        } catch (e) {
            if (isCancelled(e) || !this._running)
                return;

            const step = Math.min(state.backoffStep, BACKOFF_SECONDS.length - 1);
            const delay = BACKOFF_SECONDS[step];
            state.backoffStep++;
            state.nextAt = Date.now() + delay * 1000;

            console.warn(`aiquota: ${provider.id} fetch failed (retry in ${delay}s): ${e.message}`);

            // Keep the last good reading on screen, flagged stale, rather than
            // blanking the panel because the wifi blipped.
            if (state.result)
                state.result = {...state.result, stale: true, error: e.message};
            else
                await this._applyFallback(provider, state, e.message);
        } finally {
            state.inFlight = false;
            if (this._running) {
                this._emit();
                this._saveCache();
                this._reschedule();
            }
        }
    }

    /** Populate from the provider's offline source, or record the failure. */
    async _applyFallback(provider, state, error) {
        if (provider.readFallback) {
            try {
                const fallback = await provider.readFallback(this._cancellable);
                if (fallback?.ok) {
                    state.result = {
                        ...this._normalise(fallback, state.result),
                        stale: true,
                        error,
                    };
                    return;
                }
            } catch (e) {
                console.warn(`aiquota: ${provider.id} fallback failed: ${e.message}`);
            }
        }

        state.result = state.result
            ? {...state.result, stale: true, error}
            : {ok: false, quotas: [], meta: {}, error, source: null, fetchedAt: null};
    }

    _normalise(result, previous = null) {
        return {
            ok: true,
            source: result.source ?? 'api',
            stale: result.stale === true,
            // Carry recently-seen-but-now-absent quotas forward at 0%, so the
            // panel does not reshuffle every time a window resets.
            quotas: mergeContinuity(previous?.quotas ?? [], result.quotas ?? []),
            meta: result.meta ?? {},
            fetchedAt: result.fetchedAt ?? new Date(),
            error: null,
        };
    }

    _reschedule() {
        if (!this._running)
            return;

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        let earliest = NEVER;
        for (const provider of this._enabledProviders()) {
            const state = this._state.get(provider.id);
            if (state.inFlight || state.blocked)
                continue;
            earliest = Math.min(earliest, state.nextAt);
        }

        if (earliest === NEVER)
            return; // Everything is blocked; a file monitor will wake us.

        const delayMs = Math.max(1000, earliest - Date.now());
        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delayMs,
            () => {
                this._timeoutId = 0;
                this._runDue();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _emit() {
        try {
            this._onUpdate?.(this.snapshot());
        } catch (e) {
            console.error(`aiquota: update handler failed: ${e}`);
        }
    }

    // ------------------------------------------------------------- caching

    /**
     * The cache exists so the panel is populated the instant you log in, rather
     * than showing empty gauges for the first few seconds — an empty gauge is a
     * factual claim, and we should not make it before we know.
     *
     * Readings only. Never tokens.
     */
    _saveCache() {
        if (!this._cachePath)
            return;

        const providers = {};
        for (const [id, state] of this._state) {
            if (!state.result?.ok)
                continue;
            providers[id] = {
                source: state.result.source,
                fetchedAt: state.result.fetchedAt?.toISOString() ?? null,
                meta: state.result.meta,
                quotas: state.result.quotas.map(q => ({
                    ...q,
                    resetsAt: q.resetsAt ? q.resetsAt.toISOString() : null,
                    // Persisted so continuity survives a shell restart —
                    // otherwise every login forgets which gauges belong here.
                    lastSeenAt: q.lastSeenAt ? q.lastSeenAt.toISOString() : null,
                })),
            };
        }

        writePrivate(this._cachePath, JSON.stringify({
            version: 1,
            savedAt: new Date().toISOString(),
            providers,
            notifyState: this._notifyState,
        }));
    }

    async _loadCache() {
        if (!this._cachePath)
            return;

        const cached = await readJson(this._cachePath, this._cancellable);
        if (!cached || cached.version !== 1 || !this._running)
            return;

        this._notifyState = cached.notifyState ?? {};

        for (const [id, entry] of Object.entries(cached.providers ?? {})) {
            const state = this._state.get(id);
            // A live reading arrived while we were reading the cache: keep it.
            if (!state || state.result)
                continue;
            state.result = {
                ok: true,
                source: entry.source ?? 'cache',
                stale: true,
                quotas: (entry.quotas ?? []).map(q => ({
                    ...q,
                    resetsAt: parseTimestamp(q.resetsAt),
                    lastSeenAt: parseTimestamp(q.lastSeenAt),
                })),
                meta: entry.meta ?? {},
                fetchedAt: parseTimestamp(entry.fetchedAt),
                error: null,
            };
        }

        this._emit();
    }
}
