"""Tests for the Waybar port: `python3 -m unittest discover -s waybar/tests`.

Ported from test/parsers.js and test/notify.js, against the same fixtures in
test/fixtures, plus tests for the Waybar-only parts (rendering, polling,
persistence and the one-poller-per-provider lock).
"""

import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, '..', '..', 'test', 'fixtures')

spec = importlib.util.spec_from_file_location(
    'aiquota_waybar', os.path.join(HERE, '..', 'aiquota_waybar.py'))
aq = importlib.util.module_from_spec(spec)
sys.modules['aiquota_waybar'] = aq
spec.loader.exec_module(aq)

claude, grok, codex = aq.Claude, aq.Grok, aq.Codex


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding='utf-8') as handle:
        return handle.read()


def load(name):
    return json.loads(fixture(name))


def by_id(quotas, qid):
    for q in quotas:
        if q['id'] == qid:
            return q
    raise AssertionError(f"no quota {qid} (have {[q['id'] for q in quotas]})")


def at(text):
    return aq.parse_timestamp(text)


def epoch(text):
    return at(text).timestamp()


class Timestamps(unittest.TestCase):
    def test_iso_with_sub_millisecond_precision(self):
        self.assertEqual(aq.iso(at('2026-08-14T18:50:00.487164+00:00')), '2026-08-14T18:50:00.487Z')

    def test_nine_digit_fraction_from_xai(self):
        self.assertEqual(aq.iso(at('2026-08-14T18:44:31.913980721Z')), '2026-08-14T18:44:31.913Z')

    def test_epoch_seconds_vs_milliseconds(self):
        seconds = aq.parse_timestamp(1786852800)
        millis = aq.parse_timestamp(1786744255443)
        self.assertEqual(seconds.year, 2026)
        self.assertEqual(millis.year, 2026)
        self.assertLess(abs((seconds - millis).total_seconds()), 60 * 60 * 24 * 60)

    def test_rejects_junk(self):
        for bad in [None, '', '  ', 'not a date', 0, -1, float('nan'), {}, [], True]:
            self.assertIsNone(aq.parse_timestamp(bad), repr(bad))

    def test_numeric_strings(self):
        self.assertEqual(aq.parse_timestamp('1786852800'), aq.parse_timestamp(1786852800))


class Formatting(unittest.TestCase):
    def test_clamp_percent(self):
        self.assertEqual(aq.clamp_percent(49), 49)
        self.assertEqual(aq.clamp_percent('31.5'), 31.5)
        self.assertEqual(aq.clamp_percent(-5), 0)
        self.assertEqual(aq.clamp_percent(140), 100)
        for bad in [None, 'abc', float('inf'), '', True, {}, []]:
            self.assertIsNone(aq.clamp_percent(bad), repr(bad))

    def test_format_duration_scales(self):
        now = at('2026-08-14T14:00:00Z')
        cases = {'2026-08-14T18:48:00Z': '4h 48m', '2026-08-17T05:00:00Z': '2d 15h',
                 '2026-08-14T14:00:38Z': '38s', '2026-08-14T14:03:00Z': '3m',
                 '2026-08-16T14:00:00Z': '2d', '2026-08-14T17:00:00Z': '3h'}
        for target, expected in cases.items():
            self.assertEqual(aq.format_duration(at(target), now), expected)

    def test_format_duration_never_negative(self):
        now = at('2026-08-14T14:00:00Z')
        self.assertEqual(aq.format_duration(at('2026-08-14T13:00:00Z'), now), 'now')
        self.assertIsNone(aq.format_duration(None, now))

    def test_format_percent(self):
        self.assertEqual(aq.format_percent(0), '0%')
        self.assertEqual(aq.format_percent(0.4), '<1%')
        self.assertEqual(aq.format_percent(48.6), '49%')
        self.assertEqual(aq.format_percent(2.5), '3%', 'halves round up, as in JS')
        self.assertEqual(aq.format_percent(None), '—')

    def test_format_absolute(self):
        with mock.patch.dict(os.environ, {'TZ': 'UTC'}):
            import time
            time.tzset()
            self.assertEqual(aq.format_absolute(at('2026-08-14T18:50:00Z')),
                             'Friday 14 August 2026, 18:50')
        time.tzset()

    def test_format_age(self):
        now = at('2026-08-14T14:00:00Z')
        self.assertEqual(aq.format_age(now - timedelta(seconds=10), now), 'just now')
        self.assertEqual(aq.format_age(now - timedelta(minutes=3), now), '3m ago')
        self.assertIsNone(aq.format_age(None, now))

    def test_severity_bands(self):
        self.assertEqual(aq.severity_for(10, 75, 90), 'normal')
        self.assertEqual(aq.severity_for(74.9, 75, 90), 'normal')
        self.assertEqual(aq.severity_for(75, 75, 90), 'warn')
        self.assertEqual(aq.severity_for(89.9, 75, 90), 'warn')
        self.assertEqual(aq.severity_for(90, 75, 90), 'critical')
        self.assertEqual(aq.severity_for(None, 75, 90), 'unknown')

    def test_provider_severity_wins_when_stronger(self):
        self.assertEqual(aq.resolve_severity({'percent': 30, 'severity': 'warn'}, 75, 90), 'warn')
        self.assertEqual(aq.resolve_severity({'percent': 95, 'severity': 'warn'}, 75, 90), 'critical')


