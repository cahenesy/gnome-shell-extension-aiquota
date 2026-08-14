import GLib from 'gi://GLib';

import {getJson, HttpError} from '../lib/http.js';
import {exists, homePath, readJson, readTail, readText} from '../lib/io.js';
import {clampPercent, parseTimestamp} from '../lib/format.js';

/**
 * Grok Build (xAI) subscription quota.
 *
 * Source: GET https://cli-chat-proxy.grok.com/v1/billing?format=credits — the
 * endpoint behind the CLI's own `/usage` command. Undocumented; the path string
 * lives in the grok binary beside `xai-grok-shell/src/extensions/billing.rs`.
 *
 * Quota is a single weekly credit pool shared across products, reported both as
 * a total (`creditUsagePercent`) and split per product (`productUsage[]`).
 *
 * Unusually, this provider has a genuinely useful offline fallback: the CLI
 * logs the entire billing payload to ~/.grok/logs/unified.jsonl on every run,
 * so we can show a real (if stale) reading even with no usable token.
 */

export const id = 'grok';
export const label = 'Grok Build';
export const glyph = 'G';

const DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const FALLBACK_VERSION = '1.0.3';
const LOG_MARKER = 'billing: fetched credits config';

export const authPath = () => homePath('.grok', 'auth.json');
const versionPath = () => homePath('.grok', 'version.json');
const configPath = () => homePath('.grok', 'config.toml');
const logPath = () => homePath('.grok', 'logs', 'unified.jsonl');

export function watchPaths() {
    return [authPath()];
}

export function detect() {
    return exists(authPath()) || exists(logPath());
}

/**
 * Honour the same base-URL overrides the CLI does, so a redirected install
 * (enterprise proxy, staging) keeps working.
 */
async function resolveBaseUrl(cancellable) {
    const fromEnv =
        GLib.getenv('GROK_CLI_CHAT_PROXY_BASE_URL') ||
        GLib.getenv('CLI_CHAT_PROXY_BASE_URL');
    if (fromEnv)
        return fromEnv.replace(/\/+$/, '');

    const toml = await readText(configPath(), cancellable);
    if (toml) {
        // A single key out of a TOML file does not justify a TOML parser.
        const match = toml.match(/^\s*cli_chat_proxy_base_url\s*=\s*["']([^"']+)["']/m);
        if (match)
            return match[1].replace(/\/+$/, '');
    }

    return DEFAULT_BASE_URL;
}

async function detectVersion(cancellable) {
    const info = await readJson(versionPath(), cancellable);
    return info?.version ?? FALLBACK_VERSION;
}

/**
 * auth.json is keyed by "<issuer>::<client_id>". There is normally exactly one
 * entry; if there are several, prefer an unexpired one over the first.
 */
function selectAuthEntry(authJson) {
    if (!authJson || typeof authJson !== 'object')
        return null;

    const entries = Object.values(authJson).filter(
        e => e && typeof e === 'object' && typeof e.key === 'string');
    if (entries.length === 0)
        return null;

    const now = Date.now();
    const live = entries.find(e => {
        const exp = parseTimestamp(e.expires_at);
        return exp === null || exp.getTime() > now;
    });
    return live ?? entries[0];
}

/** "GrokBuild" -> "Build"; leaves anything unexpected intact. */
function productLabel(product) {
    const name = String(product ?? '').trim();
    if (!name)
        return 'Usage';
    const stripped = name.replace(/^Grok(?=[A-Z])/, '');
    // Split camelCase so a future "GrokDeepSearch" reads as "Deep Search".
    return stripped.replace(/([a-z])([A-Z])/g, '$1 $2') || name;
}

const SHORT_TAGS = {GrokBuild: 'bld', GrokChat: 'cht', GrokImagine: 'img'};

function productShort(product) {
    if (SHORT_TAGS[product])
        return SHORT_TAGS[product];
    const label = productLabel(product);
    return label.slice(0, 3).toLowerCase();
}

function productId(product) {
    const slug = String(product ?? 'usage').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `grok.${slug}`;
}

/**
 * Turn a billing payload into normalised quota records.
 * Accepts either the API envelope ({config: {...}}) or a bare config object.
 * Pure — no network, no GSettings.
 */
