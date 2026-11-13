#!/usr/bin/env python3
"""AI Quota for Waybar.

A Waybar custom module that shows how much of your Claude Code, Grok Build and
Codex subscription quotas you have used, as fill-level gauges. It is a port of
the AI Quota GNOME Shell extension in the parent directory and reuses the same
data sources, parsing rules, continuity handling and notification policy.

Python 3 standard library only. One process per provider:

    aiquota_waybar.py --provider claude          # continuous Waybar output
    aiquota_waybar.py --provider grok --once     # print one line and exit
    aiquota_waybar.py --refresh claude           # ask the running module to poll now

Waybar starts one copy of each custom module per monitor. Only one copy per
provider (whichever holds the lock) talks to the network, writes state and sends
notifications; the others render from the shared state file.

Readings only are ever written to disk. Tokens are read from the vendor CLIs'
own credential files, used for one request, and never logged or stored.
"""

import argparse
import ast
import fcntl
import html
import json
import math
import os
import random
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

# --------------------------------------------------------------------- paths


def home_path(*parts):
    return os.path.join(os.path.expanduser('~'), *parts)


def xdg_dir(env, *fallback):
    value = os.environ.get(env)
    return value if value and os.path.isabs(value) else home_path(*fallback)


def state_dir():
    return os.path.join(xdg_dir('XDG_STATE_HOME', '.local', 'state'), 'aiquota-waybar')


def config_path():
    return os.path.join(xdg_dir('XDG_CONFIG_HOME', '.config'), 'aiquota-waybar', 'config.json')


def gnome_state_path():
    """State written by the GNOME extension; read once to seed continuity."""
    return os.path.join(xdg_dir('XDG_STATE_HOME', '.local', 'state'), 'aiquota', 'state.json')


# ------------------------------------------------------------------ settings

# Same keys and defaults as org.gnome.shell.extensions.aiquota, except the
# colours, which follow the Tokyo Night palette the bar uses.
DEFAULT_SETTINGS = {
    'poll-interval': 300,
    'providers-enabled': ['claude', 'grok', 'codex'],
    'hidden-quotas': [],
    'auto-hide-inactive': True,
    'show-window-labels': False,
    'show-pool-totals': False,
    'warn-threshold': 75,
    'critical-threshold': 90,
    'notifications-enabled': True,
    'color-normal': '#9ece6a',
    'color-warn': '#e0af68',
    'color-critical': '#f7768e',
    'color-track': '#2f334d',
    'color-dim': '#565f89',
}


def parse_gvariant(text):
    """The few GVariant text forms `gsettings get` prints for this schema."""
    text = text.strip()
    if text.startswith('@as '):
        text = text[4:]
    if text in ('true', 'false'):
        return text == 'true'
    try:
        return ast.literal_eval(text)
    except (ValueError, SyntaxError):
        return None


def import_gnome_settings(schemadir=None):
    """Read the GNOME extension's GSettings, keeping the Waybar colours."""
    base = ['gsettings']
    if schemadir:
        base += ['--schemadir', schemadir]
    settings = {}
    for key, default in DEFAULT_SETTINGS.items():
        if key.startswith('color-'):
            continue
        try:
            out = subprocess.run(base + ['get', 'org.gnome.shell.extensions.aiquota', key],
                                 capture_output=True, text=True, timeout=10, check=True).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        value = parse_gvariant(out)
        if type(value) is type(default):
            settings[key] = value
    return settings


def load_settings(path=None):
    settings = dict(DEFAULT_SETTINGS)
    data = read_json(path or config_path())
    if isinstance(data, dict):
        for key, value in data.items():
            if key in settings and type(value) is type(settings[key]):
                settings[key] = value
    return settings


# ------------------------------------------------------------------- file io


def read_text(path):
    try:
        with open(path, encoding='utf-8') as handle:
            return handle.read()
    except (OSError, UnicodeDecodeError):
        return None


def read_json(path):
    """Parsed JSON, or None on any failure. Never raises."""
    text = read_text(path)
    if text is None:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def read_tail(path, max_bytes=256 * 1024):
    """The last `max_bytes` of a file; the first line is usually partial."""
    try:
        with open(path, 'rb') as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - max_bytes))
            return handle.read().decode('utf-8', errors='replace')
    except OSError:
        return None


def write_private(path, text):
    """Atomic write with 0600 permissions. Readings only, never tokens."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f'{path}.{os.getpid()}.tmp'
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(text)
        os.replace(tmp, path)
        return True
    except OSError as exc:
        log(f'could not write {path}: {exc}')
        return False


def mtime(path):
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return None


def log(message):
    print(f'aiquota: {message}', file=sys.stderr, flush=True)


# ---------------------------------------------------------------- formatting


def js_round(value):
    """Math.round: halves go up, unlike Python's banker's rounding."""
    return math.floor(value + 0.5)


def parse_timestamp(value):
    """Parse every timestamp shape the upstreams use into an aware UTC datetime.

    Numbers are disambiguated by magnitude: above 1e12 is epoch milliseconds
    (.credentials.json), below is epoch seconds (statusline, headers).
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or value <= 0:
            return None
        seconds = value / 1000 if value > 1e12 else value
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if re.fullmatch(r'\d+', text):
            return parse_timestamp(int(text))
        # Clamp sub-millisecond precision to milliseconds, as JS Date does.
        text = re.sub(r'(\.\d{3})\d+', r'\1', text)
        if text.endswith(('Z', 'z')):
            text = text[:-1] + '+00:00'
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.astimezone()  # JS reads offset-less times as local
        return parsed.astimezone(timezone.utc)
    return None