class ClaudeParser(unittest.TestCase):
    def test_limits_preferred_over_named_windows(self):
        quotas = claude.parse_usage(load('claude-usage.json'))['quotas']
        self.assertEqual([q['id'] for q in quotas],
                         ['claude.session', 'claude.weekly_all', 'claude.weekly_scoped.fable'])

    def test_session_window(self):
        session = by_id(claude.parse_usage(load('claude-usage.json'))['quotas'], 'claude.session')
        self.assertEqual((session['label'], session['short'], session['percent']), ('Session', '5h', 9))
        self.assertTrue(session['active'])
        self.assertFalse(session['hidable'])
        self.assertEqual(aq.iso(session['resetsAt']), '2026-08-14T18:50:00.487Z')

    def test_scoped_weekly_named_after_model(self):
        scoped = by_id(claude.parse_usage(load('claude-usage.json'))['quotas'],
                       'claude.weekly_scoped.fable')
        self.assertEqual(scoped['label'], 'Weekly · Fable')
        self.assertIsNone(scoped['resetsAt'])

    def test_hidable(self):
        quotas = claude.parse_usage(load('claude-usage.json'))['quotas']
        self.assertTrue(by_id(quotas, 'claude.weekly_scoped.fable')['hidable'])
        self.assertFalse(by_id(quotas, 'claude.weekly_all')['hidable'])

    def test_disabled_spend(self):
        quotas = claude.parse_usage(load('claude-usage.json'))['quotas']
        self.assertFalse(any(q['id'] == 'claude.spend' for q in quotas))

    def test_legacy_fallback(self):
        quotas = claude.parse_usage(load('claude-usage-legacy.json'))['quotas']
        self.assertEqual([q['id'] for q in quotas],
                         ['claude.five_hour', 'claude.seven_day', 'claude.seven_day_opus', 'claude.spend'])
        self.assertEqual(by_id(quotas, 'claude.five_hour')['percent'], 82.5)
        self.assertTrue(by_id(quotas, 'claude.five_hour')['active'])
        self.assertEqual(by_id(quotas, 'claude.seven_day_opus')['label'], 'Weekly · Opus')
        self.assertFalse(any(q['id'] == 'claude.seven_day_sonnet' for q in quotas))

    def test_enabled_spend_with_api_severity(self):
        spend = by_id(claude.parse_usage(load('claude-usage-legacy.json'))['quotas'], 'claude.spend')
        self.assertEqual(spend['percent'], 30)
        self.assertEqual(spend['severity'], 'warn')

    def test_plan_metadata(self):
        meta = claude.parse_usage(load('claude-usage.json'), {'plan': 'max', 'tier': 'default_claude_max_5x'})['meta']
        self.assertEqual(meta, {'plan': 'max', 'tier': 'default_claude_max_5x'})

    def test_unknown_kind_surfaced(self):
        quotas = claude.parse_usage({'limits': [{'kind': 'monthly_cowork', 'percent': 12,
                                                 'resets_at': None, 'is_active': True}]})['quotas']
        self.assertEqual([(q['id'], q['label']) for q in quotas], [('claude.monthly_cowork', 'Monthly cowork')])

    def test_empty_payloads(self):
        for empty in [{}, {'limits': []}, None]:
            self.assertEqual(claude.parse_usage(empty)['quotas'], [])


