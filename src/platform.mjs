// Platform differences live here, so nothing else has to branch on them.
//
// `platformKey()` matches the naming OpenTUI uses for its own native packages
// (darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64, win32-arm64),
// which is also the naming used for the directories under assets/platform-tools/.
import { homedir } from "node:os"
import { join } from "node:path"

/** "darwin-arm64", "linux-x64", "win32-x64", … */
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

/** Bun's name for the same target: "bun-darwin-arm64", "bun-windows-x64", … */
export function bunTarget(platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "windows" : platform
  return `bun-${os}-${arch}`
}

/** Per-user cache directory, following each platform's own convention. */
export function cacheDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === "darwin") return join(home, "Library", "Caches")
  if (platform === "win32") return env.LOCALAPPDATA || join(home, "AppData", "Local")
  return env.XDG_CACHE_HOME || join(home, ".cache")
}

/** Where this app keeps state: devices.json, apps.json. */
export function stateDir(platform = process.platform, env = process.env, home = homedir()) {
  const base =
    env.XDG_CONFIG_HOME ||
    (platform === "win32" ? env.APPDATA || join(home, "AppData", "Roaming") : join(home, ".config"))
  return join(base, "zapette")
}

/** adb is `adb` everywhere except Windows, where it is `adb.exe`. */
export function adbName(platform = process.platform) {
  return platform === "win32" ? "adb.exe" : "adb"
}

/**
 * Windows adb will not start without these next to adb.exe: AdbWinApi.dll is
 * linked by the executable itself, AdbWinUsbApi.dll is only needed for USB.
 */
export const WINDOWS_ADB_FILES = ["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll"]

/** Every file that has to be present for adb to work on a platform. */
export function adbFiles(platform = process.platform) {
  return platform === "win32" ? WINDOWS_ADB_FILES : [adbName(platform)]
}

/** "darwin-x64" → { platform: "darwin", arch: "x64" } */
export function splitKey(key) {
  const i = key.lastIndexOf("-")
  return { platform: key.slice(0, i), arch: key.slice(i + 1) }
}

/** Google's platform-tools download for a target, or null when none exists. */
export function platformToolsUrl(key) {
  const { platform, arch } = splitKey(key)
  // Google ships one macOS build (universal: x86_64 + arm64) and x64 builds for
  // Linux and Windows. There is no official arm64 Linux or arm64 Windows build.
  if (platform === "darwin") return "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip"
  if (platform === "linux" && arch === "x64") return "https://dl.google.com/android/repository/platform-tools-latest-linux.zip"
  if (platform === "win32" && arch === "x64") return "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"
  return null
}
