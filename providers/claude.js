import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {getJson, HttpError} from '../lib/http.js';
import {exists, homePath, readJson} from '../lib/io.js';
import {clampPercent, parseTimestamp} from '../lib/format.js';

/**
 * Claude Code (Anthropic) subscription quota.
 *
 * Source: GET https://api.anthropic.com/api/oauth/usage — the same endpoint the
 * `/usage` slash command calls. Undocumented, so treat the response defensively:
 * every field is optional and the set of windows changes as Anthropic ships new
 * plan mechanics.
 *
 * The `limits[]` array is the forward-compatible shape — a generic list of
 * {kind, percent, resets_at, severity, is_active, scope}. Prefer it, and fall
 * back to the older named `five_hour` / `seven_day` objects only when it is
 * absent, so a new window type shows up on its own rather than needing a patch.
 */

export const id = 'claude';
export const label = 'Claude Code';
export const glyph = 'C';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const FALLBACK_VERSION = '2.1.232';

/**
 * Anthropic buckets requests by User-Agent, and a generic one lands in an
 * aggressively throttled pool that returns persistent 429s
 * (anthropics/claude-code#31637). Impersonating the CLI is what keeps this
 * endpoint usable at all.
 */
function userAgent(version) {
    return `claude-cli/${version} (external, cli)`;
}

export const credentialPath = () => homePath('.claude', '.credentials.json');
const globalConfigPath = () => homePath('.claude.json');

export function watchPaths() {
    return [credentialPath()];
}

export function detect() {
    return exists(credentialPath());
}

/** Resolve the installed CLI version; the launcher symlinks straight at it. */
function detectVersion() {
    try {
        const target = GLib.file_read_link(homePath('.local', 'bin', 'claude'));
        const base = target ? GLib.path_get_basename(target) : null;
        if (base && /^\d+\.\d+\.\d+/.test(base))
            return base;
    } catch {
        // Not a symlink, or not installed there. Fall through.
    }

    try {
        const dir = Gio.File.new_for_path(homePath('.local', 'share', 'claude', 'versions'));
        const iter = dir.enumerate_children(
            Gio.FILE_ATTRIBUTE_STANDARD_NAME, Gio.FileQueryInfoFlags.NONE, null);
        const versions = [];
        let info;
        while ((info = iter.next_file(null)) !== null) {
            const name = info.get_name();
            if (/^\d+\.\d+\.\d+$/.test(name))
                versions.push(name);
        }
        iter.close(null);
        if (versions.length > 0) {
            versions.sort((a, b) => {
                const pa = a.split('.').map(Number);
                const pb = b.split('.').map(Number);
                for (let i = 0; i < 3; i++) {
                    if (pa[i] !== pb[i])
                        return pb[i] - pa[i];
                }
                return 0;
            });
            return versions[0];
        }
    } catch {
        // Directory missing or unreadable.
    }

    return FALLBACK_VERSION;
}

const SEVERITY_RANK = {normal: 0, warn: 1, warning: 1, critical: 2, severe: 2};

/** Normalise whatever severity string the API used into our three bands. */
function apiSeverity(value) {
    const rank = SEVERITY_RANK[String(value ?? '').toLowerCase()];
    if (rank === 2)
        return 'critical';
    if (rank === 1)
        return 'warn';
    return 'normal';
}

/** Human labels for the window kinds we know about. */
function describeLimit(limit) {
    const kind = String(limit?.kind ?? '');
    const scopeName =
        limit?.scope?.model?.display_name ??
        limit?.scope?.surface?.display_name ??
        limit?.scope?.surface ??
        null;

    switch (kind) {
    case 'session':
        return {label: 'Session', short: '5h'};
    case 'weekly_all':
        return {label: 'Weekly', short: 'wk'};
    case 'weekly_scoped':
        return scopeName
            ? {label: `Weekly · ${scopeName}`, short: 'wk'}
            : {label: 'Weekly (scoped)', short: 'wk'};
    default: {
        // Unknown kind: show it rather than silently dropping a real limit.
        const pretty = kind
            ? kind.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
            : 'Limit';
        return {label: scopeName ? `${pretty} · ${scopeName}` : pretty, short: null};
    }
    }
}

