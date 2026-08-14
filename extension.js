import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {GaugeItem} from './lib/gauge.js';
import {Notifier} from './lib/notify.js';
import {Poller} from './lib/poller.js';
import {Tooltip} from './lib/tooltip.js';
import {PROVIDERS} from './providers/index.js';
import {
    formatAbsolute, formatAge, formatDuration, formatPercent, severityFor,
} from './lib/format.js';

const STATE_SUBDIR = 'aiquota';
const STATE_FILE = 'state.json';
const MENU_BAR_WIDTH = 200;   // logical px
const UI_TICK_MS = 10000;     // countdown refresh while the menu/tooltip is up

/** The stronger of the provider's own severity and our threshold bands. */
function resolveSeverity(quota, warn, critical) {
    const rank = {normal: 0, warn: 1, critical: 2};
    const local = severityFor(quota.percent, warn, critical);
    if (local === 'unknown')
        return 'unknown';
    return (rank[quota.severity] ?? 0) > (rank[local] ?? 0) ? quota.severity : local;
}

/** A horizontal fill bar for the popup menu. */
const MenuBar = GObject.registerClass(
class MenuBar extends St.Bin {
    _init() {
        super._init({
            style_class: 'aiquota-menubar-track',
            x_expand: true,
        });
        this._fill = new St.Widget({
            style_class: 'aiquota-menubar-fill',
            x_align: Clutter.ActorAlign.START,
        });
        this.set_child(this._fill);
        this._percent = 0;
    }

    setReading(percent, color) {
        this._percent = percent ?? 0;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const track = MENU_BAR_WIDTH * scale;
        this.set_width(Math.round(track));
        // A quota that is barely used still deserves a visible sliver, so the
        // bar reads as "a little" rather than "nothing".
        const width = this._percent > 0
            ? Math.max(2 * scale, Math.round((track * this._percent) / 100))
            : 0;
        this._fill.set_width(width);
        this._fill.visible = width > 0;
        // Inline rather than a class so the menu honours the same colours the
        // user picked for the panel gauges.
        this._fill.set_style(`background-color: ${color};`);
    }
});

/** One quota row in the popup menu: name, percent, bar, reset. */
const QuotaMenuItem = GObject.registerClass(
class QuotaMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({activate: false, hover: false, can_focus: false});
        this.remove_style_class_name('popup-menu-item');
        this.add_style_class_name('aiquota-menu-row');

        const column = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.add_child(column);

        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        this._label = new St.Label({
            style_class: 'aiquota-menu-label',
            x_expand: true,
        });
        this._percentLabel = new St.Label({style_class: 'aiquota-menu-percent'});
        header.add_child(this._label);
        header.add_child(this._percentLabel);
        column.add_child(header);

        this._bar = new MenuBar();
        column.add_child(this._bar);

        this._reset = new St.Label({style_class: 'aiquota-menu-reset'});
        column.add_child(this._reset);
    }

    update(quota, color, {hiddenFromPanel}) {
        this._label.text = hiddenFromPanel ? `${quota.label}  ·  hidden` : quota.label;
        this._percentLabel.text = formatPercent(quota.percent);
        this._percentLabel.set_style(`color: ${color};`);
        this._bar.setReading(quota.percent, color);

        if (quota.resetsAt) {
            this._reset.text =
                `resets in ${formatDuration(quota.resetsAt)} · ${formatAbsolute(quota.resetsAt)}`;
        } else {
            this._reset.text = 'no reset scheduled';
        }
    }
});