class GrokParser(unittest.TestCase):
    def test_products_plus_optional_pool(self):
        quotas = grok.parse_billing(load('grok-billing.json'))['quotas']
        self.assertEqual([q['id'] for q in quotas], ['grok.grokbuild', 'grok.grokchat', 'grok.pool'])
        self.assertEqual([q['label'] for q in quotas], ['Build', 'Chat', 'Credits'])
        self.assertEqual([q['percent'] for q in quotas], [31, 18, 49])

    def test_pool_optional_only_with_products(self):
        self.assertTrue(by_id(grok.parse_billing(load('grok-billing.json'))['quotas'], 'grok.pool')['optional'])
        self.assertFalse(by_id(grok.parse_billing(load('grok-billing-ondemand.json'))['quotas'],
                               'grok.pool')['optional'])

    def test_shared_reset(self):
        for q in grok.parse_billing(load('grok-billing.json'))['quotas']:
            self.assertEqual(aq.iso(q['resetsAt']), '2026-08-14T14:27:21.250Z')

    def test_on_demand_only_with_cap(self):
        self.assertEqual(by_id(grok.parse_billing(load('grok-billing-ondemand.json'))['quotas'],
                               'grok.on-demand')['percent'], 25)
        self.assertFalse(any(q['id'] == 'grok.on-demand'
                             for q in grok.parse_billing(load('grok-billing.json'))['quotas']))

    def test_period_type_metadata(self):
        self.assertEqual(grok.parse_billing(load('grok-billing.json'))['meta']['tier'], 'weekly period')
        self.assertEqual(grok.parse_billing(load('grok-billing-ondemand.json'))['meta']['tier'], 'monthly period')

    def test_bare_config(self):
        enveloped = grok.parse_billing(load('grok-billing.json'))['quotas']
        bare = grok.parse_billing(load('grok-billing.json')['config'])['quotas']
        self.assertEqual([q['percent'] for q in bare], [q['percent'] for q in enveloped])

    def test_log_tail_latest_record(self):
        result = grok.parse_log_tail(fixture('grok-log-tail.jsonl'))
        self.assertEqual((result['source'], result['stale']), ('log', True))
        self.assertEqual(by_id(result['quotas'], 'grok.pool')['percent'], 48)
        self.assertEqual(result['meta']['plan'], 'Example Plan')
        self.assertEqual(aq.iso(result['fetchedAt']), '2026-08-14T13:57:34.426Z')

    def test_log_tail_junk(self):
        self.assertIsNone(grok.parse_log_tail('not json at all\n'))
        self.assertIsNone(grok.parse_log_tail(''))
        self.assertIsNone(grok.parse_log_tail(None))

    def test_camel_case_products(self):
        q = grok.parse_billing({'config': {'productUsage': [{'product': 'GrokDeepSearch', 'usagePercent': 5}]}})['quotas'][0]
        self.assertEqual((q['label'], q['id']), ('Deep Search', 'grok.grokdeepsearch'))

    def test_auth_entry_prefers_unexpired(self):
        auth = {'a::1': {'key': 'old', 'expires_at': '2020-01-01T00:00:00Z'},
                'b::2': {'key': 'new', 'expires_at': '2999-01-01T00:00:00Z'}}
        self.assertEqual(grok.select_auth_entry(auth)['key'], 'new')
        self.assertIsNone(grok.select_auth_entry({}))


class CodexParser(unittest.TestCase):
    def test_primary_and_secondary(self):
        quotas = codex.parse_usage(load('codex-usage.json'), epoch('2026-08-14T14:00:00Z'))['quotas']
        session = by_id(quotas, 'codex.session')
        self.assertEqual((session['percent'], session['label']), (64, '5-hour'))
        self.assertEqual(aq.iso(session['resetsAt']), '2026-08-14T15:10:00.000Z')
        weekly = by_id(quotas, 'codex.weekly')
        self.assertEqual((weekly['percent'], weekly['label']), (22.5, 'Weekly'))

    def test_additional_and_review(self):
        quotas = codex.parse_usage(load('codex-usage.json'))['quotas']
        self.assertEqual(by_id(quotas, 'codex.cloud-tasks')['percent'], 11)
        self.assertEqual(by_id(quotas, 'codex.cloud-tasks')['label'], 'cloud tasks')
        self.assertTrue(by_id(quotas, 'codex.code-review')['hidable'])

    def test_cli_stream_shape(self):
        quotas = codex.parse_usage({'rate_limits': {
            'primary': {'used_percent': 12, 'window_minutes': 300, 'resets_in_seconds': 600},
            'secondary': {'used_percent': 3, 'window_minutes': 10080, 'resets_in_seconds': 60000},
        }}, epoch('2026-08-14T14:00:00Z'))['quotas']
        self.assertEqual([q['id'] for q in quotas], ['codex.session', 'codex.weekly'])
        self.assertEqual(aq.iso(quotas[0]['resetsAt']), '2026-08-14T14:10:00.000Z')

    def test_counters(self):
        quotas = codex.parse_usage({'rate_limit': {'primary_window': {'used': 25, 'limit': 200,
                                                                      'window_minutes': 300}}})['quotas']
        self.assertEqual(quotas[0]['percent'], 12.5)

    def test_empty(self):
        for empty in [{}, None, {'rate_limit': {}}]:
            self.assertEqual(codex.parse_usage(empty)['quotas'], [])


