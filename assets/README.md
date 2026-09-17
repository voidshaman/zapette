# assets/

`adb` is the Android platform-tools debug bridge (version 37.0.1, unmodified,
universal x86_64 + arm64 build), redistributed under the Apache License 2.0 —
see `NOTICE.txt`. It is embedded into the compiled executable by
`bun build --compile` and extracted to the user cache dir at first run, so the
binary needs no adb install on the target machine.
