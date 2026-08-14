import GLib from 'gi://GLib';

/**
 * Parsing and presentation helpers.
 *
 * Deliberately free of any `resource:///org/gnome/shell/...` import so the
 * provider parsers that depend on this can be exercised headlessly by
 * `gjs -m test/parsers.js`.
 */

/**
 * Parse a timestamp into a Date, tolerating every shape the three upstreams use.
 *
 * The unit conventions differ per source and mixing them is the easiest way to
 * be wrong by a factor of 1000 or by decades:
 *   - Anthropic /api/oauth/usage  -> ISO 8601 string
 *   - Anthropic statusline stdin  -> epoch SECONDS
 *   - Anthropic rate-limit headers-> epoch SECONDS
 *   - Anthropic .credentials.json -> epoch MILLISECONDS
 *   - xAI billing                 -> ISO 8601 string
 *
 * Numbers are disambiguated by magnitude rather than by trusting the caller.
 */
export function parseTimestamp(value) {
    if (value === null || value === undefined)
        return null;

    if (value instanceof Date)
        return Number.isNaN(value.getTime()) ? null : value;

    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0)
            return null;
        // 1e12 sits between "year 33658 in seconds" and "September 2001 in ms",
        // so anything above it is milliseconds and anything below is seconds.
        const ms = value > 1e12 ? value : value * 1000;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '')
            return null;
        // Bare digits arrive as strings from some JSON encoders.
        if (/^\d+$/.test(trimmed))
            return parseTimestamp(Number(trimmed));
        // xAI emits 6-digit fractional seconds, which Date handles, but some
        // payloads carry more precision than JS accepts. Clamp to milliseconds.
        const normalised = trimmed.replace(/(\.\d{3})\d+/, '$1');
        const d = new Date(normalised);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    return null;
}

/**
 * Coerce a percentage into 0..100, or null when the value is unusable.
 *
 * Guards null/''/[] explicitly: `Number(null)` is 0, which would silently turn
 * "this window reported nothing" into "this window is empty". Those two states
 * must never collapse — an empty gauge is a claim, and we should only make it
 * when the upstream actually said zero.
 */
export function clampPercent(value) {
    if (value === null || value === undefined || typeof value === 'boolean')
        return null;
    if (typeof value === 'string' && value.trim() === '')
        return null;
    if (typeof value === 'object')
        return null;

    const n = Number(value);
    if (!Number.isFinite(n))
        return null;
    return Math.min(100, Math.max(0, n));
}

/**
 * "4h 48m", "2d 15h", "38s", or null when there is nothing to count down to.
 * Returns "now" once the deadline has passed, since a negative countdown is
 * never what the user wants to read.
 */
export function formatDuration(target, now = new Date()) {
    if (!target)
        return null;

    let seconds = Math.round((target.getTime() - now.getTime()) / 1000);
    if (seconds <= 0)
        return 'now';

    const days = Math.floor(seconds / 86400);
    seconds -= days * 86400;
    const hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;

    if (days > 0)
        return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0)
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    if (minutes > 0)
        return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    return `${seconds}s`;
}

/** "Thursday 14 August 2026, 18:50" in the user's locale and timezone. */
export function formatAbsolute(target) {
    if (!target)
        return null;
    const dt = GLib.DateTime.new_from_unix_utc(Math.floor(target.getTime() / 1000));
    if (!dt)
        return null;
    const local = dt.to_local();
    // %A %e %B %Y, %H:%M -> weekday, day, month, year, 24h clock.
    return local.format('%A %e %B %Y, %H:%M').replace(/\s+/g, ' ').trim();
}

/** "just now", "3m ago", "2h ago" — for the age of a cached reading. */
export function formatAge(fetchedAt, now = new Date()) {
    if (!fetchedAt)
        return null;
    const seconds = Math.max(0, Math.round((now.getTime() - fetchedAt.getTime()) / 1000));
    if (seconds < 45)
        return 'just now';
    const d = formatDuration(new Date(now.getTime() + seconds * 1000), now);
    return d ? `${d} ago` : null;
}

/** Percentages are shown without decimals unless they would round away to zero. */
export function formatPercent(percent) {
    if (percent === null || percent === undefined)
        return '—';
    if (percent > 0 && percent < 1)
        return '<1%';
    return `${Math.round(percent)}%`;
}

/**
 * Map a percentage onto a severity band. Providers that report their own
 * severity take precedence over this; it is the fallback for the ones that
 * do not, and the definition of the colour bands for every provider.
 */
export function severityFor(percent, warn, critical) {
    if (percent === null || percent === undefined)
        return 'unknown';
    if (percent >= critical)
        return 'critical';
    if (percent >= warn)
        return 'warn';
    return 'normal';
}

/** Parse '#rrggbb' / '#rgb' into {r,g,b} floats in 0..1, or null. */
export function parseHexColor(hex) {
    if (typeof hex !== 'string')
        return null;
    let s = hex.trim().replace(/^#/, '');
    if (s.length === 3)
        s = s.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(s))
        return null;
    return {
        r: parseInt(s.slice(0, 2), 16) / 255,
        g: parseInt(s.slice(2, 4), 16) / 255,
        b: parseInt(s.slice(4, 6), 16) / 255,
    };
}