class Continuity(unittest.TestCase):
    def test_missing_quota_carried_at_zero(self):
        now = at('2026-08-14T14:30:00Z')
        seen = at('2026-08-14T14:20:00Z')
        previous = [
            {'id': 'grok.grokbuild', 'percent': 31, 'resetsAt': at('2026-08-14T14:27:00Z'), 'lastSeenAt': seen},
            {'id': 'grok.grokchat', 'percent': 18, 'resetsAt': at('2026-08-14T14:27:00Z'), 'lastSeenAt': seen},
        ]
        incoming = [{'id': 'grok.grokbuild', 'percent': 1, 'resetsAt': at('2026-08-21T14:27:00Z')}]
        merged = aq.merge_continuity(previous, incoming, now)
        self.assertEqual([q['id'] for q in merged], ['grok.grokbuild', 'grok.grokchat'])
        self.assertEqual((merged[0]['percent'], merged[0]['carried']), (1, False))
        self.assertEqual((merged[1]['percent'], merged[1]['carried']), (0, True))
        self.assertEqual(aq.iso(merged[1]['resetsAt']), '2026-08-21T14:27:00.000Z')

    def test_order_preserved(self):
        now, seen = at('2026-08-14T14:30:00Z'), at('2026-08-14T14:20:00Z')
        previous = [{'id': i, 'percent': 1, 'resetsAt': None, 'lastSeenAt': seen} for i in 'abc']
        incoming = [{'id': i, 'percent': 9, 'resetsAt': None} for i in 'cad']
        self.assertEqual([q['id'] for q in aq.merge_continuity(previous, incoming, now)], list('abcd'))

    def test_long_absent_retired(self):
        now = at('2026-08-14T14:30:00Z')
        previous = [{'id': 'claude.seven_day_opus', 'percent': 5, 'resetsAt': None,
                     'lastSeenAt': at('2026-08-01T00:00:00Z')}]
        merged = aq.merge_continuity(previous, [{'id': 'claude.session', 'percent': 4, 'resetsAt': None}], now)
        self.assertEqual([q['id'] for q in merged], ['claude.session'])

    def test_no_last_seen_not_resurrected(self):
        self.assertEqual(aq.merge_continuity([{'id': 'x', 'percent': 5, 'resetsAt': None}], []), [])

    def test_fresh_wins(self):
        now = at('2026-08-14T14:30:00Z')
        merged = aq.merge_continuity([{'id': 'x', 'percent': 90, 'resetsAt': None, 'lastSeenAt': now,
                                       'carried': True}], [{'id': 'x', 'percent': 12, 'resetsAt': None}], now)
        self.assertEqual((merged[0]['percent'], merged[0]['carried']), (12, False))

    def test_empty(self):
        self.assertEqual(aq.merge_continuity([], []), [])
        self.assertEqual(aq.merge_continuity(None, None), [])
        self.assertEqual(len(aq.merge_continuity(None, [{'id': 'x', 'percent': 1, 'resetsAt': None}])), 1)


