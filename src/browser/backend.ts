import path from "node:path";
import { execFileSync } from "node:child_process";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

/**
 * Dedicated-browser backend selection and verification (issue #9).
 *
 * Two supported backends, selected explicitly — never an unqualified
 * `browser.open`:
 *
 * - `omp`: OMP-managed dedicated Chromium (preferred where it launches).
 * - `cdp`: an existing Chromium-family CDP endpoint running with an
 *   isolated, dedicated profile (the verified WSL2 fallback: Windows
 *   Edge started with `--remote-debugging-port` and `--user-data-dir`).
 *
 * Relaying into the user's daily browser is never a default backend.
 */

export type BrowserBackend = "omp" | "cdp";

export interface BrowserConfig {
  backend: BrowserBackend;
  /** CDP endpoint, e.g. http://127.0.0.1:9223 (cdp backend only). */
  cdpUrl?: string;
  /** Dedicated profile directory the endpoint's browser must run with. */
  profileDir?: string;
  updatedAt?: string;
}

/** Default WSL2 fallback: dedicated Windows Edge CDP profile. */
export const DEFAULT_CDP_URL = "http://127.0.0.1:9223";
export const DEFAULT_CDP_PROFILE_DIR = String.raw`C:\Temp\omp-c2c-edge-profile`;

/**
 * Well-known DEFAULT browser profile locations. A configured profileDir
 * inside one of these is the user's daily browser, not a dedicated
 * automation profile, and is rejected.
 */
const DAILY_PROFILE_MARKERS = [
  String.raw`Microsoft\Edge\User Data`,
  String.raw`Google\Chrome\User Data`,
  "microsoft-edge",
  ".config/google-chrome",
  ".config/chromium",
];

export function browserConfigFile(): string {
  return path.join(getStateDir(), "browser.json");
}

