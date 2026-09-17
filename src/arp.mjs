// Per-platform ARP lookup: the MAC has to come from the host's neighbour cache,
// because the device-side /sys/class/net/*/address is closed to the shell user.
//
// The three systems print the same information in three different shapes, and
// each one has its own idea of "no entry":
//
//   macOS   ? (192.168.1.50) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]
//           ? (192.168.1.50) at (incomplete) on en0 ifscope [ethernet]
//   Linux   192.168.1.50 ether aa:bb:cc:dd:ee:ff C eth0            (net-tools)
//           192.168.1.50 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE  (iproute2)
//   Windows   192.168.1.50       aa-bb-cc-dd-ee-ff     dynamic
//             192.168.1.50       00-00-00-00-00-00     invalid
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileP = promisify(execFile)

// macOS prints a short first octet ("8:c3:..."), Windows uses dashes. Allow 1-2
// hex digits per octet and both separators, and require the match to be a
// standalone token — an IPv6 address in Windows output would otherwise match
// with its last six groups.
const MAC_RE = /(?:^|[\s(])((?:[0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2})(?=[\s),]|$)/i

export function normalizeMac(text) {
  return String(text)
    .split(/[:-]/)
    .map((octet) => octet.padStart(2, "0").toLowerCase())
    .join(":")
}

export function parseMac(text) {
  const m = MAC_RE.exec(String(text ?? ""))
  if (!m) return null
  const mac = normalizeMac(m[1])
  return mac === "00:00:00:00:00:00" ? null : mac
}

/** Candidate lookups for a platform, most likely first. */
export function arpCommands(ip, platform = process.platform) {
  if (platform === "win32") return [["arp", ["-a", ip]]]
  // `arp` is net-tools (absent on many modern Linux boxes), `ip neigh` is
  // iproute2. macOS has arp and no ip, Linux may have either.
  return [
    ["arp", ["-n", ip]],
    ["ip", ["neigh", "show", ip]],
  ]
}

/** Pull the MAC for `ip` out of whatever the platform printed. */
export function parseArp(text, ip) {
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^interface:/i.test(line)) continue // Windows header row
    if (/incomplete|\binvalid\b/i.test(line)) continue
    if (ip && !line.includes(ip)) continue
    const mac = parseMac(line)
    if (mac) return mac
  }
  return null
}

/**
 * The device's MAC as the host's neighbour cache knows it. `run` is injectable
 * so the platform parsers can be tested without those platforms.
 */
export async function arpMac(ip, { platform = process.platform, run } = {}) {
  if (!ip) return null
  const exec =
    run ??
    ((cmd, args) =>
      execFileP(cmd, args, { timeout: 5000, encoding: "utf8" }).then(
        ({ stdout }) => stdout,
        () => "",
      ))
  for (const [cmd, args] of arpCommands(ip, platform)) {
    let out = ""
    try {
      out = await exec(cmd, args)
    } catch {
      continue // e.g. net-tools' `arp` is not installed on this Linux box
    }
    const mac = parseArp(out, ip)
    if (mac) return mac
  }
  return null
}