class Contract(unittest.TestCase):
    def test_every_record_satisfies_contract(self):
        readings = [claude.parse_usage(load('claude-usage.json')),
                    claude.parse_usage(load('claude-usage-legacy.json')),
                    grok.parse_billing(load('grok-billing.json')),
                    grok.parse_billing(load('grok-billing-ondemand.json')),
                    codex.parse_usage(load('codex-usage.json'))]
        for reading in readings:
            ids = [q['id'] for q in reading['quotas']]
            self.assertEqual(len(ids), len(set(ids)))
            for q in reading['quotas']:
                self.assertTrue(q['id'].startswith(q['provider'] + '.'))
                self.assertTrue(q['label'])
                self.assertTrue(0 <= q['percent'] <= 100)
                self.assertTrue(q['resetsAt'] is None or isinstance(q['resetsAt'], datetime))
                self.assertIsInstance(q['active'], bool)
                self.assertIn(q['severity'], ('normal', 'warn', 'critical'))


def nq(**overrides):
    q = {'id': 'claude.session', 'provider': 'claude', 'label': 'Session', 'percent': 100,
         'resetsAt': at('2026-08-16T20:00:00.493Z')}
    q.update(overrides)
    return q


def levels(events):
    return [level for _q, level in events]


class NotifyPolicy(unittest.TestCase):
    def test_first_warn(self):
        state, events = aq.evaluate_thresholds({}, [nq(percent=76)])
        self.assertEqual(levels(events), ['warn'])
        self.assertEqual(state['claude.session']['fired'], ['warn'])

    def test_staying_above_is_silent(self):
        state, _ = aq.evaluate_thresholds({}, [nq(percent=76)])
        state, events = aq.evaluate_thresholds(state, [nq(percent=80)])
        self.assertEqual(levels(events), [])
        self.assertEqual(state['claude.session']['fired'], ['warn'])

    def test_critical_after_warn(self):
        state, _ = aq.evaluate_thresholds({}, [nq(percent=76)])
        state, events = aq.evaluate_thresholds(state, [nq(percent=92)])
        self.assertEqual(levels(events), ['critical'])
        self.assertEqual(state['claude.session']['fired'], ['warn', 'critical'])

    def test_straight_to_100(self):
        state, events = aq.evaluate_thresholds({}, [nq(percent=100)])
        self.assertEqual(levels(events), ['critical'])
        self.assertEqual(state['claude.session']['fired'], ['critical', 'warn'])

    def test_jittering_reset_does_not_refire(self):
        state, events = aq.evaluate_thresholds({}, [nq(resetsAt=at('2026-08-16T19:59:59.989Z'))])
        self.assertEqual(levels(events), ['critical'])
        state, events = aq.evaluate_thresholds(state, [nq(resetsAt=at('2026-08-16T20:00:00.152Z'))])
        self.assertEqual(levels(events), [])

    def test_persisted_state_honoured(self):
        persisted = {'claude.session': {'window': '2026-08-16T20:00:00.493Z', 'fired': ['critical', 'warn']}}
        _, events = aq.evaluate_thresholds(persisted, [nq(resetsAt=at('2026-08-16T19:59:59.989Z'))])
        self.assertEqual(levels(events), [])

    def test_rearm_after_drop(self):
        state, _ = aq.evaluate_thresholds({}, [nq(percent=100)])
        state, events = aq.evaluate_thresholds(state, [nq(percent=10)])
        self.assertEqual((levels(events), state['claude.session']['fired']), ([], []))
        _, events = aq.evaluate_thresholds(state, [nq(percent=76)])
        self.assertEqual(levels(events), ['warn'])

    def test_hovering_does_not_nag(self):
        out = []
        state = {}
        for percent in (76, 76, 74, 76):
            state, events = aq.evaluate_thresholds(state, [nq(percent=percent)])
            out.append(levels(events))
        self.assertEqual(out, [['warn'], [], [], ['warn']])

    def test_missing_percent_keeps_state(self):
        state, _ = aq.evaluate_thresholds({}, [nq(percent=92)])
        state, events = aq.evaluate_thresholds(state, [nq(percent=None)])
        self.assertEqual(levels(events), [])
        self.assertEqual(state['claude.session']['fired'], ['critical', 'warn'])

    def test_vanished_quota_dropped(self):
        state, _ = aq.evaluate_thresholds({}, [nq(percent=80), nq(id='claude.weekly_all', percent=10)])
        state, _ = aq.evaluate_thresholds(state, [nq(id='claude.weekly_all', percent=10)])
        self.assertEqual(list(state), ['claude.weekly_all'])

    def test_copy(self):
        title, body = aq.notification_copy(nq(percent=100), 'critical', 'Claude Code')
        self.assertEqual(title, 'Claude Code: Session exhausted')
        self.assertTrue(body.startswith('100% used.'))
        self.assertNotIn('nearly', body.lower())
        self.assertEqual(aq.notification_copy(nq(percent=99.6), 'critical', 'Claude Code')[0],
                         'Claude Code: Session exhausted')
        self.assertEqual(aq.notification_copy(nq(percent=92), 'critical', 'Claude Code')[0],
                         'Claude Code: Session nearly exhausted')
        self.assertEqual(aq.notification_copy(nq(percent=76), 'warn', 'Claude Code')[0],
                         'Claude Code: Session running low')
        self.assertTrue(aq.notification_copy(nq(resetsAt=None), 'warn', 'X')[1].endswith('No reset scheduled.'))


