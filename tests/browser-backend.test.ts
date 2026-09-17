import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CDP_PROFILE_DIR,
  probeCdpEndpoint,
  readBrowserConfig,
  resolveBrowserConfig,
  saveBrowserConfig,
  verifyBrowserBackend,
} from "../src/browser/backend.js";
import { cleanup, isolateStateDir } from "./helpers.js";

describe("browser backend selection and verification", () => {
  const dirs: string[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    for (const server of servers.splice(0)) {
      const { promise, resolve } = Promise.withResolvers<unknown>();
      server.close(resolve);
      await promise;
    }
    delete process.env.C2C_BROWSER_CDP_URL;
    delete process.env.C2C_BROWSER_PROFILE;
    delete process.env.C2C_STATE_DIR;
  });

  function setup(): string {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    return stateDir;
  }

  async function fakeCdp(body: unknown, status = 200): Promise<string> {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    servers.push(server);
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", resolve);
    await promise;
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("no address");
    return `http://127.0.0.1:${address.port}`;
  }

  it("defaults to the omp backend and lets env override stored config", () => {
    setup();
    expect(resolveBrowserConfig({} as NodeJS.ProcessEnv).backend).toBe("omp");
    saveBrowserConfig({
      backend: "cdp",
      cdpUrl: "http://127.0.0.1:9223",
      profileDir: DEFAULT_CDP_PROFILE_DIR,
    });
    expect(resolveBrowserConfig({} as NodeJS.ProcessEnv).backend).toBe("cdp");
    process.env.C2C_BROWSER_BACKEND = "omp";
    expect(resolveBrowserConfig().backend).toBe("omp");
    expect(readBrowserConfig()?.backend).toBe("cdp");
  });

  it("rejects a daily-browser profile directory at the config boundary", () => {
    setup();
    expect(() =>
      saveBrowserConfig({
        backend: "cdp",
        cdpUrl: "http://127.0.0.1:9223",
        profileDir: String.raw`C:\Users\me\AppData\Local\Microsoft\Edge\User Data`,
      })
    ).toThrowError(/daily-browser profile/);
    expect(() => saveBrowserConfig({ backend: "cdp" })).toThrowError(/--cdp-url/);
    expect(readBrowserConfig()).toBeNull();
  });

  it("verification fails with one clear action when the endpoint is down", async () => {
    setup();
    const result = await verifyBrowserBackend({
      backend: "cdp",
      cdpUrl: "http://127.0.0.1:9", // nothing listens here
      profileDir: DEFAULT_CDP_PROFILE_DIR,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("no CDP endpoint");
      expect(result.action).toContain("wsl2-edge-cdp.sh");
    }
  });

  it("verification rejects a non-Chromium endpoint", async () => {
    setup();
    const url = await fakeCdp({ Browser: "Safari/26.0" });
    const probe = await probeCdpEndpoint(url);
    expect(probe.ok).toBe(false);
    const result = await verifyBrowserBackend({
      backend: "cdp",
      cdpUrl: url,
      profileDir: DEFAULT_CDP_PROFILE_DIR,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not Chromium-family");
  });

  it("verification accepts a Chromium-family endpoint (profile pinned by config off-WSL2)", async () => {
    setup();
    const url = await fakeCdp({ Browser: "Edg/153.0.4234.32" });
    const result = await verifyBrowserBackend({
      backend: "cdp",
      cdpUrl: url,
      profileDir: DEFAULT_CDP_PROFILE_DIR,
    });
    // On WSL2 with no matching Windows process the command-line check
    // returns null and the config pins the profile; either way it passes.
    expect(result.ok).toBe(true);
  });

  it("verification rejects a daily profile even when the endpoint answers", async () => {
    setup();
    const url = await fakeCdp({ Browser: "Chrome/131.0.0.0" });
    const result = await verifyBrowserBackend({
      backend: "cdp",
      cdpUrl: url,
      profileDir: "/home/me/.config/google-chrome",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("daily-browser profile");
      expect(result.action).toContain("c2c browser set");
    }
  });

  it("omp backend verifies trivially and never touches CDP", async () => {
    setup();
    const result = await verifyBrowserBackend({ backend: "omp" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.detail).toContain("backend=omp");
  });
});