export default class AiQuotaExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._snapshot = {};
        this._items = new Map();      // quotaId -> GaugeItem
        this._menuRows = new Map();   // quotaId -> QuotaMenuItem
        this._uiTickId = 0;
        this._hoveredItem = null;

        this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);
        this._indicator.add_style_class_name('aiquota-indicator');

        this._panelBox = new St.BoxLayout({
            style_class: 'aiquota-panel-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._indicator.add_child(this._panelBox);

        this._tooltip = new Tooltip();

        this._menuOpenId = this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._tooltip.hide();
                this._rebuildMenu();
                // Opening the menu is an explicit "tell me now" — honour it,
                // subject to the per-provider minimum interval.
                this._poller?.refreshNow(false);
            }
            this._updateUiTick();
        });

        this._notifier = new Notifier();

        this._poller = new Poller(PROVIDERS, {
            getIntervalSeconds: () => this._settings.get_int('poll-interval'),
            getEnabledIds: () => this._settings.get_strv('providers-enabled'),
            onUpdate: snapshot => this._onSnapshot(snapshot),
            // State, not cache. The XDG spec says cached data may be deleted at
            // any time without loss of function — but this file records which
            // quotas exist, and losing it makes a zero-usage gauge vanish from
            // the panel until that product is next used. That is a loss of
            // function, so it belongs in XDG_STATE_HOME.
            statePath: GLib.build_filenamev([
                GLib.get_user_state_dir(), STATE_SUBDIR, STATE_FILE,
            ]),
            legacyStatePaths: [
                GLib.build_filenamev([
                    GLib.get_user_cache_dir(), STATE_SUBDIR, STATE_FILE,
                ]),
            ],
        });

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'providers-enabled' || key === 'poll-interval')
                this._poller.refreshNow(false);
            this._render();
            if (this._indicator.menu.isOpen)
                this._rebuildMenu();
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        this._poller.start();
        this._render();
    }

    disable() {
        // Order matters: stop producing work, then tear down what consumes it.
        this._poller?.stop();
        this._poller = null;

        this._stopUiTick();

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        if (this._menuOpenId) {
            this._indicator?.menu.disconnect(this._menuOpenId);
            this._menuOpenId = 0;
        }

        for (const item of this._items.values())
            item.destroy();
        this._items.clear();
        this._menuRows.clear();

        this._tooltip?.destroy();
        this._tooltip = null;

        this._notifier?.destroy();
        this._notifier = null;

        this._indicator?.destroy();
        this._indicator = null;
        this._panelBox = null;

        this._snapshot = null;
        this._settings = null;
        this._hoveredItem = null;
    }

    // ------------------------------------------------------------ data flow

    _onSnapshot(snapshot) {
        this._snapshot = snapshot ?? {};

        const warn = this._settings.get_int('warn-threshold');
        const critical = this._settings.get_int('critical-threshold');

        // Only notify on readings we actually trust. A stale or cached number
        // crossing a threshold is not news, it is an old number.
        const fresh = [];
        for (const provider of PROVIDERS) {
            const result = this._snapshot[provider.id];
            if (result?.ok && !result.stale)
                fresh.push(...result.quotas);
        }

        if (fresh.length > 0) {
            this._notifier.state = this._poller?.notifyState ?? {};
            this._notifier.evaluate(fresh, {
                providerLabels: Object.fromEntries(PROVIDERS.map(p => [p.id, p.label])),
                warn,
                critical,
                enabled: this._settings.get_boolean('notifications-enabled'),
            });
            if (this._poller)
                this._poller.notifyState = this._notifier.state;
        }

        this._render();
        if (this._indicator?.menu.isOpen)
            this._rebuildMenu();
    }

    /**
     * Every quota we know about, annotated with whether it belongs in the panel.
     * The menu shows all of them; the panel shows the subset.
     */
    _collectQuotas() {
        const hidden = new Set(this._settings.get_strv('hidden-quotas'));
        const autoHide = this._settings.get_boolean('auto-hide-inactive');
        const showPools = this._settings.get_boolean('show-pool-totals');
        const enabled = new Set(this._settings.get_strv('providers-enabled'));
        const warn = this._settings.get_int('warn-threshold');
        const critical = this._settings.get_int('critical-threshold');

        const groups = [];
        for (const provider of PROVIDERS) {
            if (!enabled.has(provider.id))
                continue;
            const result = this._snapshot[provider.id];
            if (!result)
                continue;

            const state = !result.ok ? 'error' : result.stale ? 'stale' : 'ok';
            const entries = (result.quotas ?? []).map(quota => {
                const severity = resolveSeverity(quota, warn, critical);
                const inPanel =
                    !hidden.has(quota.id) &&
                    !(quota.optional && !showPools) &&
                    !(autoHide && quota.hidable);
                return {quota, severity, inPanel};
            });

            groups.push({provider, result, state, entries});
        }
        return groups;
    }

    _colorFor(severity) {
        switch (severity) {
        case 'critical':
            return this._settings.get_string('color-critical');
        case 'warn':
            return this._settings.get_string('color-warn');
        default:
            return this._settings.get_string('color-normal');
        }
    }

    // ------------------------------------------------------------- rendering

    _render() {
        if (!this._panelBox)
            return;

        const groups = this._collectQuotas();
        const gaugeWidth = this._settings.get_int('gauge-width');
        const showTag = this._settings.get_boolean('show-window-labels');

        const wanted = [];
        for (const group of groups) {
            for (const entry of group.entries) {
                if (entry.inPanel)
                    wanted.push({group, ...entry});
            }
        }

        // Nothing to show is itself information — keep one dimmed placeholder so
        // the extension never silently vanishes from the panel.
        if (wanted.length === 0) {
            this._renderPlaceholder(gaugeWidth);
            return;
        }

        // Unparent gauges (they get re-added below) but destroy the throwaway
        // separators, so a render every few minutes does not leak actors.
        for (const child of this._panelBox.get_children()) {
            this._panelBox.remove_child(child);
            if (child.quotaId === undefined)
                child.destroy();
        }
        if (this._placeholder) {
            this._placeholder.destroy();
            this._placeholder = null;
        }

        let previousProvider = null;
        for (const {group, quota, severity} of wanted) {
            if (previousProvider && previousProvider !== group.provider.id) {
                this._panelBox.add_child(new St.Widget({
                    style_class: 'aiquota-group-separator',
                    y_expand: true,
                }));
            }
            previousProvider = group.provider.id;

            let item = this._items.get(quota.id);
            if (!item) {
                item = new GaugeItem(quota.id);
                item.connect('notify::hover', actor => this._onItemHover(actor));
                item.connect('destroy', () => this._items.delete(quota.id));
                this._items.set(quota.id, item);
            }

            item.update(quota, {
                glyph: group.provider.glyph,
                state: group.state,
                fillColor: this._colorFor(severity),
                showTag,
                gaugeWidth,
            });

            this._panelBox.add_child(item);
        }

        // Drop gauges for quotas that no longer exist.
        for (const [id, item] of [...this._items]) {
            if (!item.get_parent()) {
                this._items.delete(id);
                item.destroy();
            }
        }

        if (this._hoveredItem)
            this._refreshTooltip(this._hoveredItem);
    }

    _renderPlaceholder(gaugeWidth) {
        for (const child of this._panelBox.get_children()) {
            if (child !== this._placeholder)
                child.destroy();
        }
        for (const item of this._items.values())
            item.destroy();
        this._items.clear();

        // Reused across renders — recreating it each cycle would churn actors
        // and drop the hover state out from under the pointer.
        if (!this._placeholder) {
            this._placeholder = new GaugeItem('__placeholder__');
            this._placeholder.connect('notify::hover', actor => this._onItemHover(actor));
            this._placeholder.connect('destroy', () => {
                this._placeholder = null;
            });
            this._panelBox.add_child(this._placeholder);
        }

        this._placeholder.update(
            {id: '__placeholder__', label: 'No quotas', percent: null, short: null},
            {glyph: '', state: 'unknown', fillColor: '#888888', showTag: false, gaugeWidth}
        );
    }

    // -------------------------------------------------------------- tooltip

    _onItemHover(item) {
        if (item.hover) {
            this._hoveredItem = item;
            const content = this._tooltipContent(item);
            if (content)
                this._tooltip.scheduleFor(item, content.title, content.lines);
        } else if (this._hoveredItem === item) {
            this._hoveredItem = null;
            this._tooltip.scheduleHide();
        }
        this._updateUiTick();
    }

    _refreshTooltip(item) {
        const content = this._tooltipContent(item);
        if (content)
            this._tooltip.refreshFor(item, content.title, content.lines);
    }

    _tooltipContent(item) {
        if (item === this._placeholder) {
            return {
                title: 'AI Quota',
                lines: ['No signed-in providers detected.',
                    'Sign in to Claude Code or Grok, or check Settings.'],
            };
        }

        const group = this._collectQuotas().find(
            g => g.entries.some(e => e.quota.id === item.quotaId));
        if (!group)
            return null;
        const entry = group.entries.find(e => e.quota.id === item.quotaId);
        const {quota} = entry;

        const lines = [`${formatPercent(quota.percent)} used`];

        if (quota.resetsAt) {
            lines.push(`Resets in ${formatDuration(quota.resetsAt)}`);
            lines.push(formatAbsolute(quota.resetsAt));
        } else {
            lines.push('No reset scheduled');
        }

        // Never let an old number pass for a current one.
        if (group.state !== 'ok') {
            const age = formatAge(group.result.fetchedAt);
            lines.push(group.result.error
                ? `⚠ ${group.result.error}`
                : `⚠ Last updated ${age ?? 'unknown'}`);
            if (group.result.error && age)
                lines.push(`Last updated ${age}`);
        }

        return {
            title: `${group.provider.label} · ${quota.label}`,
            lines,
        };
    }

    // ----------------------------------------------------------------- menu

    _rebuildMenu() {
        const menu = this._indicator?.menu;
        if (!menu)
            return;

        menu.removeAll();
        this._menuRows.clear();

        const groups = this._collectQuotas();

        if (groups.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(
                'No providers detected', {reactive: false});
            menu.addMenuItem(empty);
        }

        for (const group of groups) {
            const headerParts = [group.provider.label];
            if (group.result.meta?.plan)
                headerParts.push(group.result.meta.plan);
            if (group.provider.unverified)
                headerParts.push('unverified');
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(headerParts.join('  ·  ')));

            if (group.entries.length === 0 || !group.result.ok) {
                const message = group.result.error ?? 'No reading available';
                const item = new PopupMenu.PopupMenuItem(message, {reactive: false});
                item.add_style_class_name('aiquota-menu-note');
                menu.addMenuItem(item);
            }

            for (const entry of group.entries) {
                const row = new QuotaMenuItem();
                row.update(entry.quota, this._colorFor(entry.severity),
                    {hiddenFromPanel: !entry.inPanel});
                menu.addMenuItem(row);
                this._menuRows.set(entry.quota.id, {row, entry});
            }

            const age = formatAge(group.result.fetchedAt);
            const sourceNote = group.result.ok
                ? `${group.result.stale ? 'Stale · ' : ''}${group.result.source ?? 'unknown'} · updated ${age ?? 'unknown'}`
                : 'Unavailable';
            const note = new PopupMenu.PopupMenuItem(sourceNote, {reactive: false});
            note.add_style_class_name('aiquota-menu-note');
            menu.addMenuItem(note);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => {
            const started = this._poller?.refreshNow(true);
            if (!started)
                refresh.label.text = 'Refresh now';
        });
        menu.addMenuItem(refresh);

        const settings = new PopupMenu.PopupMenuItem('Settings');
        settings.connect('activate', () => {
            this.openPreferences();
            menu.close();
        });
        menu.addMenuItem(settings);
    }

    // ------------------------------------------------------- countdown tick

    /**
     * Countdowns only tick while something is showing one. A panel gauge does
     * not display time, so there is no reason to wake up for it.
     */
    _updateUiTick() {
        const needed = Boolean(this._indicator?.menu.isOpen) || Boolean(this._hoveredItem);
        if (needed)
            this._startUiTick();
        else
            this._stopUiTick();
    }

    _startUiTick() {
        if (this._uiTickId)
            return;
        this._uiTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UI_TICK_MS, () => {
            if (this._indicator?.menu.isOpen) {
                for (const {row, entry} of this._menuRows.values()) {
                    row.update(entry.quota, this._colorFor(entry.severity),
                        {hiddenFromPanel: !entry.inPanel});
                }
            }
            if (this._hoveredItem)
                this._refreshTooltip(this._hoveredItem);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopUiTick() {
        if (!this._uiTickId)
            return;
        GLib.source_remove(this._uiTickId);
        this._uiTickId = 0;
    }
}