# ------------------------------------------------------------- Waybar-only


def settings(**overrides):
    s = dict(aq.DEFAULT_SETTINGS)
    s.update(overrides)
    return s


class Rendering(unittest.TestCase):
    def reading(self, quotas, **extra):
        return {'ok': True, 'source': 'api', 'stale': False, 'quotas': quotas,
                'meta': {'plan': 'pro'}, 'fetchedAt': aq.now_utc(), 'error': None, **extra}

    def test_gauge_chars(self):
        self.assertEqual(aq.gauge_char(None), ' ')
        self.assertEqual(aq.gauge_char(0), ' ')
        self.assertEqual(aq.gauge_char(0.1), '▁', 'a barely used quota still shows')
        self.assertEqual(aq.gauge_char(50), '▄')
        self.assertEqual(aq.gauge_char(100), '█')

    def test_output_shape_and_severity_class(self):
        quotas = claude.parse_usage({'limits': [
            {'kind': 'session', 'percent': 80, 'is_active': True, 'resets_at': '2999-01-01T00:00:00Z'},
            {'kind': 'weekly_all', 'percent': 10}]})['quotas']
        out = aq.render(aq.PROVIDERS['claude'], self.reading(quotas), settings())
        self.assertEqual(out['class'], ['warn'])
        self.assertEqual(out['percentage'], 80)
        self.assertIn('#e0af68', out['text'])
        self.assertIn('Claude Code · pro', out['tooltip'])
        self.assertIn('80%', out['tooltip'])
        self.assertIn('Resets in', out['tooltip'])
        self.assertIn('No reset scheduled', out['tooltip'])
        json.dumps(out)

    def test_pool_hidden_from_bar_but_listed(self):
        quotas = grok.parse_billing(load('grok-billing.json'))['quotas']
        out = aq.render(aq.PROVIDERS['grok'], self.reading(quotas), settings())
        self.assertEqual(out['text'].count('background='), 2, 'Build and Chat only')
        self.assertIn('Credits  · hidden', out['tooltip'])
        out = aq.render(aq.PROVIDERS['grok'], self.reading(quotas), settings(**{'show-pool-totals': True}))
        self.assertEqual(out['text'].count('background='), 3)

    def test_auto_hide_and_hidden_quotas(self):
        quotas = claude.parse_usage(load('claude-usage.json'))['quotas']
        reading = self.reading(quotas)
        self.assertEqual(aq.render(aq.PROVIDERS['claude'], reading, settings())['text'].count('background='), 2)
        off = settings(**{'auto-hide-inactive': False, 'hidden-quotas': ['claude.weekly_all']})
        self.assertEqual(aq.render(aq.PROVIDERS['claude'], reading, off)['text'].count('background='), 2)

    def test_stale_and_error_states(self):
        quotas = grok.parse_billing(load('grok-billing.json'))['quotas']
        stale = aq.render(aq.PROVIDERS['grok'], self.reading(quotas, stale=True, error='Grok token expired'),
                          settings())
        self.assertIn('stale', stale['class'])
        self.assertIn('fgalpha', stale['text'])
        self.assertIn('⚠ Grok token expired', stale['tooltip'])
        error = aq.render(aq.PROVIDERS['grok'], {'ok': False, 'quotas': [], 'meta': {},
                                                 'error': 'Not signed in to Grok', 'fetchedAt': None},
                          settings())
        self.assertIn('error', error['class'])
        self.assertIn('Not signed in to Grok', error['tooltip'])

    def test_markup_is_escaped(self):
        q = aq.quota('claude.x', 'claude', 'A <b>&', None, 5, None, True)
        out = aq.render(aq.PROVIDERS['claude'], self.reading([q]), settings())
        self.assertIn('A &lt;b&gt;&amp;', out['tooltip'])

    def test_waiting(self):
        out = aq.render(aq.PROVIDERS['claude'], None, settings())
        self.assertEqual(out['class'], ['unknown'])