def iso(dt):
    """Date.prototype.toISOString(): millisecond precision, Z suffix."""
    if dt is None:
        return None
    dt = dt.astimezone(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def clamp_percent(value):
    """0..100, or None when unusable. None/''/objects never become 0."""
    if value is None or isinstance(value, (bool, dict, list)):
        return None
    if isinstance(value, str) and not value.strip():
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return min(100.0, max(0.0, number))


def now_utc():
    return datetime.now(timezone.utc)


def format_duration(target, now=None):
    """'4h 48m', '2d 15h', '38s', 'now' once passed, None without a target."""
    if target is None:
        return None
    now = now or now_utc()
    seconds = js_round((target - now).total_seconds())
    if seconds <= 0:
        return 'now'
    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    if days:
        return f'{days}d {hours}h' if hours else f'{days}d'
    if hours:
        return f'{hours}h {minutes}m' if minutes else f'{hours}h'
    if minutes:
        return f'{minutes}m {seconds}s' if seconds else f'{minutes}m'
    return f'{seconds}s'


def format_absolute(target):
    """'Thursday 14 August 2026, 18:50' in local time."""
    if target is None:
        return None
    local = target.astimezone()
    text = f"{local.strftime('%A')} {local.day} {local.strftime('%B %Y, %H:%M')}"
    return re.sub(r'\s+', ' ', text).strip()


def format_age(fetched_at, now=None):
    if fetched_at is None:
        return None
    now = now or now_utc()
    seconds = max(0, js_round((now - fetched_at).total_seconds()))
    if seconds < 45:
        return 'just now'
    duration = format_duration(now + timedelta(seconds=seconds), now)
    return f'{duration} ago' if duration else None


def format_percent(percent):
    if percent is None:
        return '—'
    if 0 < percent < 1:
        return '<1%'
    return f'{js_round(percent)}%'


def severity_for(percent, warn, critical):
    if percent is None:
        return 'unknown'
    if percent >= critical:
        return 'critical'
    if percent >= warn:
        return 'warn'
    return 'normal'


SEVERITY_RANK = {'normal': 0, 'warn': 1, 'critical': 2}


def resolve_severity(quota, warn, critical):
    """The stronger of the provider's own severity and the threshold bands."""
    local = severity_for(quota.get('percent'), warn, critical)
    if local == 'unknown':
        return 'unknown'
    own = quota.get('severity') or 'normal'
    return own if SEVERITY_RANK.get(own, 0) > SEVERITY_RANK.get(local, 0) else local


# ------------------------------------------------------------------- http


class HttpError(Exception):
    def __init__(self, status, reason=''):
        super().__init__(f'HTTP {status} {reason}'.strip())
        self.status = status

    @property
    def is_auth_failure(self):
        return self.status in (401, 403)


def get_json(url, headers, timeout=10):
    request = urllib.request.Request(url, headers=headers, method='GET')
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError as exc:
        raise HttpError(exc.code, exc.reason) from None
    try:
        return json.loads(body)
    except ValueError:
        preview = re.sub(r'\s+', ' ', body[:120])
        raise ValueError(f'Expected JSON from {url} but got: {preview}') from None


# ---------------------------------------------------------------- providers


def quota(qid, provider, label, short, percent, resets_at, active,
          severity='normal', hidable=False, **extra):
    record = {
        'id': qid, 'provider': provider, 'label': label, 'short': short,
        'percent': percent, 'resetsAt': resets_at, 'active': active,
        'severity': severity, 'hidable': hidable,
    }
    record.update(extra)
    return record


def coalesce(*values):
    """JavaScript's `??`: the first value that is not None."""
    return next((v for v in values if v is not None), None)


def slug(value):
    return re.sub(r'[^a-z0-9]+', '-', str(value).lower())


class Claude:
    """Claude Code: GET https://api.anthropic.com/api/oauth/usage (the /usage
    endpoint). Undocumented, so every field is optional."""

    id = 'claude'
    label = 'Claude Code'
    glyph = 'C'
    unverified = False

    USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
    OAUTH_BETA = 'oauth-2025-04-20'
    FALLBACK_VERSION = '2.1.232'
    SEVERITY = {'normal': 0, 'warn': 1, 'warning': 1, 'critical': 2, 'severe': 2}
    LEGACY_WINDOWS = [
        ('five_hour', 'Session', '5h'),
        ('seven_day', 'Weekly', 'wk'),
        ('seven_day_opus', 'Weekly · Opus', 'wk'),
        ('seven_day_sonnet', 'Weekly · Sonnet', 'wk'),
        ('seven_day_oauth_apps', 'Weekly · OAuth apps', 'wk'),
        ('seven_day_cowork', 'Weekly · Cowork', 'wk'),
    ]

    @staticmethod
    def credential_path():
        return home_path('.claude', '.credentials.json')

    @staticmethod
    def global_config_path():
        return home_path('.claude.json')

    def watch_paths(self):
        return [self.credential_path()]

    def detect(self):
        return os.path.exists(self.credential_path())

    def detect_version(self):
        try:
            base = os.path.basename(os.readlink(home_path('.local', 'bin', 'claude')))
            if re.match(r'^\d+\.\d+\.\d+', base):
                return base
        except OSError:
            pass
        try:
            names = [n for n in os.listdir(home_path('.local', 'share', 'claude', 'versions'))
                     if re.fullmatch(r'\d+\.\d+\.\d+', n)]
            if names:
                return max(names, key=lambda n: tuple(int(p) for p in n.split('.')))
        except OSError:
            pass
        return self.FALLBACK_VERSION

    @classmethod
    def api_severity(cls, value):
        rank = cls.SEVERITY.get(str(value if value is not None else '').lower())
        return 'critical' if rank == 2 else 'warn' if rank == 1 else 'normal'

    @staticmethod
    def _scope_name(limit, for_id):
        scope = limit.get('scope') if isinstance(limit.get('scope'), dict) else {}
        model = scope.get('model') if isinstance(scope.get('model'), dict) else {}
        surface = scope.get('surface')
        if for_id:
            candidates = [model.get('id'), model.get('display_name'),
                          surface if not isinstance(surface, dict) else None]
        else:
            candidates = [model.get('display_name'),
                          surface.get('display_name') if isinstance(surface, dict) else None,
                          surface if not isinstance(surface, dict) else None]
        return next((c for c in candidates if c is not None), None)

    @classmethod
    def describe_limit(cls, limit):
        kind = str(limit.get('kind') or '')
        scope_name = cls._scope_name(limit, for_id=False)
        if kind == 'session':
            return 'Session', '5h'
        if kind == 'weekly_all':
            return 'Weekly', 'wk'
        if kind == 'weekly_scoped':
            return (f'Weekly · {scope_name}', 'wk') if scope_name else ('Weekly (scoped)', 'wk')
        pretty = kind.replace('_', ' ') if kind else 'Limit'
        pretty = pretty[:1].upper() + pretty[1:]
        return (f'{pretty} · {scope_name}' if scope_name else pretty), None

    @classmethod
    def limit_id(cls, limit, index):
        kind = str(limit.get('kind') or f'limit{index}')
        scope_name = cls._scope_name(limit, for_id=True)
        return f'claude.{kind}' + (f'.{slug(scope_name)}' if scope_name else '')

    @classmethod
    def parse_usage(cls, payload, meta=None):
        meta = meta or {}
        payload = payload if isinstance(payload, dict) else {}
        quotas = []
        limits = payload.get('limits') if isinstance(payload.get('limits'), list) else None

        if limits:
            for index, limit in enumerate(limits):
                limit = limit if isinstance(limit, dict) else {}
                percent = clamp_percent(limit.get('percent'))
                if percent is None:
                    continue
                label, short = cls.describe_limit(limit)
                resets_at = parse_timestamp(limit.get('resets_at'))
                active = limit.get('is_active') is True
                quotas.append(quota(
                    cls.limit_id(limit, index), 'claude', label, short, percent, resets_at,
                    active, cls.api_severity(limit.get('severity')),
                    hidable=percent == 0 and not active and resets_at is None))
        else:
            for key, label, short in cls.LEGACY_WINDOWS:
                entry = payload.get(key) if isinstance(payload.get(key), dict) else {}
                percent = clamp_percent(entry.get('utilization'))
                if percent is None:
                    continue
                resets_at = parse_timestamp(entry.get('resets_at'))
                quotas.append(quota(
                    f'claude.{key}', 'claude', label, short, percent, resets_at,
                    key == 'five_hour', hidable=percent == 0 and resets_at is None))

        spend = payload.get('spend') if isinstance(payload.get('spend'), dict) else {}
        extra = payload.get('extra_usage') if isinstance(payload.get('extra_usage'), dict) else {}
        if spend.get('enabled') is True or extra.get('is_enabled') is True:
            raw = spend.get('percent')
            percent = clamp_percent(raw if raw is not None else extra.get('utilization'))
            if percent is not None:
                reset = spend.get('resets_at')
                quotas.append(quota(
                    'claude.spend', 'claude', 'Extra usage', '$', percent,
                    parse_timestamp(reset if reset is not None else extra.get('resets_at')),
                    True, cls.api_severity(spend.get('severity'))))

        return {'quotas': quotas, 'meta': {'plan': meta.get('plan'), 'tier': meta.get('tier')}}

    def fetch_quota(self):
        creds = read_json(self.credential_path())
        oauth = creds.get('claudeAiOauth') if isinstance(creds, dict) else None
        oauth = oauth if isinstance(oauth, dict) else {}
        token = oauth.get('accessToken')
        if not token:
            return {'ok': False, 'authState': 'missing', 'error': 'Not signed in to Claude Code'}

        expires_at = parse_timestamp(oauth.get('expiresAt'))
        if expires_at and expires_at <= now_utc():
            # Claude Code owns this token's lifecycle; never refresh it here.
            return {'ok': False, 'authState': 'expired',
                    'error': 'Claude Code token expired — run claude to refresh it'}

        try:
            payload = get_json(self.USAGE_URL, {
                'Authorization': f'Bearer {token}',
                'anthropic-beta': self.OAUTH_BETA,
                # A generic User-Agent lands in a heavily throttled pool.
                'User-Agent': f'claude-cli/{self.detect_version()} (external, cli)',
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            })
        except HttpError as exc:
            if exc.is_auth_failure:
                return {'ok': False, 'authState': 'rejected',
                        'error': 'Claude Code credentials rejected'}
            raise
        parsed = self.parse_usage(payload, {'plan': oauth.get('subscriptionType'),
                                            'tier': oauth.get('rateLimitTier')})
        return {'ok': True, 'source': 'api', **parsed, 'fetchedAt': now_utc()}

    def read_fallback(self):
        """Claude Code caches its last reading in ~/.claude.json."""
        config = read_json(self.global_config_path())
        if not isinstance(config, dict):
            return None
        cached = config.get('cachedUsageUtilization')
        if not isinstance(cached, dict) or not cached.get('utilization'):
            return None
        account = config.get('oauthAccount') if isinstance(config.get('oauthAccount'), dict) else {}
        plan = account.get('userRateLimitTier')
        parsed = self.parse_usage(cached['utilization'], {'plan': plan})
        if not parsed['quotas']:
            return None
        return {'ok': True, 'source': 'cache', 'stale': True, 'quotas': parsed['quotas'],
                'meta': {'plan': plan, 'tier': None},
                'fetchedAt': parse_timestamp(cached.get('fetchedAtMs'))}


class Grok:
    """Grok Build: GET <base>/billing?format=credits, the CLI's /usage endpoint.
    Offline fallback: the CLI logs the billing payload to unified.jsonl."""

    id = 'grok'
    label = 'Grok Build'
    glyph = 'G'
    unverified = False

    DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'
    FALLBACK_VERSION = '1.0.3'
    LOG_MARKER = 'billing: fetched credits config'
    SHORT_TAGS = {'GrokBuild': 'bld', 'GrokChat': 'cht', 'GrokImagine': 'img'}

    @staticmethod
    def auth_path():
        return home_path('.grok', 'auth.json')

    @staticmethod
    def log_path():
        return home_path('.grok', 'logs', 'unified.jsonl')

    def watch_paths(self):
        return [self.auth_path()]

    def detect(self):
        return os.path.exists(self.auth_path()) or os.path.exists(self.log_path())

    def resolve_base_url(self):
        env = os.environ.get('GROK_CLI_CHAT_PROXY_BASE_URL') or os.environ.get('CLI_CHAT_PROXY_BASE_URL')
        if env:
            return env.rstrip('/')
        toml = read_text(home_path('.grok', 'config.toml'))
        if toml:
            match = re.search(r'^\s*cli_chat_proxy_base_url\s*=\s*["\']([^"\']+)["\']', toml, re.M)
            if match:
                return match.group(1).rstrip('/')
        return self.DEFAULT_BASE_URL

    def detect_version(self):
        info = read_json(home_path('.grok', 'version.json'))
        version = info.get('version') if isinstance(info, dict) else None
        return version or self.FALLBACK_VERSION

    @staticmethod
    def select_auth_entry(auth):
        """auth.json is keyed by '<issuer>::<client_id>'; prefer an unexpired entry."""
        if not isinstance(auth, dict):
            return None
        entries = [e for e in auth.values() if isinstance(e, dict) and isinstance(e.get('key'), str)]
        if not entries:
            return None
        now = now_utc()
        for entry in entries:
            exp = parse_timestamp(entry.get('expires_at'))
            if exp is None or exp > now:
                return entry
        return entries[0]

    @staticmethod
    def product_label(product):
        name = str(product if product is not None else '').strip()
        if not name:
            return 'Usage'
        stripped = re.sub(r'^Grok(?=[A-Z])', '', name)
        return re.sub(r'([a-z])([A-Z])', r'\1 \2', stripped) or name

    @classmethod
    def product_short(cls, product):
        if product in cls.SHORT_TAGS:
            return cls.SHORT_TAGS[product]
        return cls.product_label(product)[:3].lower()

    @staticmethod
    def product_id(product):
        return 'grok.' + slug(product if product is not None else 'usage')

    @classmethod
    def parse_billing(cls, payload, meta=None):
        meta = meta or {}
        payload = payload if isinstance(payload, dict) else {}
        config = payload.get('config') if isinstance(payload.get('config'), dict) else payload
        quotas = []

        period = config.get('currentPeriod') if isinstance(config.get('currentPeriod'), dict) else {}
        resets_at = parse_timestamp(period.get('end')) or parse_timestamp(config.get('billingPeriodEnd'))

        products = config.get('productUsage') if isinstance(config.get('productUsage'), list) else []
        for entry in products:
            entry = entry if isinstance(entry, dict) else {}
            percent = clamp_percent(entry.get('usagePercent'))
            if percent is None:
                continue
            product = entry.get('product')
            quotas.append(quota(cls.product_id(product), 'grok', cls.product_label(product),
                                cls.product_short(product), percent, resets_at, True))

        pool = clamp_percent(config.get('creditUsagePercent'))
        if pool is not None:
            # Redundant with the per-product gauges, so optional in the bar.
            quotas.append(quota('grok.pool', 'grok', 'Credits', 'all', pool, resets_at, True,
                                optional=len(products) > 0))

        def val(key):
            box = config.get(key) if isinstance(config.get(key), dict) else {}
            try:
                return float(box.get('val') or 0)
            except (TypeError, ValueError):
                return float('nan')

        cap, used = val('onDemandCap'), val('onDemandUsed')
        if math.isfinite(cap) and cap > 0:
            percent = clamp_percent(used / cap * 100)
            quotas.append(quota('grok.on-demand', 'grok', 'On-demand', 'od',
                                percent if percent is not None else 0, resets_at, True))

        period_type = str(period.get('type') or '').replace('USAGE_PERIOD_TYPE_', '').lower()
        plan = coalesce(meta.get('plan'), payload.get('subscriptionTier'), payload.get('subscription_tier'))
        return {'quotas': quotas,
                'meta': {'plan': plan, 'tier': f'{period_type} period' if period_type else None}}

    def fetch_quota(self):
        entry = self.select_auth_entry(read_json(self.auth_path()))
        if not entry or not entry.get('key'):
            return {'ok': False, 'authState': 'missing', 'error': 'Not signed in to Grok'}
        expires_at = parse_timestamp(entry.get('expires_at'))
        if expires_at and expires_at <= now_utc():
            # Never refresh: the CLI guards rotation with auth.json.lock.
            return {'ok': False, 'authState': 'expired',
                    'error': 'Grok token expired — run grok to refresh it'}
        try:
            payload = get_json(f'{self.resolve_base_url()}/billing?format=credits', {
                'Authorization': f"Bearer {entry['key']}",
                'x-grok-client-identifier': 'grok-shell',
                'x-grok-client-version': self.detect_version(),
                'Accept': 'application/json',
            })
        except HttpError as exc:
            if exc.is_auth_failure:
                return {'ok': False, 'authState': 'rejected', 'error': 'Grok credentials rejected'}
            raise
        return {'ok': True, 'source': 'api', **self.parse_billing(payload), 'fetchedAt': now_utc()}

    @classmethod
    def parse_log_tail(cls, text):
        if not text:
            return None
        for line in reversed(text.split('\n')):
            if cls.LOG_MARKER not in line:
                continue
            try:
                record = json.loads(line)  # the truncated first line fails here, as intended
            except ValueError:
                continue
            ctx = record.get('ctx') if isinstance(record, dict) else None
            if not isinstance(ctx, dict) or not ctx.get('config'):
                continue
            parsed = cls.parse_billing({'config': ctx['config'], 'subscriptionTier': ctx.get('subscriptionTier')},
                                       {'plan': ctx.get('subscriptionTier')})
            if not parsed['quotas']:
                continue
            return {'ok': True, 'source': 'log', 'stale': True, **parsed,
                    'fetchedAt': parse_timestamp(record.get('ts'))}
        return None

    def read_fallback(self):
        return self.parse_log_tail(read_tail(self.log_path()))


class Codex:
    """OpenAI Codex: GET https://chatgpt.com/backend-api/wham/usage.
    UNVERIFIED against a live account, as in the GNOME extension."""

    id = 'codex'
    label = 'Codex'
    glyph = 'X'
    unverified = True

    API_BASE_URL = 'https://chatgpt.com'
    USAGE_PATH = '/backend-api/wham/usage'
    PERCENT_KEYS = ['used_percent', 'percent', 'percentage', 'usage_percent',
                    'percent_used', 'utilization']

    @staticmethod
    def auth_path():
        home = os.environ.get('CODEX_HOME') or home_path('.codex')
        return os.path.join(home, 'auth.json')

    def watch_paths(self):
        return [self.auth_path()]

    def detect(self):
        return os.path.exists(self.auth_path())

    @classmethod
    def find_percent(cls, window):
        if not isinstance(window, dict):
            return None
        for key in cls.PERCENT_KEYS:
            percent = clamp_percent(window.get(key))
            if percent is not None:
                return percent

        def number(*keys):
            for key in keys:
                if window.get(key) is not None:
                    try:
                        return float(window[key])
                    except (TypeError, ValueError):
                        return float('nan')
            return float('nan')

        used, limit = number('used', 'usage', 'consumed'), number('limit', 'quota', 'max')
        if math.isfinite(used) and math.isfinite(limit) and limit > 0:
            return clamp_percent(used / limit * 100)
        return None

    @staticmethod
    def find_reset(window, now):
        if not isinstance(window, dict):
            return None
        absolute = parse_timestamp(coalesce(window.get('reset_at'), window.get('resets_at')))
        if absolute:
            return absolute
        raw = coalesce(window.get('reset_after_seconds'), window.get('resets_in_seconds'))
        try:
            seconds = float(raw)
        except (TypeError, ValueError):
            return None
        if math.isfinite(seconds) and seconds > 0:
            return datetime.fromtimestamp(now + seconds, tz=timezone.utc)
        return None

    @staticmethod
    def describe_window(window, fallback_label, fallback_short):
        window = window if isinstance(window, dict) else {}
        seconds = coalesce(window.get('window_seconds'), window.get('limit_window_seconds'))
        if seconds is None:
            try:
                seconds = float(window.get('window_minutes')) * 60
            except (TypeError, ValueError):
                seconds = None
        try:
            seconds = float(seconds)
        except (TypeError, ValueError):
            return fallback_label, fallback_short
        if not math.isfinite(seconds) or seconds <= 0:
            return fallback_label, fallback_short
        hours = js_round(seconds / 3600)
        if hours >= 24 * 6:
            days = js_round(seconds / 86400)
            return ('Weekly' if days == 7 else f'{days}-day'), 'wk'
        if hours >= 1:
            return f'{hours}-hour', f'{hours}h'
        return fallback_label, fallback_short

    @classmethod
    def parse_usage(cls, payload, now=None):
        now = time.time() if now is None else now
        payload = payload if isinstance(payload, dict) else {}
        section = coalesce(payload.get('rate_limit'), payload.get('rate_limits'), {})
        section = section if isinstance(section, dict) else {}
        quotas = []

        def pick(*keys):
            for key in keys:
                if section.get(key) is not None:
                    return section[key]
            return None

        for window, fallback_label, fallback_short, active in [
                (pick('primary_window', 'primary'), 'Session', '5h', True),
                (pick('secondary_window', 'secondary'), 'Weekly', 'wk', False)]:
            percent = cls.find_percent(window)
            if percent is None:
                continue
            label, short = cls.describe_window(window, fallback_label, fallback_short)
            quotas.append(quota(f'codex.{fallback_label.lower()}', 'codex', label, short,
                                percent, cls.find_reset(window, now), active))

        review = payload.get('code_review_rate_limit')
        if isinstance(review, dict):
            review_window = coalesce(review.get('primary_window'), review.get('primary'), review)
        else:
            review_window = review
        review_percent = cls.find_percent(review_window)
        if review_percent is not None:
            quotas.append(quota('codex.code-review', 'codex', 'Code review', 'rev', review_percent,
                                cls.find_reset(review_window, now), False,
                                hidable=review_percent == 0))

        for index, item in enumerate(payload.get('additional_rate_limits') or []):
            item = item if isinstance(item, dict) else {}
            rate = item.get('rate_limit')
            window = coalesce(rate.get('primary_window') if isinstance(rate, dict) else None, rate, item)
            percent = cls.find_percent(window)
            if percent is None:
                continue
            name = item.get('limit_name') or f'Limit {index + 1}'
            quotas.append(quota(f'codex.{slug(name)}', 'codex', str(name).replace('_', ' '), None,
                                percent, cls.find_reset(window, now), False, hidable=percent == 0))

        credits = payload.get('credits') if isinstance(payload.get('credits'), dict) else {}
        return {'quotas': quotas, 'meta': {
            'plan': payload.get('plan_type'),
            'tier': 'unlimited credits' if credits.get('unlimited') is True else None}}

    def fetch_quota(self):
        auth = read_json(self.auth_path())
        tokens = auth.get('tokens') if isinstance(auth, dict) else None
        tokens = tokens if isinstance(tokens, dict) else {}
        token = tokens.get('access_token')
        if not token:
            return {'ok': False, 'authState': 'missing', 'error': 'Not signed in to Codex'}
        headers = {
            'Authorization': f'Bearer {token}',
            'Accept': '*/*',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Referer': f'{self.API_BASE_URL}/codex/cloud/settings/analytics',
            'oai-language': 'en-US',
            'x-openai-target-path': self.USAGE_PATH,
            'x-openai-target-route': self.USAGE_PATH,
        }
        if tokens.get('account_id'):
            headers['chatgpt-account-id'] = tokens['account_id']
        try:
            payload = get_json(f'{self.API_BASE_URL}{self.USAGE_PATH}', headers)
        except HttpError as exc:
            if exc.is_auth_failure:
                return {'ok': False, 'authState': 'rejected',
                        'error': 'Codex credentials rejected — run codex to sign in again'}
            raise
        return {'ok': True, 'source': 'api', **self.parse_usage(payload), 'fetchedAt': now_utc()}

    def read_fallback(self):
        return None


PROVIDERS = {p.id: p for p in (Claude(), Grok(), Codex())}


# --------------------------------------------------------------- continuity

CARRY_FORWARD_SECONDS = 7 * 24 * 60 * 60


def merge_continuity(previous, incoming, now=None, max_age_seconds=CARRY_FORWARD_SECONDS):
    """Carry recently seen but now absent quotas forward at 0%, in their old
    positions. xAI omits zero-usage products, so GrokChat vanishes at every
    weekly reset; without this the gauges would reshuffle."""
    now = now or now_utc()
    previous = previous or []
    incoming = incoming or []
    incoming_by_id = {q['id']: q for q in incoming}
    current_reset = next((q['resetsAt'] for q in incoming if q.get('resetsAt')), None)
    merged, emitted = [], set()

    def emit_fresh(q):
        emitted.add(q['id'])
        merged.append({**q, 'lastSeenAt': now, 'carried': False})

    def emit_carried(q):
        last_seen = q.get('lastSeenAt')
        if not last_seen or (now - last_seen).total_seconds() > max_age_seconds:
            return
        emitted.add(q['id'])
        merged.append({**q, 'percent': 0, 'resetsAt': current_reset or q.get('resetsAt'),
                       'severity': 'normal', 'carried': True, 'lastSeenAt': last_seen})

    for q in previous:
        if q['id'] in emitted:
            continue
        if q['id'] in incoming_by_id:
            emit_fresh(incoming_by_id[q['id']])
        else:
            emit_carried(q)
    for q in incoming:
        if q['id'] not in emitted:
            emit_fresh(q)
    return merged


# ------------------------------------------------------------ notifications


def evaluate_thresholds(state, quotas, warn=75, critical=90):
    """Rising edge only: each level fires once, and re-arms only after usage
    falls back below it. Returns (next_state, [(quota, level), ...])."""
    incoming = state if isinstance(state, dict) else {}
    nxt, events = {}, []
    for q in quotas or []:
        previous = incoming.get(q['id'])
        prior = list(previous.get('fired', [])) if isinstance(previous, dict) and \
            isinstance(previous.get('fired'), list) else []
        percent = q.get('percent')
        if percent is None:
            nxt[q['id']] = {'fired': prior}
            continue
        fired = [lvl for lvl in prior if (lvl == 'critical' and percent >= critical) or
                 (lvl == 'warn' and percent >= warn)]
        level = 'critical' if percent >= critical else 'warn' if percent >= warn else None
        if level and level not in fired:
            fired.append(level)
            if level == 'critical' and 'warn' not in fired:
                fired.append('warn')
            events.append((q, level))
        nxt[q['id']] = {'fired': fired}
    return nxt, events


def notification_copy(q, level, provider_label):
    percent = q.get('percent')
    shown = js_round(percent) if isinstance(percent, (int, float)) and math.isfinite(percent) else None
    if shown is not None and shown >= 100:
        title = f"{provider_label}: {q['label']} exhausted"
    elif level == 'critical':
        title = f"{provider_label}: {q['label']} nearly exhausted"
    else:
        title = f"{provider_label}: {q['label']} running low"
    parts = [f'{format_percent(percent)} used.']
    if q.get('resetsAt'):
        parts.append(f"Resets in {format_duration(q['resetsAt'])} — {format_absolute(q['resetsAt'])}.")
    else:
        parts.append('No reset scheduled.')
    return title, ' '.join(parts)


def send_notification(title, body, level):
    try:
        subprocess.run(['notify-send', '--app-name=AI Quota',
                        '--icon=utilities-system-monitor-symbolic',
                        f"--urgency={'critical' if level == 'critical' else 'normal'}",
                        title, body], check=False, timeout=10,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as exc:
        log(f'notify-send failed: {exc}')


# --------------------------------------------------------------- rendering

GAUGE_CHARS = ' ▁▂▃▄▅▆▇█'


def gauge_char(percent):
    """Bottom-up fill. Any non-zero reading shows at least a sliver."""
    if percent is None or percent <= 0:
        return GAUGE_CHARS[0]
    return GAUGE_CHARS[max(1, min(8, math.ceil(percent / 100 * 8)))]


def color_for(severity, settings):
    return settings.get({'critical': 'color-critical', 'warn': 'color-warn'}.get(
        severity, 'color-normal'))


def collect(result, settings):
    """Every quota in the reading, annotated with severity and bar membership."""
    hidden = set(settings['hidden-quotas'])
    warn, critical = settings['warn-threshold'], settings['critical-threshold']
    entries = []
    for q in (result or {}).get('quotas') or []:
        in_bar = (q['id'] not in hidden and not (q.get('optional') and not settings['show-pool-totals'])
                  and not (settings['auto-hide-inactive'] and q.get('hidable')))
        entries.append({'quota': q, 'severity': resolve_severity(q, warn, critical), 'inBar': in_bar})
    return entries


def text_bar(percent, color, track, cells=12):
    filled = 0 if not percent else max(1, min(cells, js_round(percent / 100 * cells)))
    return (f'<span color="{color}">{"━" * filled}</span>'
            f'<span color="{track}">{"━" * (cells - filled)}</span>')


def render(provider, result, settings, now=None):
    """Waybar JSON for one provider: text, tooltip, class, percentage."""
    now = now or now_utc()
    esc = html.escape
    if result is None:
        return {'text': f'{esc(provider.glyph)} <span color="{settings["color-dim"]}">·</span>',
                'tooltip': f'<b>{esc(provider.label)}</b>\nWaiting for the first reading…',
                'class': ['unknown'], 'percentage': 0}

    state = 'error' if not result.get('ok') else 'stale' if result.get('stale') else 'ok'
    entries = collect(result, settings)
    bar = [e for e in entries if e['inBar']]

    # ---- bar text
    track = settings['color-track']
    pieces = []
    for e in bar:
        q = e['quota']
        attrs = f'color="{color_for(e["severity"], settings)}" background="{track}"'
        if state != 'ok':
            attrs += ' fgalpha="55%"'
        piece = f'<span {attrs}>{gauge_char(q["percent"])}</span>'
        if settings['show-window-labels'] and q.get('short'):
            piece += f'<span size="small" color="{settings["color-dim"]}">{esc(q["short"])}</span>'
        pieces.append(piece)
    if not pieces:
        pieces.append(f'<span color="{settings["color-dim"]}">{"!" if state == "error" else "·"}</span>')
    # The glyph takes its colour from style.css, keyed on the module's class.
    text = f'{esc(provider.glyph)} ' + ''.join(pieces)

    # ---- tooltip
    header = [esc(provider.label)]
    plan = (result.get('meta') or {}).get('plan')
    if plan:
        header.append(esc(str(plan)))
    if provider.unverified:
        header.append('unverified')
    lines = ['<b>' + ' · '.join(header) + '</b>']
    if not entries or not result.get('ok'):
        lines.append(esc(result.get('error') or 'No reading available'))
    for e in entries:
        q = e['quota']
        color = color_for(e['severity'], settings)
        name = esc(q['label']) + ('  · hidden' if not e['inBar'] else '')
        lines.append('')
        lines.append(f'{name}   <span color="{color}"><b>{format_percent(q["percent"])}</b></span> used')
        lines.append(text_bar(q['percent'], color, track))
        if q.get('resetsAt'):
            lines.append(f'Resets in {format_duration(q["resetsAt"], now)}'
                         f' · {esc(format_absolute(q["resetsAt"]))}')
        else:
            lines.append('No reset scheduled')
    age = format_age(result.get('fetchedAt'), now)
    lines.append('')
    if state != 'ok':
        lines.append(f'⚠ {esc(result["error"])}' if result.get('error')
                     else f'⚠ Last updated {age or "unknown"}')
    if result.get('ok'):
        note = f"{'Stale · ' if result.get('stale') else ''}{result.get('source') or 'unknown'}" \
               f" · updated {age or 'unknown'}"
    else:
        note = 'Unavailable'
    lines.append(f'<span color="{settings["color-dim"]}">{esc(note)} · right-click to refresh</span>')

    worst = max((SEVERITY_RANK.get(e['severity'], 0) for e in bar), default=0)
    classes = [['normal', 'warn', 'critical'][worst]]
    if state != 'ok':
        classes.append(state)
    percentage = max((q['quota']['percent'] for q in bar), default=0)
    return {'text': text, 'tooltip': '\n'.join(lines), 'class': classes,
            'percentage': js_round(percentage)}


# -------------------------------------------------------------- persistence


def quota_to_json(q):
    out = dict(q)
    for key in ('resetsAt', 'lastSeenAt'):
        out[key] = iso(q.get(key)) if q.get(key) else None
    return out


def quota_from_json(q):
    out = dict(q)
    out['resetsAt'] = parse_timestamp(q.get('resetsAt'))
    out['lastSeenAt'] = parse_timestamp(q.get('lastSeenAt'))
    return out


def result_to_json(result):
    if not result:
        return None
    return {**result, 'fetchedAt': iso(result.get('fetchedAt')),
            'quotas': [quota_to_json(q) for q in result.get('quotas') or []]}


def result_from_json(data):
    if not isinstance(data, dict):
        return None
    return {**data, 'fetchedAt': parse_timestamp(data.get('fetchedAt')),
            'quotas': [quota_from_json(q) for q in data.get('quotas') or [] if isinstance(q, dict)]}


def seed_from_gnome(provider_id):
    """Adopt the GNOME extension's last reading and notification state, so the
    first Hyprland login neither forgets a zero-usage gauge nor re-announces a
    threshold you already saw."""
    data = read_json(gnome_state_path())
    if not isinstance(data, dict) or data.get('version') != 1:
        return None, {}
    entry = (data.get('providers') or {}).get(provider_id)
    result = None
    if isinstance(entry, dict):
        result = result_from_json({'ok': True, 'source': entry.get('source') or 'cache',
                                   'stale': True, 'meta': entry.get('meta') or {},
                                   'fetchedAt': entry.get('fetchedAt'),
                                   'quotas': entry.get('quotas') or [], 'error': None})
    notify = {k: v for k, v in (data.get('notifyState') or {}).items()
              if k.startswith(f'{provider_id}.')}
    return result, notify


# ------------------------------------------------------------------ poller

MIN_INTERVAL_SECONDS = 180
BACKOFF_SECONDS = [60, 120, 300, 900]
TICK_SECONDS = 2
NEVER = float('inf')


def jittered(seconds):
    return seconds * (0.9 + random.random() * 0.2)


class Module:
    """One provider's poller and renderer."""

    def __init__(self, provider, settings, out=sys.stdout):
        self.provider = provider
        self.settings = settings
        self.out = out
        base = state_dir()
        self.state_path = os.path.join(base, f'{provider.id}.json')
        self.lock_path = os.path.join(base, f'{provider.id}.lock')
        self.refresh_path = os.path.join(base, f'{provider.id}.refresh')
        self.result = None
        self.notify_state = {}
        self.next_at = 0
        self.backoff_step = 0
        self.blocked = None
        self.watch_mtimes = {}
        self.state_mtime = None
        self.refresh_mtime = None
        self.lock_handle = None
        self.last_line = None

    # -- leadership -----------------------------------------------------

    def try_lead(self):
        if self.lock_handle:
            return True
        try:
            os.makedirs(state_dir(), exist_ok=True)
            handle = open(self.lock_path, 'a', encoding='utf-8')
        except OSError:
            return False
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()  # another copy (the other monitor's bar) is polling
            return False
        self.lock_handle = handle
        self.load_state()
        self.watch_mtimes = {p: mtime(p) for p in self.provider.watch_paths()}
        self.refresh_mtime = mtime(self.refresh_path)
        return True

    def close(self):
        if self.lock_handle:
            self.lock_handle.close()
            self.lock_handle = None

    # -- state ------------------------------------------------------------

    def load_state(self):
        data = read_json(self.state_path)
        self.state_mtime = mtime(self.state_path)
        if isinstance(data, dict) and data.get('version') == 1:
            result = result_from_json(data.get('result'))
            if result is not None:
                self.result = result
            self.notify_state = data.get('notifyState') or {}
            if self.lock_handle and data.get('nextAt'):
                # Respect the schedule of a previous leader rather than polling
                # again on every Waybar restart.
                # A blocked provider is retried once by a new leader instead,
                # since its credentials may have changed while nobody watched.
                self.next_at = min(float(data['nextAt']), time.time() + self.interval())
            return
        if self.result is None:
            self.result, self.notify_state = seed_from_gnome(self.provider.id)

    def save_state(self):
        write_private(self.state_path, json.dumps({
            'version': 1,
            'savedAt': iso(now_utc()),
            'result': result_to_json(self.result),
            'notifyState': self.notify_state,
            'nextAt': None if self.next_at == NEVER else self.next_at,
            'blocked': self.blocked,
        }))
        self.state_mtime = mtime(self.state_path)

    # -- polling -------------------------------------------------------------

    def interval(self):
        return max(MIN_INTERVAL_SECONDS, int(self.settings['poll-interval']))

    def enabled(self):
        return self.provider.id in self.settings['providers-enabled'] and self.provider.detect()

    def normalise(self, result, previous):
        return {'ok': True, 'source': result.get('source') or 'api',
                'stale': result.get('stale') is True,
                'quotas': merge_continuity((previous or {}).get('quotas') or [],
                                           result.get('quotas') or []),
                'meta': result.get('meta') or {},
                'fetchedAt': result.get('fetchedAt') or now_utc(), 'error': None}

    def apply_fallback(self, error):
        try:
            fallback = self.provider.read_fallback()
        except Exception as exc:  # noqa: BLE001 - a broken fallback must not kill the bar
            log(f'{self.provider.id} fallback failed: {exc}')
            fallback = None
        if fallback and fallback.get('ok'):
            self.result = {**self.normalise(fallback, self.result), 'stale': True, 'error': error}
        elif self.result:
            self.result = {**self.result, 'stale': True, 'error': error}
        else:
            self.result = {'ok': False, 'quotas': [], 'meta': {}, 'error': error,
                           'source': None, 'fetchedAt': None}

    def fetch(self):
        try:
            result = self.provider.fetch_quota()
            if result.get('ok'):
                self.result = self.normalise(result, self.result)
                self.backoff_step = 0
                self.blocked = None
                self.next_at = time.time() + jittered(self.interval())
                self.notify()
            else:
                # No timer fixes a bad token: stop until the credential file changes.
                self.blocked = result.get('authState') or 'rejected'
                self.next_at = NEVER
                self.apply_fallback(result.get('error'))
        except Exception as exc:  # noqa: BLE001 - network trouble, back off and retry
            delay = BACKOFF_SECONDS[min(self.backoff_step, len(BACKOFF_SECONDS) - 1)]
            self.backoff_step += 1
            self.next_at = time.time() + delay
            message = str(exc) or exc.__class__.__name__
            log(f'{self.provider.id} fetch failed (retry in {delay}s): {message}')
            if self.result:
                self.result = {**self.result, 'stale': True, 'error': message}
            else:
                self.apply_fallback(message)
        self.save_state()

    def notify(self):
        s = self.settings
        self.notify_state, events = evaluate_thresholds(
            self.notify_state, self.result['quotas'], s['warn-threshold'], s['critical-threshold'])
        if not s['notifications-enabled']:
            return
        for q, level in events:
            title, body = notification_copy(q, level, self.provider.label)
            send_notification(title, body, level)

    def check_triggers(self):
        for path, old in self.watch_mtimes.items():
            new = mtime(path)
            if new != old:
                # The vendor CLI just rewrote its credentials: unblock and poll.
                self.watch_mtimes[path] = new
                self.blocked, self.backoff_step, self.next_at = None, 0, 0
        new = mtime(self.refresh_path)
        if new != self.refresh_mtime:
            # "Refresh now" forces past a block and the backoff, like the menu item.
            self.refresh_mtime = new
            self.blocked, self.backoff_step, self.next_at = None, 0, 0

    def step(self):
        """One loop iteration: poll if due (leader) or re-read state (follower)."""
        if not self.enabled():
            self.emit({'text': '', 'tooltip': '', 'class': ['disabled']})
            return
        if self.try_lead():
            self.check_triggers()
            if not self.blocked and time.time() >= self.next_at:
                self.fetch()
        elif mtime(self.state_path) != self.state_mtime:
            self.load_state()
        self.emit(render(self.provider, self.result, self.settings))

    def emit(self, payload):
        line = json.dumps(payload, ensure_ascii=False)
        if line != self.last_line:
            self.last_line = line
            self.out.write(line + '\n')
            self.out.flush()

    def run(self):
        while True:
            self.step()
            time.sleep(TICK_SECONDS)


def request_refresh(provider_id):
    path = os.path.join(state_dir(), f'{provider_id}.refresh')
    os.makedirs(state_dir(), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(f'{time.time()}\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description='AI Quota gauges for Waybar.')
    parser.add_argument('--provider', choices=sorted(PROVIDERS))
    parser.add_argument('--once', action='store_true', help='print one reading and exit')
    parser.add_argument('--refresh', metavar='PROVIDER', choices=sorted(PROVIDERS),
                        help='ask the running module to poll now')
    parser.add_argument('--config', help=f'settings file (default {config_path()})')
    parser.add_argument('--import-gnome-settings', metavar='SCHEMADIR', nargs='?', const='',
                        help='print a settings file built from the GNOME extension\'s GSettings')
    args = parser.parse_args(argv)

    if args.import_gnome_settings is not None:
        imported = import_gnome_settings(args.import_gnome_settings or None)
        print(json.dumps({**DEFAULT_SETTINGS, **imported}, indent=2))
        return 0

    if args.refresh:
        request_refresh(args.refresh)
        return 0
    if not args.provider:
        parser.error('--provider is required')

    signal.signal(signal.SIGPIPE, signal.SIG_DFL)  # Waybar went away: exit quietly
    module = Module(PROVIDERS[args.provider], load_settings(args.config))
    if args.once:
        module.step()
        module.close()
        return 0
    try:
        module.run()
    except KeyboardInterrupt:
        return 0
    finally:
        module.close()


if __name__ == '__main__':
    sys.exit(main())
