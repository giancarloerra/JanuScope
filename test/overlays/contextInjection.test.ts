import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextInjectionOverlay } from "../../src/overlays/contextInjection.js";
import { Pipeline } from "../../src/pipeline.js";
import type { JsonRpcMessage } from "../../src/rpc.js";

function makePipeline(options: Parameters<typeof createContextInjectionOverlay>[0]): {
  pipeline: Pipeline;
  toClient: JsonRpcMessage[];
  logs: Array<{ level: string; message: string }>;
} {
  const toClient: JsonRpcMessage[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const pipeline = new Pipeline([createContextInjectionOverlay(options)], {
    onForwardToTarget: () => {},
    onForwardToClient: (m) => toClient.push(m),
    log: (level, _ns, message) => logs.push({ level, message }),
  });
  return { pipeline, toClient, logs };
}

const SAMPLE_TOOLS = [
  { name: "list_issues", description: "List Linear issues" },
  { name: "get_issue", description: "Fetch a single issue by id" },
  { name: "create_issue", description: "Create a new issue" },
];

describe("contextInjection overlay", () => {
  it("appends inline text to the description of every named tool", async () => {
    const { pipeline, toClient } = makePipeline({
      injectInto: ["list_issues", "get_issue"],
      text: "Active projects: PROJ-A, PROJ-B, PROJ-C.",
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: SAMPLE_TOOLS },
    });

    const result = (
      toClient[0] as { result: { tools: Array<{ name: string; description: string }> } }
    ).result;
    const byName = Object.fromEntries(result.tools.map((t) => [t.name, t.description]));
    expect(byName.list_issues).toBe(
      "List Linear issues\n\nActive projects: PROJ-A, PROJ-B, PROJ-C.",
    );
    expect(byName.get_issue).toBe(
      "Fetch a single issue by id\n\nActive projects: PROJ-A, PROJ-B, PROJ-C.",
    );
    // Untargeted tool is left alone.
    expect(byName.create_issue).toBe("Create a new issue");
  });

  it("prepends when position: 'prepend'", async () => {
    const { pipeline, toClient } = makePipeline({
      injectInto: ["list_issues"],
      text: "POLICY: read-only.",
      position: "prepend",
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: SAMPLE_TOOLS },
    });
    const result = (
      toClient[0] as { result: { tools: Array<{ name: string; description: string }> } }
    ).result;
    const desc = result.tools.find((t) => t.name === "list_issues")!.description;
    expect(desc).toBe("POLICY: read-only.\n\nList Linear issues");
  });

  it("reads text from textFile (absolute path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "januscope-ci-"));
    const file = join(dir, "context.md");
    writeFileSync(file, "Stable context loaded from disk.");

    const { pipeline, toClient } = makePipeline({
      injectInto: ["list_issues"],
      textFile: file,
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: SAMPLE_TOOLS },
    });
    const result = (
      toClient[0] as { result: { tools: Array<{ name: string; description: string }> } }
    ).result;
    expect(result.tools.find((t) => t.name === "list_issues")!.description).toContain(
      "Stable context loaded from disk.",
    );
  });

  it("handles a tool with no description by treating it as empty", async () => {
    const { pipeline, toClient } = makePipeline({
      injectInto: ["bare"],
      text: "Context for the bare tool.",
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "bare" }] },
    });
    const result = (
      toClient[0] as { result: { tools: Array<{ name: string; description: string }> } }
    ).result;
    // No leading newlines when there was no upstream description.
    expect(result.tools[0]!.description).toBe("Context for the bare tool.");
  });

  it("preserves arbitrary extra fields on tools (forward-compat)", async () => {
    const { pipeline, toClient } = makePipeline({
      injectInto: ["x"],
      text: "ctx",
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "x",
            description: "X",
            inputSchema: { type: "object" },
            annotations: { destructiveHint: false },
          },
        ],
      },
    });
    const tool = (toClient[0] as { result: { tools: Array<Record<string, unknown>> } }).result
      .tools[0]!;
    expect(tool.inputSchema).toEqual({ type: "object" });
    expect(tool.annotations).toEqual({ destructiveHint: false });
  });

  it("forwards non-tools/list responses unchanged", async () => {
    const { pipeline, toClient } = makePipeline({
      injectInto: ["x"],
      text: "ctx",
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "hello" }] },
    });
    expect((toClient[0] as { result: unknown }).result).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("becomes a no-op (with a warning) when the text is whitespace-only", async () => {
    const { pipeline, toClient, logs } = makePipeline({
      injectInto: ["list_issues"],
      text: "   \n  \n",
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: SAMPLE_TOOLS },
    });
    // Original description is preserved (no spurious whitespace appended).
    const result = (
      toClient[0] as { result: { tools: Array<{ name: string; description: string }> } }
    ).result;
    expect(result.tools.find((t) => t.name === "list_issues")!.description).toBe(
      "List Linear issues",
    );
    expect(logs.some((l) => l.level === "warn" && /empty/.test(l.message))).toBe(true);
  });

  it("throws at construction when both text and textFile are set", () => {
    expect(() =>
      createContextInjectionOverlay({
        injectInto: ["x"],
        text: "inline",
        textFile: "/tmp/whatever.md",
      }),
    ).toThrow(/exactly one of/);
  });

  it("throws at construction when neither text nor textFile is set", () => {
    expect(() => createContextInjectionOverlay({ injectInto: ["x"] })).toThrow(/exactly one of/);
  });

  it("throws at construction when textFile points at a missing path", () => {
    expect(() =>
      createContextInjectionOverlay({
        injectInto: ["x"],
        textFile: "/definitely/does/not/exist.md",
      }),
    ).toThrow(/could not read textFile/);
  });

  it("does nothing when the targeted tool isn't in the response (silently skip)", async () => {
    const { pipeline, toClient } = makePipeline({
      injectInto: ["nonexistent_tool"],
      text: "ctx",
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: SAMPLE_TOOLS },
    });
    const result = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result;
    // Every tool's description is unchanged (the targeted tool simply
    // wasn't there to inject into; the upstream surface passes through).
    expect(result.tools.map((t) => t.description)).toEqual([
      "List Linear issues",
      "Fetch a single issue by id",
      "Create a new issue",
    ]);
  });
});