class FakeProvider:
    id = 'claude'
    label = 'Claude Code'
    glyph = 'C'
    unverified = False

    def __init__(self, results, fallback=None, watch=None):
        self.results = list(results)
        self.fallback = fallback
        self.watch = watch
        self.calls = 0

    def detect(self):
        return True

    def watch_paths(self):
        return [self.watch] if self.watch else []

    def fetch_quota(self):
        self.calls += 1
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    def read_fallback(self):
        return self.fallback


def ok_result(percent):
    return {'ok': True, 'source': 'api', 'fetchedAt': aq.now_utc(), 'meta': {},
            'quotas': [aq.quota('claude.session', 'claude', 'Session', '5h', percent, None, True)]}


class Polling(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {'XDG_STATE_HOME': self.tmp.name,
                                                'XDG_CONFIG_HOME': self.tmp.name})
        self.env.start()
        self.sent = []
        self.notify = mock.patch.object(aq, 'send_notification',
                                        lambda t, b, l: self.sent.append((t, l)))
        self.notify.start()

    def tearDown(self):
        self.notify.stop()
        self.env.stop()
        self.tmp.cleanup()

    def module(self, provider, **overrides):
        m = aq.Module(provider, settings(**overrides), out=io.StringIO())
        self.addCleanup(m.close)
        return m

    def write_json(self, path, data):
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump(data, handle)

    def lines(self, module):
        return [json.loads(line) for line in module.out.getvalue().splitlines()]

    def test_fetch_render_and_persist(self):
        m = self.module(FakeProvider([ok_result(42)]))
        m.step()
        self.assertEqual(self.lines(m)[-1]['percentage'], 42)
        with open(m.state_path, encoding='utf-8') as handle:
            saved = json.load(handle)
        self.assertEqual(saved['result']['quotas'][0]['percent'], 42)
        self.assertEqual(oct(os.stat(m.state_path).st_mode & 0o777), '0o600')
        m.step()  # not due again yet
        self.assertEqual(m.provider.calls, 1)

    def test_auth_failure_blocks_until_credentials_change(self):
        cred = os.path.join(self.tmp.name, 'creds.json')
        self.write_json(cred, {})
        provider = FakeProvider([{'ok': False, 'authState': 'expired', 'error': 'token expired'},
                                 ok_result(5)], watch=cred)
        m = self.module(provider)
        m.step()
        self.assertEqual(m.blocked, 'expired')
        self.assertIn('error', self.lines(m)[-1]['class'])
        m.next_at = 0
        m.step()
        self.assertEqual(provider.calls, 1, 'a blocked provider is not retried on a timer')
        os.utime(cred, ns=(1, 1))
        m.step()
        self.assertEqual(provider.calls, 2)
        self.assertIsNone(m.blocked)

    def test_auth_failure_uses_fallback(self):
        fallback = {**ok_result(33), 'source': 'log', 'stale': True}
        m = self.module(FakeProvider([{'ok': False, 'authState': 'expired', 'error': 'expired'}],
                                     fallback=fallback))
        m.step()
        out = self.lines(m)[-1]
        self.assertEqual(out['percentage'], 33)
        self.assertIn('stale', out['class'])

    def test_network_error_backs_off_and_keeps_reading(self):
        m = self.module(FakeProvider([ok_result(20), OSError('offline')]))
        m.step()
        m.next_at = 0
        with mock.patch.object(aq, 'log'):
            m.step()
        self.assertTrue(m.result['stale'])
        self.assertEqual(m.result['quotas'][0]['percent'], 20)
        self.assertGreater(m.next_at, aq.time.time() + 50)

    def test_refresh_request_forces_poll(self):
        m = self.module(FakeProvider([ok_result(1), ok_result(2)]))
        m.step()
        with mock.patch.object(aq.time, 'time', return_value=aq.time.time() + 0.01):
            aq.request_refresh('claude')
        os.utime(m.refresh_path, ns=(2, 2))
        m.step()
        self.assertEqual(m.provider.calls, 2)

    def test_notifications_fire_once_and_respect_setting(self):
        m = self.module(FakeProvider([ok_result(80), ok_result(85)]))
        m.step()
        m.next_at = 0
        m.step()
        self.assertEqual(self.sent, [('Claude Code: Session running low', 'warn')])
        m.close()
        os.remove(m.state_path)
        quiet_provider = FakeProvider([ok_result(95)])
        quiet = self.module(quiet_provider, **{'notifications-enabled': False})
        quiet.step()
        self.assertEqual(quiet_provider.calls, 1)
        self.assertEqual(quiet.notify_state['claude.session']['fired'], ['critical', 'warn'],
                         'state still advances so turning notifications on does not replay')
        self.assertEqual(len(self.sent), 1)

    def test_only_one_poller_per_provider(self):
        leader = self.module(FakeProvider([ok_result(60)]))
        follower_provider = FakeProvider([ok_result(99)])
        follower = self.module(follower_provider)
        leader.step()
        follower.step()
        self.assertEqual(follower_provider.calls, 0, 'the second copy must not poll')
        self.assertEqual(self.lines(follower)[-1]['percentage'], 60, 'it renders the shared reading')

    def test_new_leader_respects_schedule(self):
        first = self.module(FakeProvider([ok_result(10)]))
        first.step()
        first.close()
        provider = FakeProvider([ok_result(11)])
        second = self.module(provider)
        second.step()
        self.assertEqual(provider.calls, 0, 'a Waybar restart does not trigger an extra poll')

    def test_seeds_from_gnome_state(self):
        gnome = os.path.join(self.tmp.name, 'aiquota', 'state.json')
        os.makedirs(os.path.dirname(gnome))
        self.write_json(gnome, {'version': 1, 'providers': {'claude': {
            'source': 'api', 'fetchedAt': '2026-10-31T22:09:56.360Z', 'meta': {},
            'quotas': [{'id': 'claude.session', 'provider': 'claude', 'label': 'Session',
                        'percent': 77, 'resetsAt': None, 'severity': 'normal',
                        'lastSeenAt': '2026-10-31T22:09:56.360Z'}]}},
            'notifyState': {'claude.session': {'fired': ['warn']}, 'grok.pool': {'fired': []}}})
        result, notify = aq.seed_from_gnome('claude')
        self.assertEqual(result['quotas'][0]['percent'], 77)
        self.assertTrue(result['stale'])
        self.assertEqual(notify, {'claude.session': {'fired': ['warn']}})

    def test_disabled_provider_prints_empty_text(self):
        m = self.module(FakeProvider([]), **{'providers-enabled': ['grok']})
        m.step()
        self.assertEqual(self.lines(m)[-1]['text'], '')

    def test_settings_file(self):
        path = os.path.join(self.tmp.name, 'cfg.json')
        self.write_json(path, {'warn-threshold': 60, 'poll-interval': 'bad', 'unknown': 1})
        s = aq.load_settings(path)
        self.assertEqual(s['warn-threshold'], 60)
        self.assertEqual(s['poll-interval'], 300, 'a wrongly typed value falls back to the default')


