import GLib from 'gi://GLib';

import {getJson, HttpError} from '../lib/http.js';
import {exists, readJson} from '../lib/io.js';
import {clampPercent, parseTimestamp} from '../lib/format.js';

/**
 * OpenAI Codex / ChatGPT plan quota.
 *
 * ⚠ UNVERIFIED. Codex is not installed on the machine this was written on, so
 * unlike the Claude and Grok providers, none of this has been exercised against
 * a live account. The endpoint, headers and response shape are lifted from
 * stonega/codex-usage-indicator (GPL, GNOME 45–50), which is in active use.
 *
 * The provider stays completely dormant until ~/.codex/auth.json exists, so a
 * machine without Codex never sees it and never pays for it. When it does light
 * up, expect to have to correct this file against a real payload — the response
 * parser is deliberately tolerant about which key carries the percentage.
 */

export const id = 'codex';
export const label = 'Codex';
export const glyph = 'X';
export const unverified = true;

const API_BASE_URL = 'https://chatgpt.com';
const USAGE_PATH = '/backend-api/wham/usage';
const REFERER = `${API_BASE_URL}/codex/cloud/settings/analytics`;

/** Codex honours $CODEX_HOME, defaulting to ~/.codex. */
function codexHome() {
    return GLib.getenv('CODEX_HOME') ||
        GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
}

export const authPath = () => GLib.build_filenamev([codexHome(), 'auth.json']);

export function watchPaths() {
    return [authPath()];
}

export function detect() {
    return exists(authPath());
}

/** The percentage can arrive under any of these; upstream varies by endpoint version. */
const PERCENT_KEYS = [
    'used_percent', 'percent', 'percentage',
    'usage_percent', 'percent_used', 'utilization',
];

function findPercent(window) {
    if (!window || typeof window !== 'object')
        return null;
    for (const key of PERCENT_KEYS) {
        const percent = clampPercent(window[key]);
        if (percent !== null)
            return percent;
    }
    // Some payloads only give raw counters.
    const used = Number(window.used ?? window.usage ?? window.consumed);
    const limit = Number(window.limit ?? window.quota ?? window.max);
    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0)
        return clampPercent((used / limit) * 100);
    return null;
}

/** Reset is given either as an absolute epoch or as a relative offset. */
function findReset(window, now = Date.now()) {
    if (!window || typeof window !== 'object')
        return null;

    const absolute = parseTimestamp(window.reset_at ?? window.resets_at);
    if (absolute)
        return absolute;

    const seconds = Number(window.reset_after_seconds ?? window.resets_in_seconds);
    if (Number.isFinite(seconds) && seconds > 0)
        return new Date(now + seconds * 1000);

    return null;
}

/**
 * Derive a human label from the window's declared length, so a plan with
 * different window sizes still reads correctly instead of being hardcoded
 * to "5h" and "Weekly".
 */
function describeWindow(window, fallbackLabel, fallbackShort) {
    const seconds = Number(
        window?.window_seconds ?? window?.limit_window_seconds ??
        (Number(window?.window_minutes) * 60));

    if (!Number.isFinite(seconds) || seconds <= 0)
        return {label: fallbackLabel, short: fallbackShort};

    const hours = Math.round(seconds / 3600);
    if (hours >= 24 * 6) {
        const days = Math.round(seconds / 86400);
        return {label: days === 7 ? 'Weekly' : `${days}-day`, short: 'wk'};
    }
    if (hours >= 1)
        return {label: `${hours}-hour`, short: `${hours}h`};
    return {label: fallbackLabel, short: fallbackShort};
}

/**
 * Normalise a /backend-api/wham/usage payload.
 * Tolerates both the wham shape (rate_limit.primary_window) and the shape the
 * Codex CLI emits on its own stream (rate_limits.primary).
 * Pure — no network, no GSettings.
 */
export function parseUsage(payload, now = Date.now()) {
    const quotas = [];
    const section = payload?.rate_limit ?? payload?.rate_limits ?? {};

    const candidates = [
        [section.primary_window ?? section.primary, 'Session', '5h', true],
        [section.secondary_window ?? section.secondary, 'Weekly', 'wk', false],
    ];

    for (const [window, fallbackLabel, fallbackShort, active] of candidates) {
        const percent = findPercent(window);
        if (percent === null)
            continue;
        const {label: windowLabel, short} = describeWindow(window, fallbackLabel, fallbackShort);
        quotas.push({
            id: `codex.${fallbackLabel.toLowerCase()}`,
            provider: id,
            label: windowLabel,
            short,
            percent,
            resetsAt: findReset(window, now),
            active,
            severity: 'normal',
            hidable: false,
        });
    }

    // Separate quota for code review, when the plan carries one.
    const review = payload?.code_review_rate_limit;
    const reviewWindow = review?.primary_window ?? review?.primary ?? review;
    const reviewPercent = findPercent(reviewWindow);
    if (reviewPercent !== null) {
        quotas.push({
            id: 'codex.code-review',
            provider: id,
            label: 'Code review',
            short: 'rev',
            percent: reviewPercent,
            resetsAt: findReset(reviewWindow, now),
            active: false,
            severity: 'normal',
            hidable: reviewPercent === 0,
        });
    }

    for (const [index, item] of (payload?.additional_rate_limits ?? []).entries()) {
        const window = item?.rate_limit?.primary_window ?? item?.rate_limit ?? item;
        const percent = findPercent(window);
        if (percent === null)
            continue;
        const name = item?.limit_name ?? `Limit ${index + 1}`;
        quotas.push({
            id: `codex.${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
            provider: id,
            label: String(name).replace(/_/g, ' '),
            short: null,
            percent,
            resetsAt: findReset(window, now),
            active: false,
            severity: 'normal',
            hidable: percent === 0,
        });
    }

    return {
        quotas,
        meta: {
            plan: payload?.plan_type ?? null,
            tier: payload?.credits?.unlimited === true ? 'unlimited credits' : null,
        },
    };
}

export async function fetchQuota({session, cancellable}) {
    const auth = await readJson(authPath(), cancellable);
    const token = auth?.tokens?.access_token;

    if (!token)
        return {ok: false, authState: 'missing', error: 'Not signed in to Codex'};

    const accountId = auth?.tokens?.account_id ?? null;

    let payload;
    try {
        payload = await getJson(session, `${API_BASE_URL}${USAGE_PATH}`, {
            cancellable,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': '*/*',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Referer': REFERER,
                'oai-language': 'en-US',
                'x-openai-target-path': USAGE_PATH,
                'x-openai-target-route': USAGE_PATH,
                ...(accountId ? {'chatgpt-account-id': accountId} : {}),
            },
        });
    } catch (e) {
        if (e instanceof HttpError && e.isAuthFailure) {
            return {
                ok: false,
                authState: 'rejected',
                error: 'Codex credentials rejected — run codex to sign in again',
            };
        }
        throw e;
    }

    const {quotas, meta} = parseUsage(payload);
    return {ok: true, source: 'api', quotas, meta, fetchedAt: new Date()};
}
