import { describe, it, expect } from "vitest";
import { createInstructionsOverlay } from "../../src/overlays/instructions.js";
import { Pipeline } from "../../src/pipeline.js";
import type { JsonRpcMessage } from "../../src/rpc.js";

function pipelineFor(text: string): { pipeline: Pipeline; toClient: JsonRpcMessage[] } {
  const toClient: JsonRpcMessage[] = [];
  const pipeline = new Pipeline([createInstructionsOverlay({ text })], {
    onForwardToTarget: () => {},
    onForwardToClient: (m) => toClient.push(m),
    log: () => {},
  });
  return { pipeline, toClient };
}

describe("instructions overlay", () => {
  it("appends text to existing descriptions", async () => {
    const { pipeline, toClient } = pipelineFor("READ-ONLY access.");
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [{ name: "query", description: "Run a SQL query." }],
      },
    });
    const tools = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result
      .tools;
    expect(tools[0]!.description).toBe("Run a SQL query.\n\n---\nREAD-ONLY access.");
  });

  it("uses instructions as description if tool has none", async () => {
    const { pipeline, toClient } = pipelineFor("policy");
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "echo" }] },
    });
    const tools = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result
      .tools;
    expect(tools[0]!.description).toBe("policy");
  });

  it("preserves other fields on the tool", async () => {
    const { pipeline, toClient } = pipelineFor("policy");
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "query",
            description: "x",
            inputSchema: { type: "object", properties: { sql: { type: "string" } } },
            annotations: { idempotent: true },
          },
        ],
      },
    });
    const tool = (toClient[0] as { result: { tools: Array<Record<string, unknown>> } }).result
      .tools[0];
    expect(tool).toMatchObject({
      name: "query",
      inputSchema: { type: "object" },
      annotations: { idempotent: true },
    });
  });

  it("is a no-op with empty text", async () => {
    const { pipeline, toClient } = pipelineFor("");
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "echo", description: "e" }] },
    });
    const tool = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result
      .tools[0];
    expect(tool!.description).toBe("e");
  });

  it("trims whitespace from instructions", async () => {
    const { pipeline, toClient } = pipelineFor("  padded  \n");
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "echo", description: "e" }] },
    });
    const tool = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result
      .tools[0];
    expect(tool!.description).toBe("e\n\n---\npadded");
  });

  it("does not touch non-tools/list responses", async () => {
    const { pipeline, toClient } = pipelineFor("x");
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

  it("prepends a SENSITIVE banner when classification is sensitive", async () => {
    const toClient: JsonRpcMessage[] = [];
    const pipeline = new Pipeline(
      [createInstructionsOverlay({ text: "READ-ONLY.", classification: "sensitive" })],
      {
        onForwardToTarget: () => {},
        onForwardToClient: (m) => toClient.push(m),
        log: () => {},
      },
    );
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "query", description: "Run SQL." }] },
    });
    const tools = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result
      .tools;
    // Banner → blank line → user policy, appended after the existing description.
    expect(tools[0]!.description).toContain("CLASSIFICATION: SENSITIVE");
    expect(tools[0]!.description).toContain("READ-ONLY.");
    // User policy must come AFTER the banner.
    const banner = tools[0]!.description.indexOf("CLASSIFICATION: SENSITIVE");
    const policy = tools[0]!.description.indexOf("READ-ONLY.");
    expect(banner).toBeLessThan(policy);
  });

  it("emits just the banner when instructions text is empty but classification is set", async () => {
    const toClient: JsonRpcMessage[] = [];
    const pipeline = new Pipeline(
      [createInstructionsOverlay({ text: "", classification: "internal" })],
      {
        onForwardToTarget: () => {},
        onForwardToClient: (m) => toClient.push(m),
        log: () => {},
      },
    );
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "echo" }] },
    });
    const tools = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result
      .tools;
    expect(tools[0]!.description).toMatch(/^CLASSIFICATION: INTERNAL/);
  });

  it("is a no-op when both text and classification are absent", async () => {
    const toClient: JsonRpcMessage[] = [];
    const pipeline = new Pipeline([createInstructionsOverlay({ text: "" })], {
      onForwardToTarget: () => {},
      onForwardToClient: (m) => toClient.push(m),
      log: () => {},
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "echo", description: "e" }] },
    });
    const tool = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result
      .tools[0];
    expect(tool!.description).toBe("e");
  });

  // Position support: lead with the policy by setting position: prepend.
  // The model-compliance argument lives in CONTRIBUTING.md / SECURITY.md;
  // here we just pin the splice mechanics.
  it("prepends when position: 'prepend'", async () => {
    const toClient: JsonRpcMessage[] = [];
    const pipeline = new Pipeline(
      [createInstructionsOverlay({ text: "POLICY ALPHA", position: "prepend" })],
      {
        onForwardToTarget: () => {},
        onForwardToClient: (m) => toClient.push(m),
        log: () => {},
      },
    );
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "echo", description: "Echo back the input." }] },
    });
    const desc = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result
      .tools[0]!.description;
    // Policy text leads, separator, then upstream description.
    expect(desc.startsWith("POLICY ALPHA")).toBe(true);
    expect(desc).toMatch(/POLICY ALPHA[\s\S]+Echo back the input\./);
  });

  it("appends when position: 'append' (default, backwards compat)", async () => {
    const toClient: JsonRpcMessage[] = [];
    const pipeline = new Pipeline([createInstructionsOverlay({ text: "POLICY BETA" })], {
      onForwardToTarget: () => {},
      onForwardToClient: (m) => toClient.push(m),
      log: () => {},
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "echo", description: "Echo back the input." }] },
    });
    const desc = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result
      .tools[0]!.description;
    expect(desc.startsWith("Echo back the input.")).toBe(true);
    expect(desc).toMatch(/Echo back the input\.[\s\S]+POLICY BETA/);
  });

  it("prepend with classification puts banner+policy before description", async () => {
    const toClient: JsonRpcMessage[] = [];
    const pipeline = new Pipeline(
      [
        createInstructionsOverlay({
          text: "POLICY GAMMA",
          classification: "sensitive",
          position: "prepend",
        }),
      ],
      {
        onForwardToTarget: () => {},
        onForwardToClient: (m) => toClient.push(m),
        log: () => {},
      },
    );
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "echo", description: "upstream desc" }] },
    });
    const desc = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result
      .tools[0]!.description;
    // Banner first, then policy, then upstream — that is the lead-with-
    // policy ordering reviewers expect.
    expect(desc.startsWith("CLASSIFICATION: SENSITIVE")).toBe(true);
    const bannerIdx = desc.indexOf("CLASSIFICATION: SENSITIVE");
    const policyIdx = desc.indexOf("POLICY GAMMA");
    const upstreamIdx = desc.indexOf("upstream desc");
    expect(bannerIdx).toBeLessThan(policyIdx);
    expect(policyIdx).toBeLessThan(upstreamIdx);
  });
});