class GnomeSettingsImport(unittest.TestCase):
    def test_parse_gvariant(self):
        self.assertEqual(aq.parse_gvariant('300\n'), 300)
        self.assertEqual(aq.parse_gvariant('false'), False)
        self.assertEqual(aq.parse_gvariant("['claude', 'grok']"), ['claude', 'grok'])
        self.assertEqual(aq.parse_gvariant('@as []'), [])
        self.assertEqual(aq.parse_gvariant("'#33d17a'"), '#33d17a')
        self.assertIsNone(aq.parse_gvariant('No such schema'))

    def test_import_keeps_waybar_colours_and_types(self):
        values = {'providers-enabled': "['claude', 'grok']", 'auto-hide-inactive': 'false',
                  'poll-interval': '300', 'color-normal': "'#33d17a'", 'warn-threshold': 'oops'}

        def fake_run(cmd, **_kwargs):
            key = cmd[-1]
            if key not in values:
                raise aq.subprocess.CalledProcessError(1, cmd)
            return mock.Mock(stdout=values[key])

        with mock.patch.object(aq.subprocess, 'run', fake_run):
            imported = aq.import_gnome_settings('/x')
        self.assertEqual(imported, {'providers-enabled': ['claude', 'grok'],
                                    'auto-hide-inactive': False, 'poll-interval': 300})


if __name__ == '__main__':
    unittest.main()
