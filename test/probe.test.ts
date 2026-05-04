import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { probeTarget } from "../src/probe.js";
import type { OverlayConfig } from "../src/config.js";

const FIXTURE = join(process.cwd(), "test", "fixtures", "fake-mcp-server.mjs");

function fixtureConfig(overrides: Partial<OverlayConfig["target"]> = {}): OverlayConfig {
  return {
    target: { command: "node", args: [FIXTURE], ...overrides },
  } as OverlayConfig;
}

describe("probeTarget", () => {
  it("drives initialize → notifications/initialized → tools/list and returns the tool list", async () => {
    const result = await probeTarget(fixtureConfig(), { timeoutMs: 30_000 });
    expect(result.serverInfo.name).toBe("fake-mcp-server");
    expect(result.serverInfo.version).toBe("0.0.1");
    expect(result.tools.map((t) => t.name).sort()).toEqual(["dangerous_delete", "echo", "query"]);
  });

  it("surfaces a clear error when the target binary doesn't exist", async () => {
    await expect(
      probeTarget({ target: { command: "/definitely/no/such/binary" } } as OverlayConfig, {
        timeoutMs: 15_000,
      }),
    ).rejects.toThrow(/probe spawn failed|target exited/);
  });

  it("rejects probe timeouts shorter than the floor (uvx / mcp-remote start-up windows)", async () => {
    await expect(probeTarget(fixtureConfig(), { timeoutMs: 1000 })).rejects.toThrow(
      /must be >= 15000ms/,
    );
  });

  // The probe is supposed to clean up the spawned target whether it
  // resolves or rejects. We can't easily inspect process tables in a
  // portable test, but if the SIGTERM path leaks a child the next
  // call will pile up file descriptors and eventually fail. Running
  // five probes in a row catches the obvious leak.
  it("can be invoked repeatedly without resource leaks", async () => {
    for (let i = 0; i < 5; i++) {
      const result = await probeTarget(fixtureConfig(), { timeoutMs: 30_000 });
      expect(result.tools).toHaveLength(3);
    }
  });
});