/** Stable, collision-free id for a limit entry. */
function limitId(limit, index) {
    const kind = String(limit?.kind ?? `limit${index}`);
    const scopeName =
        limit?.scope?.model?.id ??
        limit?.scope?.model?.display_name ??
        limit?.scope?.surface ??
        null;
    const suffix = scopeName
        ? `.${String(scopeName).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
        : '';
    return `claude.${kind}${suffix}`;
}

/** The legacy named windows, used only when `limits[]` is missing. */
const LEGACY_WINDOWS = [
    ['five_hour', 'Session', '5h'],
    ['seven_day', 'Weekly', 'wk'],
    ['seven_day_opus', 'Weekly · Opus', 'wk'],
    ['seven_day_sonnet', 'Weekly · Sonnet', 'wk'],
    ['seven_day_oauth_apps', 'Weekly · OAuth apps', 'wk'],
    ['seven_day_cowork', 'Weekly · Cowork', 'wk'],
];

/**
 * Turn a /api/oauth/usage payload into normalised quota records.
 * Pure — no network, no GSettings — so the tests can drive it directly.
 */
export function parseUsage(payload, meta = {}) {
    const quotas = [];

    const limits = Array.isArray(payload?.limits) ? payload.limits : null;

    if (limits && limits.length > 0) {
        limits.forEach((limit, index) => {
            const percent = clampPercent(limit?.percent);
            if (percent === null)
                return;
            const {label: limitLabel, short} = describeLimit(limit);
            const resetsAt = parseTimestamp(limit?.resets_at);
            const active = limit?.is_active === true;
            quotas.push({
                id: limitId(limit, index),
                provider: id,
                label: limitLabel,
                short,
                percent,
                resetsAt,
                active,
                severity: apiSeverity(limit?.severity),
                // Nothing consumed, not the active window, no reset pending:
                // there is no information here worth a panel slot.
                hidable: percent === 0 && !active && resetsAt === null,
            });
        });
    } else {
        for (const [key, windowLabel, short] of LEGACY_WINDOWS) {
            const entry = payload?.[key];
            const percent = clampPercent(entry?.utilization);
            if (percent === null)
                continue;
            const resetsAt = parseTimestamp(entry?.resets_at);
            quotas.push({
                id: `claude.${key}`,
                provider: id,
                label: windowLabel,
                short,
                percent,
                resetsAt,
                active: key === 'five_hour',
                severity: 'normal',
                hidable: percent === 0 && resetsAt === null,
            });
        }
    }

    // Extra-usage / spend only matters once you have actually enabled it.
    const spend = payload?.spend;
    const extra = payload?.extra_usage;
    const spendEnabled = spend?.enabled === true || extra?.is_enabled === true;
    if (spendEnabled) {
        const percent = clampPercent(spend?.percent ?? extra?.utilization);
        if (percent !== null) {
            quotas.push({
                id: 'claude.spend',
                provider: id,
                label: 'Extra usage',
                short: '$',
                percent,
                resetsAt: parseTimestamp(spend?.resets_at ?? extra?.resets_at),
                active: true,
                severity: apiSeverity(spend?.severity),
                hidable: false,
            });
        }
    }

    return {
        quotas,
        meta: {
            plan: meta.plan ?? null,
            tier: meta.tier ?? null,
        },
    };
}

/**
 * Fetch live quota state.
 *
 * Credentials are re-read on every call so a refresh performed by Claude Code
 * itself is picked up immediately. We never rotate the token ourselves — see
 * the note in README.md.
 */
export async function fetchQuota({session, cancellable}) {
    const creds = await readJson(credentialPath(), cancellable);
    const oauth = creds?.claudeAiOauth;
    const token = oauth?.accessToken;

    if (!token) {
        return {
            ok: false,
            authState: 'missing',
            error: 'Not signed in to Claude Code',
        };
    }

    const expiresAt = parseTimestamp(oauth?.expiresAt);
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
        // Deliberately do not refresh: Claude Code owns this token's lifecycle.
        return {
            ok: false,
            authState: 'expired',
            error: 'Claude Code token expired — run claude to refresh it',
        };
    }

    const version = detectVersion();
    let payload;
    try {
        payload = await getJson(session, USAGE_URL, {
            cancellable,
            headers: {
                'Authorization': `Bearer ${token}`,
                'anthropic-beta': OAUTH_BETA,
                'User-Agent': userAgent(version),
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
        });
    } catch (e) {
        if (e instanceof HttpError && e.isAuthFailure) {
            return {
                ok: false,
                authState: 'rejected',
                error: 'Claude Code credentials rejected',
            };
        }
        throw e;
    }

    const {quotas, meta} = parseUsage(payload, {
        plan: oauth?.subscriptionType ?? null,
        tier: oauth?.rateLimitTier ?? null,
    });

    return {ok: true, source: 'api', quotas, meta, fetchedAt: new Date()};
}

/**
 * Free, zero-network fast path for cold start: Claude Code caches its own last
 * utilisation reading in ~/.claude.json. Present only after a session has
 * fetched at least once, and rewritten at most every 5 minutes, so it is a
 * head start rather than a substitute.
 */
export async function readCachedFallback(cancellable) {
    const config = await readJson(globalConfigPath(), cancellable);
    const cached = config?.cachedUsageUtilization;
    if (!cached?.utilization)
        return null;

    const {quotas} = parseUsage(cached.utilization, {
        plan: config?.oauthAccount?.userRateLimitTier ?? null,
    });
    if (quotas.length === 0)
        return null;

    return {
        ok: true,
        source: 'cache',
        stale: true,
        quotas,
        meta: {plan: config?.oauthAccount?.userRateLimitTier ?? null, tier: null},
        fetchedAt: parseTimestamp(cached.fetchedAtMs) ?? null,
    };
}
