# Building and platforms

Standalone binaries and the per-platform differences. Only three things in the app are
written per platform: where cache and settings live, how the neighbour cache is read, and
the name of the adb executable.

## Build a standalone binary

    npm run build:exe                            # this machine, adb embedded
    npm run build:exe:slim                       # same, but uses the adb on PATH
    node scripts/build.mjs --target linux-x64    # cross-build, installs that target's libraries
    node scripts/build.mjs --all                 # every supported target

The result needs no Node, no Bun and no adb on the target. Builds are per platform and architecture.

## Platforms

macOS (Intel and Apple Silicon), Linux and Windows, on x64 and arm64. Only three things in the app are
written per platform: where the cache and settings live, how the system's neighbour cache is read to
find the TV's MAC, and the name of the adb executable. The interface library ships prebuilt binaries
for all of these systems.

    npm run fetch:adb -- --target win32-x64      # platform-tools for a platform you build for

`npm run fetch:adb` on its own fetches for the machine you are on. Google publishes no arm64
platform-tools for Linux or Windows, so those two use the adb on PATH. `npm test` covers the
platform-specific code, including the neighbour-cache output of all three systems and the archive a
compiled binary unpacks its adb from.

A compiled binary unpacks its adb the first time it needs it, into
`<cache>/tv-remote-tui/platform-tools/<platform>-<arch>/`. On Windows that includes the two DLLs adb
will not start without. Cross-building installs the target's interface library first, which npm only
accepts with `--force` because the package declares another system. Linux needs both its glibc and
its musl build present. A build for a platform you are not on is produced but not exercised by the
build itself: the Linux x64 binary here was run in a Debian container, and it connected to the TV
using its own embedded adb.

