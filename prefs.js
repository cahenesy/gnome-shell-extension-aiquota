import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PROVIDERS} from './providers/index.js';
import {parseHexColor} from './lib/format.js';

const CACHE_PATH = () =>
    GLib.build_filenamev([GLib.get_user_cache_dir(), 'aiquota', 'state.json']);

/** Read the poller's cache so we can offer per-quota visibility toggles. */
function readCachedQuotas() {
    try {
        const [ok, contents] = GLib.file_get_contents(CACHE_PATH());
        if (!ok)
            return [];
        const cached = JSON.parse(new TextDecoder().decode(contents));
        const out = [];
        for (const [providerId, entry] of Object.entries(cached?.providers ?? {})) {
            const provider = PROVIDERS.find(p => p.id === providerId);
            for (const quota of entry?.quotas ?? []) {
                out.push({
                    id: quota.id,
                    label: quota.label,
                    providerLabel: provider?.label ?? providerId,
                });
            }
        }
        return out;
    } catch {
        return [];
    }
}

function rgbaToHex(rgba) {
    const channel = value => Math.round(Math.min(1, Math.max(0, value)) * 255)
        .toString(16).padStart(2, '0');
    return `#${channel(rgba.red)}${channel(rgba.green)}${channel(rgba.blue)}`;
}

function hexToRgba(hex) {
    const rgba = new Gdk.RGBA();
    const parsed = parseHexColor(hex);
    if (parsed) {
        rgba.red = parsed.r;
        rgba.green = parsed.g;
        rgba.blue = parsed.b;
        rgba.alpha = 1;
    } else {
        rgba.parse('#ffffff');
    }
    return rgba;
}

/** A colour swatch row bound to a hex-string GSetting. */
function colorRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle});
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        rgba: hexToRgba(settings.get_string(key)),
        valign: Gtk.Align.CENTER,
    });
    button.connect('notify::rgba', () => {
        settings.set_string(key, rgbaToHex(button.get_rgba()));
    });
    settings.connect(`changed::${key}`, () => {
        const wanted = rgbaToHex(hexToRgba(settings.get_string(key)));
        if (rgbaToHex(button.get_rgba()) !== wanted)
            button.set_rgba(hexToRgba(settings.get_string(key)));
    });
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

/** A switch row bound to membership of a string-array GSetting. */
function strvMemberRow(settings, key, member, title, subtitle) {
    const row = new Adw.SwitchRow({
        title,
        subtitle,
        active: settings.get_strv(key).includes(member),
    });
    row.connect('notify::active', () => {
        const current = new Set(settings.get_strv(key));
        if (row.active)
            current.add(member);
        else
            current.delete(member);
        settings.set_strv(key, [...current]);
    });
    return row;
}

