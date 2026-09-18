# Apps, packages and files

The `l` screen: what the TV can launch, what is running, and installing an APK from this
machine.

## App list

Shows what the TV can launch, user-installed apps first, and caches the result per device. Enter
launches the selected app, r re-probes the TV. A cached list is shown straight away, which covers a TV
that is asleep and cannot answer a probe.

The same screen is the task manager. Every row carries a liveness marker (a filled dot for a live
process, a light one for a package that is not running), and the running packages with no launcher
activity are listed under the launchable ones so they can be stopped too. f cycles the filter:
everything, user apps, system/vendor, running only. k stops the selected package with `am force-stop`
and reports what actually happened, not what the command said: the pid is read before and after, because
`am force-stop` prints nothing and exits 0 even for a package that does not exist, and a persistent
system process comes back or is never killed at all. A package the shell cannot stop - the framework,
or System UI - is refused by the app rather than taken down for a keypress. Liveness comes from `ps -A`,
whose process names are package ids here; the line under the list says how many names that was and how
many of them are vendor services rather than packages.

Press i to install an APK that sits on this machine. That opens a picker: it lists the current
directory's subdirectories and its `*.apk` files, so a directory full of other files still shows the 2
APKs in it. Arrows select, Enter opens a directory or installs the selected APK, Backspace goes up one
level, h jumps to the home directory, Esc returns to the app list. A file dialog would have taken the
terminal's focus away from the TUI, so the walk happens in the TUI itself.

Inside the picker, p is the path prompt: type or paste a path and press Enter, for a file the picker
does not list. `~` is expanded and a relative path is resolved against the current directory, so pasting
from a file manager works. Progress and the result share one line, and the result is the device's own
verdict rather than the exit code: adb can exit 0 while printing `Failure [INSTALL_FAILED_...]`, and the
reason is what gets shown, with a hint underneath for the common ones (a downgrade needs `install -d`, a
signature mismatch means the installed app was signed with a different key).

Split APKs and app bundles (`.apkm`, `.xapk`) are not supported: those are zips holding a base APK and
its split configs, and installing them means unpacking first and calling `install-multiple`. Node has
no zip reader built in, so that would be a small module of its own.

## Device history

Devices are remembered with their address, MAC and label, so they can be reconnected or woken without
retyping anything. Only devices that are not currently connected appear in the selector, and x forgets
one. State lives in `~/.config/zapette/`.

