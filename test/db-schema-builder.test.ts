import { afterEach, expect, it, vi } from "vitest";
import { buildOverlays } from "../src/index.js";
import { OverlayConfigSchema } from "../src/config.js";
import { Pipeline } from "../src/pipeline.js";
import { postgresDriver } from "../src/overlays/db-schema/drivers/postgres.js";
import type { JsonRpcMessage } from "../src/rpc.js";

afterEach(() => vi.restoreAllMocks());

it.each([{ schemas: ["analytics", "core"] }, { schemas: undefined }])(
  "carries configured schemas through the production builder without changing the default",
  async ({ schemas }) => {
    const introspect = vi
      .spyOn(postgresDriver, "introspect")
      .mockImplementation(async (_, options) => ({
        dialect: "postgres",
        tables: (options.schemas ?? ["public"]).map((schema) => ({
          name: schema + "_table",
          columns: [],
          primaryKey: [],
          foreignKeys: [],
        })),
      }));
    const config = OverlayConfigSchema.parse({
      target: { command: "node" },
      dbSchema: {
        connectionString: "postgresql://synthetic.invalid/example",
        ...(schemas ? { schemas } : {}),
      },
    });
    const output: JsonRpcMessage[] = [];
    const pipeline = new Pipeline(buildOverlays(config), {
      onForwardToClient: (msg) => output.push(msg),
      onForwardToTarget: () => {},
      log: () => {},
    });
    await pipeline.start();
    const options = introspect.mock.calls[0]![1];
    if (!schemas) expect(options).not.toHaveProperty("schemas");
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "query", description: "Run SQL" }] },
    });
    const response = output[0] as { result: { tools: Array<{ description: string }> } };
    const description = response.result.tools[0]!.description;
    for (const schema of schemas ?? ["public"]) expect(description).toContain(schema + "_table");
    if (schemas) expect(description).not.toContain("public_table");
    await pipeline.stop();
  },
);
