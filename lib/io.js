import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * File helpers.
 *
 * Everything here runs on the GNOME Shell main loop, so nothing may block on
 * disk. Reads are async; the log tail seeks rather than slurping (the Grok
 * unified log is already over a megabyte and only grows).
 */

const decoder = new TextDecoder('utf-8');

export function homePath(...parts) {
    return GLib.build_filenamev([GLib.get_home_dir(), ...parts]);
}

export function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

/** Resolve to the file's text, or null if it does not exist / cannot be read. */
export function readText(path, cancellable = null) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(cancellable, (self, result) => {
            try {
                const [ok, contents] = self.load_contents_finish(result);
                resolve(ok ? decoder.decode(contents) : null);
            } catch {
                resolve(null);
            }
        });
    });
}

/** Resolve to the parsed JSON, or null on any failure. Never throws. */
export async function readJson(path, cancellable = null) {
    const text = await readText(path, cancellable);
    if (text === null)
        return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * Read at most the last `maxBytes` of a file.
 *
 * Used for the Grok log fallback: we want the most recent billing record out of
 * a multi-megabyte append-only log without paying to read the whole thing. The
 * first (probably partial) line of the returned chunk is dropped by the caller.
 */
export function readTail(path, maxBytes = 256 * 1024, cancellable = null) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(path);
        file.query_info_async(
            Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (infoSelf, infoResult) => {
                let size;
                try {
                    size = infoSelf.query_info_finish(infoResult).get_size();
                } catch {
                    resolve(null);
                    return;
                }

                const offset = Math.max(0, size - maxBytes);
                file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (readSelf, readResult) => {
                    let stream;
                    try {
                        stream = readSelf.read_finish(readResult);
                    } catch {
                        resolve(null);
                        return;
                    }

                    const finish = value => {
                        try {
                            stream.close(null);
                        } catch {
                            // Nothing useful to do if closing fails.
                        }
                        resolve(value);
                    };

                    try {
                        if (offset > 0)
                            stream.seek(offset, GLib.SeekType.SET, cancellable);
                    } catch {
                        finish(null);
                        return;
                    }

                    const wanted = size - offset;
                    stream.read_bytes_async(
                        wanted,
                        GLib.PRIORITY_DEFAULT,
                        cancellable,
                        (byteSelf, byteResult) => {
                            try {
                                const bytes = byteSelf.read_bytes_finish(byteResult);
                                const data = bytes?.get_data();
                                finish(data ? decoder.decode(data) : null);
                            } catch {
                                finish(null);
                            }
                        }
                    );
                });
            }
        );
    });
}

/**
 * Write `text` to `path` atomically with 0600 permissions, creating parents.
 *
 * The cache file holds quota readings only — never a token — but it is still
 * created private, because "this file is not sensitive" is a claim that ages
 * badly as a file grows new fields.
 */
export function writePrivate(path, text) {
    try {
        const file = Gio.File.new_for_path(path);
        const parent = file.get_parent();
        if (parent) {
            try {
                parent.make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw e;
            }
        }
        file.replace_contents(
            new TextEncoder().encode(text),
            null,
            false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
        GLib.chmod(path, 0o600);
        return true;
    } catch (e) {
        console.warn(`aiquota: could not write ${path}: ${e}`);
        return false;
    }
}

/**
 * Watch a file for changes and call `onChange` (debounced) when it moves.
 * Returns a disposer that must be called from disable().
 */
export function watchFile(path, onChange, debounceMs = 1500) {
    let monitor = null;
    let changedId = 0;
    let debounceId = 0;

    try {
        monitor = Gio.File.new_for_path(path).monitor_file(Gio.FileMonitorFlags.NONE, null);
    } catch (e) {
        console.warn(`aiquota: could not watch ${path}: ${e}`);
        return () => {};
    }

    changedId = monitor.connect('changed', (_m, _f, _o, eventType) => {
        if (eventType !== Gio.FileMonitorEvent.CHANGES_DONE_HINT &&
            eventType !== Gio.FileMonitorEvent.CREATED &&
            eventType !== Gio.FileMonitorEvent.RENAMED)
            return;

        if (debounceId)
            GLib.source_remove(debounceId);
        debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, debounceMs, () => {
            debounceId = 0;
            onChange();
            return GLib.SOURCE_REMOVE;
        });
    });

    return () => {
        if (debounceId) {
            GLib.source_remove(debounceId);
            debounceId = 0;
        }
        if (monitor) {
            if (changedId)
                monitor.disconnect(changedId);
            monitor.cancel();
            monitor = null;
        }
    };
}