export default class AiQuotaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._generalPage(settings));
        window.add(this._quotasPage(settings));
        window.add(this._alertsPage(settings));
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        // ------------------------------------------------------- providers
        const providers = new Adw.PreferencesGroup({
            title: 'Providers',
            description: 'A provider stays hidden until its tool is signed in on this machine.',
        });
        for (const provider of PROVIDERS) {
            const installed = provider.detect();
            const notes = [];
            if (!installed)
                notes.push('not detected on this machine');
            if (provider.unverified)
                notes.push('untested — no live account was available when it was written');
            providers.add(strvMemberRow(
                settings, 'providers-enabled', provider.id,
                provider.label,
                notes.join(' · ') || 'Detected'
            ));
        }
        page.add(providers);

        // --------------------------------------------------------- display
        const display = new Adw.PreferencesGroup({title: 'Display'});

        const autoHide = new Adw.SwitchRow({
            title: 'Hide inactive quotas',
            subtitle: 'Omit quotas that are empty, inactive and have no reset scheduled',
        });
        settings.bind('auto-hide-inactive', autoHide, 'active', Gio.SettingsBindFlags.DEFAULT);
        display.add(autoHide);

        const pools = new Adw.SwitchRow({
            title: 'Show pool totals',
            subtitle: "Grok's Build and Chat gauges already sum to its Credits pool",
        });
        settings.bind('show-pool-totals', pools, 'active', Gio.SettingsBindFlags.DEFAULT);
        display.add(pools);

        const tags = new Adw.SwitchRow({
            title: 'Show window labels',
            subtitle: 'Print a short tag (5h, wk) beside each gauge',
        });
        settings.bind('show-window-labels', tags, 'active', Gio.SettingsBindFlags.DEFAULT);
        display.add(tags);

        const width = new Adw.SpinRow({
            title: 'Gauge width',
            subtitle: 'Logical pixels',
            adjustment: new Gtk.Adjustment({lower: 8, upper: 28, step_increment: 1}),
        });
        settings.bind('gauge-width', width, 'value', Gio.SettingsBindFlags.DEFAULT);
        display.add(width);
        page.add(display);

        // --------------------------------------------------------- colours
        const colors = new Adw.PreferencesGroup({
            title: 'Colours',
            description: 'Applied to both the panel gauges and the menu bars.',
        });
        colors.add(colorRow(settings, 'color-normal', 'Normal', 'Below the warning threshold'));
        colors.add(colorRow(settings, 'color-warn', 'Warning', 'At or above the warning threshold'));
        colors.add(colorRow(settings, 'color-critical', 'Critical', 'At or above the critical threshold'));
        page.add(colors);

        // --------------------------------------------------------- updates
        const updates = new Adw.PreferencesGroup({
            title: 'Updates',
            description:
                'Quota is read from each vendor’s own endpoint using the token their CLI ' +
                'already stored. Tokens are never refreshed or written by this extension — ' +
                'when one expires, run the CLI and the gauges pick it up automatically.',
        });
        const interval = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds. The 180s floor matches what the vendors’ own clients cache.',
            adjustment: new Gtk.Adjustment({lower: 180, upper: 3600, step_increment: 30}),
        });
        settings.bind('poll-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        updates.add(interval);
        page.add(updates);

        return page;
    }

    _quotasPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Quotas',
            icon_name: 'view-list-symbolic',
        });

        const cached = readCachedQuotas();
        const group = new Adw.PreferencesGroup({
            title: 'Panel visibility',
            description: cached.length > 0
                ? 'Turn a quota off to keep it out of the top bar. It stays in the menu.'
                : 'Nothing cached yet — open the menu once so the quotas can be listed here.',
        });

        for (const quota of cached) {
            const row = new Adw.SwitchRow({
                title: quota.label,
                subtitle: `${quota.providerLabel} · ${quota.id}`,
                // hidden-quotas is a deny-list, so the switch is inverted.
                active: !settings.get_strv('hidden-quotas').includes(quota.id),
            });
            row.connect('notify::active', () => {
                const hidden = new Set(settings.get_strv('hidden-quotas'));
                if (row.active)
                    hidden.delete(quota.id);
                else
                    hidden.add(quota.id);
                settings.set_strv('hidden-quotas', [...hidden]);
            });
            group.add(row);
        }

        page.add(group);
        return page;
    }

    _alertsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Alerts',
            icon_name: 'preferences-system-notifications-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Thresholds',
            description:
                'Each threshold fires once, then stays quiet until usage falls back below it.',
        });

        const enabled = new Adw.SwitchRow({
            title: 'Desktop notifications',
            subtitle: 'Colours still change whether or not this is on',
        });
        settings.bind('notifications-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(enabled);

        const warn = new Adw.SpinRow({
            title: 'Warning threshold',
            subtitle: 'Percent used',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 100, step_increment: 1}),
        });
        settings.bind('warn-threshold', warn, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(warn);

        const critical = new Adw.SpinRow({
            title: 'Critical threshold',
            subtitle: 'Percent used',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 100, step_increment: 1}),
        });
        settings.bind('critical-threshold', critical, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(critical);

        // A critical threshold below the warning one would fire in the wrong
        // order; keep them consistent rather than validating after the fact.
        const clamp = () => {
            if (settings.get_int('critical-threshold') < settings.get_int('warn-threshold'))
                settings.set_int('critical-threshold', settings.get_int('warn-threshold'));
        };
        settings.connect('changed::warn-threshold', clamp);
        settings.connect('changed::critical-threshold', () => {
            if (settings.get_int('warn-threshold') > settings.get_int('critical-threshold'))
                settings.set_int('warn-threshold', settings.get_int('critical-threshold'));
        });

        page.add(group);
        return page;
    }
}