export function parseBilling(payload, meta = {}) {
    const config = payload?.config ?? payload ?? {};
    const quotas = [];

    const resetsAt =
        parseTimestamp(config?.currentPeriod?.end) ??
        parseTimestamp(config?.billingPeriodEnd);

    const products = Array.isArray(config?.productUsage) ? config.productUsage : [];
    for (const entry of products) {
        const percent = clampPercent(entry?.usagePercent);
        if (percent === null)
            continue;
        quotas.push({
            id: productId(entry?.product),
            provider: id,
            label: productLabel(entry?.product),
            short: productShort(entry?.product),
            percent,
            resetsAt,
            active: true,
            severity: 'normal',
            hidable: false,
        });
    }

    // The shared pool. Its products already sum to it, so it is optional in the
    // panel — but it is the number the limit actually applies to, so it always
    // appears in the menu.
    const poolPercent = clampPercent(config?.creditUsagePercent);
    if (poolPercent !== null) {
        quotas.push({
            id: 'grok.pool',
            provider: id,
            label: 'Credits',
            short: 'all',
            percent: poolPercent,
            resetsAt,
            active: true,
            severity: 'normal',
            hidable: false,
            // Redundant with the per-product gauges; shown only on request.
            optional: products.length > 0,
        });
    }

    // Pay-as-you-go overage, only meaningful once a cap has been set.
    const cap = Number(config?.onDemandCap?.val ?? 0);
    const used = Number(config?.onDemandUsed?.val ?? 0);
    if (Number.isFinite(cap) && cap > 0) {
        quotas.push({
            id: 'grok.on-demand',
            provider: id,
            label: 'On-demand',
            short: 'od',
            percent: clampPercent((used / cap) * 100) ?? 0,
            resetsAt,
            active: true,
            severity: 'normal',
            hidable: false,
        });
    }

    const periodType = String(config?.currentPeriod?.type ?? '')
        .replace('USAGE_PERIOD_TYPE_', '')
        .toLowerCase();

    return {
        quotas,
        meta: {
            plan: meta.plan ?? payload?.subscriptionTier ?? payload?.subscription_tier ?? null,
            tier: periodType ? `${periodType} period` : null,
        },
    };
}

export async function fetchQuota({session, cancellable}) {
    const auth = await readJson(authPath(), cancellable);
    const entry = selectAuthEntry(auth);

    if (!entry?.key) {
        return {ok: false, authState: 'missing', error: 'Not signed in to Grok'};
    }

    const expiresAt = parseTimestamp(entry.expires_at);
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
        // Never refresh: the CLI guards rotation behind ~/.grok/auth.json.lock
        // and racing it can invalidate a running grok session.
        return {
            ok: false,
            authState: 'expired',
            error: 'Grok token expired — run grok to refresh it',
        };
    }

    const [baseUrl, version] = await Promise.all([
        resolveBaseUrl(cancellable),
        detectVersion(cancellable),
    ]);

    let payload;
    try {
        payload = await getJson(session, `${baseUrl}/billing?format=credits`, {
            cancellable,
            headers: {
                'Authorization': `Bearer ${entry.key}`,
                'x-grok-client-identifier': 'grok-shell',
                'x-grok-client-version': version,
                'Accept': 'application/json',
            },
        });
    } catch (e) {
        if (e instanceof HttpError && e.isAuthFailure)
            return {ok: false, authState: 'rejected', error: 'Grok credentials rejected'};
        throw e;
    }

    const {quotas, meta} = parseBilling(payload);
    return {ok: true, source: 'api', quotas, meta, fetchedAt: new Date()};
}

/**
 * Extract the most recent billing record out of a chunk of unified.jsonl.
 * Pure, so the tests can feed it a fixture.
 */
export function parseLogTail(text) {
    if (!text)
        return null;

    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes(LOG_MARKER))
            continue;
        // The first line of a tailed chunk is usually truncated; JSON.parse
        // rejecting it is exactly the behaviour we want.
        let record;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        const ctx = record?.ctx;
        if (!ctx?.config)
            continue;

        const {quotas, meta} = parseBilling(
            {config: ctx.config, subscriptionTier: ctx.subscriptionTier},
            {plan: ctx.subscriptionTier ?? null}
        );
        if (quotas.length === 0)
            continue;

        return {
            ok: true,
            source: 'log',
            stale: true,
            quotas,
            meta,
            fetchedAt: parseTimestamp(record?.ts),
        };
    }
    return null;
}

/**
 * Offline fallback. Reads only the tail of the log — it is already megabytes
 * and grows forever, and this runs on the shell's main loop.
 */
export async function readLogFallback(cancellable) {
    const text = await readTail(logPath(), 256 * 1024, cancellable);
    return parseLogTail(text);
}