function isDailyProfile(profileDir: string): boolean {
  const normalized = profileDir.replace(/\//g, "\\").toLowerCase();
  return DAILY_PROFILE_MARKERS.some((marker) =>
    normalized.includes(marker.replace(/\//g, "\\").toLowerCase())
  );
}

export function readBrowserConfig(): BrowserConfig | null {
  const raw = readJsonIfExists<BrowserConfig>(browserConfigFile());
  if (!raw || (raw.backend !== "omp" && raw.backend !== "cdp")) return null;
  return raw;
}

/**
 * Resolve the effective backend: environment overrides win over the stored
 * config; without either, the default is OMP-managed Chromium.
 */
export function resolveBrowserConfig(env: NodeJS.ProcessEnv = process.env): BrowserConfig {
  const envBackend = env.C2C_BROWSER_BACKEND;
  const stored = readBrowserConfig();
  const backend: BrowserBackend =
    envBackend === "omp" || envBackend === "cdp" ? envBackend : (stored?.backend ?? "omp");
  const cdpUrl = env.C2C_BROWSER_CDP_URL ?? stored?.cdpUrl;
  const profileDir = env.C2C_BROWSER_PROFILE ?? stored?.profileDir;
  return { backend, cdpUrl, profileDir };
}

export function saveBrowserConfig(config: BrowserConfig): BrowserConfig {
  if (config.backend === "cdp") {
    if (!config.cdpUrl) {
      throw new Error("cdp backend requires --cdp-url (e.g. http://127.0.0.1:9223)");
    }
    if (!config.profileDir) {
      throw new Error(
        "cdp backend requires --profile-dir naming the dedicated profile the endpoint runs with"
      );
    }
    if (isDailyProfile(config.profileDir)) {
      throw new Error(
        `refusing daily-browser profile "${config.profileDir}"; choose a dedicated directory (e.g. ${DEFAULT_CDP_PROFILE_DIR})`
      );
    }
  }
  const stored: BrowserConfig = { ...config, updatedAt: new Date().toISOString() };
  writeSecureJson(browserConfigFile(), stored);
  return stored;
}

export type BrowserVerification =
  | { ok: true; detail: string }
  | { ok: false; reason: string; action: string };

interface CdpVersionProbe {
  Browser?: string;
  webSocketDebuggerUrl?: string;
}

/** Probe a CDP endpoint's /json/version. Exported for tests. */
export async function probeCdpEndpoint(
  cdpUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; browser: string } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await fetchImpl(`${cdpUrl.replace(/\/+$/, "")}/json/version`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { ok: false, reason: `no CDP endpoint answering at ${cdpUrl}` };
  }
  if (!response.ok) {
    return { ok: false, reason: `${cdpUrl}/json/version returned HTTP ${response.status}` };
  }
  let body: CdpVersionProbe;
  try {
    body = (await response.json()) as CdpVersionProbe;
  } catch {
    return { ok: false, reason: `${cdpUrl}/json/version did not return JSON` };
  }
  const browser = body.Browser ?? "";
  // Chromium-family markers: "Chrome/...", "Chromium/...", "Edg/...".
  if (!/(chrom|edg)/i.test(browser)) {
    return { ok: false, reason: `endpoint is not Chromium-family (Browser="${browser}")` };
  }
  return { ok: true, browser };
}

/**
 * On WSL2, read the command line of the Windows browser process serving
 * the given CDP port, so the configured dedicated profile can be verified
 * against reality instead of assumed. Returns null when the check is not
 * possible on this platform.
 */
export function readWindowsBrowserCommandLine(port: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-c",
        // Match browser executables only: an unfiltered match would find
        // this probe's own powershell.exe command line (it contains the
        // search pattern).
        `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'remote-debugging-port=${port}' -and $_.Name -match 'msedge|chrome|chromium' } | Select-Object -First 1 -ExpandProperty CommandLine)`,
      ],
      { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }
    );
    const trimmed = out.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

function extractProfileDir(commandLine: string): string | null {
  const match = commandLine.match(/--user-data-dir=("([^"]+)"|(\S+))/);
  return match?.[2] ?? match?.[3] ?? null;
}

/**
 * Verify the configured backend before any ChatGPT use.
 *
 * - omp backend: nothing to verify here (OMP launches and owns its
 *   dedicated Chromium at browser.open time); report the prerequisite
 *   action when the platform is the known-broken WSL2 local Chromium.
 * - cdp backend: the endpoint must answer, be Chromium-family, and — when
 *   the Windows process command line is readable — run with the configured
 *   dedicated profile directory.
 */
export async function verifyBrowserBackend(
  config: BrowserConfig,
  fetchImpl: typeof fetch = fetch
): Promise<BrowserVerification> {
  if (config.backend === "omp") {
    return {
      ok: true,
      detail:
        "backend=omp: OMP-managed dedicated Chromium; identity is established at browser.open time (app profile owned by OMP)",
    };
  }

  const cdpUrl = config.cdpUrl ?? DEFAULT_CDP_URL;
  const profileDir = config.profileDir ?? DEFAULT_CDP_PROFILE_DIR;
  if (isDailyProfile(profileDir)) {
    return {
      ok: false,
      reason: `configured profile "${profileDir}" is a daily-browser profile location`,
      action: `选择一个专用目录：c2c browser set --backend cdp --cdp-url ${cdpUrl} --profile-dir ${DEFAULT_CDP_PROFILE_DIR}`,
    };
  }

  const probe = await probeCdpEndpoint(cdpUrl, fetchImpl);
  if (!probe.ok) {
    return {
      ok: false,
      reason: probe.reason,
      action: `启动专用浏览器一次：bash scripts/wsl2-edge-cdp.sh（或手动：msedge.exe --remote-debugging-port=${new URL(cdpUrl).port || "9223"} --user-data-dir=${profileDir} about:blank）`,
    };
  }

  const port = Number(new URL(cdpUrl).port || "9223");
  const commandLine = readWindowsBrowserCommandLine(port);
  if (commandLine !== null) {
    const actualProfile = extractProfileDir(commandLine);
    if (!actualProfile) {
      return {
        ok: false,
        reason: `endpoint ${cdpUrl} browser runs without a dedicated --user-data-dir`,
        action: `重启专用浏览器：bash scripts/wsl2-edge-cdp.sh`,
      };
    }
    if (actualProfile.replace(/\\+$/, "").toLowerCase() !== profileDir.replace(/\\+$/, "").toLowerCase()) {
      return {
        ok: false,
        reason: `endpoint ${cdpUrl} runs with profile "${actualProfile}", not the configured "${profileDir}"`,
        action: `修正配置或重启专用浏览器：c2c browser set --backend cdp --cdp-url ${cdpUrl} --profile-dir "${actualProfile}"，或 bash scripts/wsl2-edge-cdp.sh`,
      };
    }
    return {
      ok: true,
      detail: `backend=cdp: ${probe.browser} at ${cdpUrl}, verified dedicated profile ${actualProfile}`,
    };
  }

  // Cannot read the browser process on this platform: endpoint identity is
  // verified, profile identity is pinned by config and the launch script.
  return {
    ok: true,
    detail: `backend=cdp: ${probe.browser} at ${cdpUrl}; profile identity pinned to ${profileDir} by config (process check unavailable on this platform)`,
  };
}
