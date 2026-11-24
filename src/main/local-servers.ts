// Web servers listening on this computer (for the Browser pane's quick links): ports 1024 and up,
// on localhost or all addresses, with the program's name where it's ours to see. Linux reads /proc;
// other systems return nothing for now.

import { readFileSync, readdirSync, readlinkSync } from "node:fs";

const LISTEN = "0A";
/** Common ports that aren't web pages (databases, debuggers, desktop services). */
const NOT_WEB = new Set([3306, 5432, 6379, 27017, 9229, 9222, 5037, 631, 1716]);

/** /proc/net addresses are hex, each 32-bit word little-endian: 127.x.x.x ends in 7F. */
function isLoopOrAny(a: string): boolean {
  if (a.length === 8) return a === "00000000" || a.endsWith("7F");                       // IPv4 any, 127.x
  return a === "0".repeat(32) || a === "00000000000000000000000001000000"                 // IPv6 any, ::1
    || (a.startsWith("0000000000000000FFFF0000") && a.endsWith("7F"));                    // ::ffff:127.x
}

function listeningInodes(): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let rows: string[];
    try { rows = readFileSync(f, "utf8").trim().split("\n").slice(1); } catch { continue; }
    for (const row of rows) {
      const c = row.trim().split(/\s+/);
      if (c[3] !== LISTEN) continue;
      const [addr, portHex] = c[1]!.split(":");
      // Loopback (127.x / ::1) or any-address only: not ones bound to some other interface.
      const loopOrAny = isLoopOrAny(addr!.toUpperCase());
      const port = parseInt(portHex!, 16);
      // 32768 and up is where the system hands out temporary ports (programs' internal servers).
      if (!loopOrAny || port < 1024 || port >= 32768 || NOT_WEB.has(port)) continue;
      out.set(c[9]!, port);
    }
  }
  return out;
}

export function localServers(): { port: number; name?: string }[] {
  if (process.platform !== "linux") return [];
  const inodes = listeningInodes();
  const names = new Map<number, string>();
  // Match sockets to processes we're allowed to look at (our own user's).
  try {
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      let fds: string[];
      try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        let link: string;
        try { link = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        const m = /^socket:\[(\d+)\]$/.exec(link);
        const port = m && inodes.get(m[1]!);
        if (port && !names.has(port)) { try { names.set(port, readFileSync(`/proc/${pid}/comm`, "utf8").trim()); } catch { /* gone */ } }
      }
    }
  } catch { /* /proc unreadable */ }
  const ports = [...new Set(inodes.values())].sort((a, b) => a - b);
  // Only servers started by this user (their program is visible); others are system services.
  return ports.filter((p) => names.has(p) && !/^(electron|agent-zoo|prompt-habitat|chrome|code|claude|codex|grok)$/i.test(names.get(p)!)).map((port) => ({ port, name: names.get(port) }));
}
