import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayConfigSchema } from "../../src/config.js";
import { buildOverlays } from "../../src/index.js";
import { Pipeline } from "../../src/pipeline.js";
import type { JsonRpcMessage } from "../../src/rpc.js";
import { mysqlDriver } from "../../src/overlays/db-schema/drivers/mysql.js";
import { postgresDriver } from "../../src/overlays/db-schema/drivers/postgres.js";
import { formatSchema, type SchemaFormat } from "../../src/overlays/db-schema/format.js";
import type { IntrospectOptions, SchemaSnapshot } from "../../src/overlays/db-schema/types.js";

const adapters = vi.hoisted(() => ({
  pgConnect: vi.fn<() => Promise<void>>(),
  pgQuery: vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(),
  pgEnd: vi.fn<() => Promise<void>>(),
  mysqlConnect: vi.fn(),
  mysqlQuery: vi.fn<(sql: string, values?: unknown[]) => Promise<[unknown[], unknown]>>(),
  mysqlEnd: vi.fn<() => Promise<void>>(),
}));

vi.mock("pg", () => ({
  Client: class {
    connect = adapters.pgConnect;
    query = adapters.pgQuery;
    end = adapters.pgEnd;
  },
}));

vi.mock("mysql2/promise", () => ({
  default: { createConnection: adapters.mysqlConnect },
}));

const TABLE_COMMENT = "SYNTHETIC_TABLE_COMMENT";
const VIEW_COMMENT = "SYNTHETIC_VIEW_COMMENT";
const TABLE_COLUMN_COMMENT = "SYNTHETIC_TABLE_COLUMN_COMMENT";
const VIEW_COLUMN_COMMENT = "SYNTHETIC_VIEW_COLUMN_COMMENT";

const catalog = [
  {
    name: "customers",
    comment: TABLE_COMMENT,
    columnComment: TABLE_COLUMN_COMMENT,
    isView: false,
  },
  {
    name: "customers_view",
    comment: VIEW_COMMENT,
    columnComment: VIEW_COLUMN_COMMENT,
    isView: true,
  },
  { name: "empty_comments", comment: "", columnComment: "", isView: false },
  { name: "null_comments", comment: null, columnComment: null, isView: false },
];

function findTable(name: unknown): (typeof catalog)[number] {
  const table = catalog.find((entry) => entry.name === name);
  if (!table) throw new Error(`Unexpected synthetic table: ${String(name)}`);
  return table;
}

beforeEach(() => {
  vi.resetAllMocks();
  adapters.pgConnect.mockResolvedValue();
  adapters.pgEnd.mockResolvedValue();
  adapters.mysqlEnd.mockResolvedValue();
  adapters.mysqlConnect.mockResolvedValue({ query: adapters.mysqlQuery, end: adapters.mysqlEnd });

  adapters.pgQuery.mockImplementation(async (sql, values) => {
    if (sql.includes("obj_description")) {
      expect(sql).toContain("c.relkind IN ('r', 'v')");
      expect(values).toEqual([["public"]]);
      return {
        rows: catalog.map((table) => ({
          table_schema: "public",
          table_name: table.name,
          comment: table.comment,
        })),
      };
    }
    const table = findTable(values?.[0]);
    expect(values?.[1]).toBe("public");
    if (sql.includes("information_schema.columns")) {
      return {
        rows: [
          {
            column_name: "id",
            data_type: "integer",
            is_nullable: "NO",
            column_default: "7",
            description: table.columnComment,
          },
          {
            column_name: "owner_id",
            data_type: "integer",
            is_nullable: "YES",
            column_default: null,
            description: null,
          },
        ],
      };
    }
    if (sql.includes("FROM pg_index")) {
      return { rows: table.isView ? [] : [{ column_name: "id" }] };
    }
    if (sql.includes("information_schema.table_constraints")) {
      return {
        rows: table.isView
          ? []
          : [{ column_name: "owner_id", foreign_table: "owners", foreign_column: "id" }],
      };
    }
    throw new Error(`Unexpected PostgreSQL metadata query: ${sql}`);
  });

  adapters.mysqlQuery.mockImplementation(async (sql, values) => {
    if (sql === "SELECT DATABASE() AS db") return [[{ db: "example" }], []];
    if (sql.includes("information_schema.TABLES")) {
      expect(sql).toContain("TABLE_TYPE IN ('BASE TABLE', 'VIEW')");
      expect(values).toEqual(["example"]);
      return [
        catalog.map((table) => ({ TABLE_NAME: table.name, TABLE_COMMENT: table.comment })),
        [],
      ];
    }
    expect(values?.[0]).toBe("example");
    const table = findTable(values?.[1]);
    if (sql.includes("information_schema.COLUMNS")) {
      return [
        [
          {
            COLUMN_NAME: "id",
            COLUMN_TYPE: "int",
            IS_NULLABLE: "NO",
            COLUMN_DEFAULT: "7",
            COLUMN_COMMENT: table.columnComment,
          },
          {
            COLUMN_NAME: "owner_id",
            COLUMN_TYPE: "int",
            IS_NULLABLE: "YES",
            COLUMN_DEFAULT: null,
            COLUMN_COMMENT: null,
          },
        ],
        [],
      ];
    }
    if (sql.includes("information_schema.STATISTICS")) {
      return [table.isView ? [] : [{ COLUMN_NAME: "id" }], []];
    }
    if (sql.includes("information_schema.KEY_COLUMN_USAGE")) {
      return [
        table.isView
          ? []
          : [
              {
                COLUMN_NAME: "owner_id",
                REFERENCED_TABLE_NAME: "owners",
                REFERENCED_COLUMN_NAME: "id",
              },
            ],
        [],
      ];
    }
    throw new Error(`Unexpected MySQL metadata query: ${sql}`);
  });
});

afterEach(() => vi.restoreAllMocks());

const included = {
  postgres: {
    tables: [TABLE_COMMENT, VIEW_COMMENT, "", null],
    columns: [TABLE_COLUMN_COMMENT, VIEW_COLUMN_COMMENT, "", null],
  },
  mysql: {
    tables: [TABLE_COMMENT, VIEW_COMMENT, null, null],
    columns: [TABLE_COLUMN_COMMENT, VIEW_COLUMN_COMMENT, null, null],
  },
};
const excluded = { tables: [null, null, null, null], columns: [null, null, null, null] };
const policies = [
  {
    label: "false",
    options: { includeComments: false },
    comments: { postgres: excluded, mysql: excluded },
  },
  { label: "true", options: { includeComments: true }, comments: included },
  { label: "omitted", options: {}, comments: included },
] satisfies Array<{
  label: string;
  options: IntrospectOptions;
  comments: Record<"postgres" | "mysql", { tables: (string | null)[]; columns: (string | null)[] }>;
}>;

describe.each([
  {
    dialect: "postgres",
    driver: postgresDriver,
    connectionString: "postgresql://synthetic.invalid/example",
  },
  { dialect: "mysql", driver: mysqlDriver, connectionString: "mysql://synthetic.invalid/example" },
] as const)("dbSchema $dialect comment policy", ({ dialect, driver, connectionString }) => {
  it.each(policies)(
    "honours $label in raw table and view snapshots",
    async ({ options, comments }) => {
      const snapshot = await driver.introspect(connectionString, options);
      expect(snapshot).toEqual({
        dialect,
        tables: catalog.map((table, index) => ({
          name: table.name,
          comment: comments[dialect].tables[index],
          columns: [
            {
              name: "id",
              type: dialect === "postgres" ? "integer" : "int",
              nullable: false,
              defaultValue: "7",
              comment: comments[dialect].columns[index],
            },
            {
              name: "owner_id",
              type: dialect === "postgres" ? "integer" : "int",
              nullable: true,
              defaultValue: null,
              comment: null,
            },
          ],
          primaryKey: table.isView ? [] : ["id"],
          foreignKeys: table.isView
            ? []
            : [{ column: "owner_id", referencesTable: "owners", referencesColumn: "id" }],
        })),
      });
      expect(dialect === "postgres" ? adapters.pgEnd : adapters.mysqlEnd).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { label: "allowlist", options: { tables: ["customers_view"] } },
    {
      label: "exclusion",
      options: { excludeTables: ["customers", "empty_comments", "null_comments"] },
    },
  ])("preserves $label filtering with comments disabled", async ({ options }) => {
    const snapshot = await driver.introspect(connectionString, {
      ...options,
      includeComments: false,
    });
    expect(snapshot.tables.map((table) => table.name)).toEqual(["customers_view"]);
    expect(snapshot.tables[0]!.comment).toBeNull();
    expect(snapshot.tables[0]!.columns.map((column) => column.comment)).toEqual([null, null]);
  });

  it.each(
    (["markdown", "ddl", "compact"] as SchemaFormat[]).flatMap((format) =>
      policies.map((policy) => ({ ...policy, format })),
    ),
  )(
    "applies $label in repeated $format discovery through the production builder",
    async ({ options, label, format }) => {
      const introspect = vi.spyOn(driver, "introspect");
      const config = OverlayConfigSchema.parse({
        target: { command: "node" },
        dbSchema: { driver: dialect, connectionString, format, ...options },
      });
      const output: JsonRpcMessage[] = [];
      const pipeline = new Pipeline(buildOverlays(config), {
        onForwardToClient: (message) => output.push(message),
        onForwardToTarget: () => {},
        log: () => {},
      });
      try {
        await pipeline.start();
        expect(introspect).toHaveBeenCalledWith(
          connectionString,
          expect.objectContaining({ includeComments: label !== "false" }),
        );
        const snapshot: SchemaSnapshot = await introspect.mock.results[0]!.value;
        for (const id of [1, 2]) {
          const tools = [
            { name: "query", description: "Run SQL" },
            { name: "echo", description: "Echo input" },
          ];
          await pipeline.handleServerMessage({ jsonrpc: "2.0", id, result: { tools } });
          const response = output[id - 1] as { result: { tools: typeof tools } };
          const description = response.result.tools[0]!.description;
          expect(description).toBe(`Run SQL\n\n${formatSchema(snapshot, format)}`);
          for (const comment of [
            TABLE_COMMENT,
            VIEW_COMMENT,
            TABLE_COLUMN_COMMENT,
            VIEW_COLUMN_COMMENT,
          ]) {
            expect(description.includes(comment)).toBe(format === "markdown" && label !== "false");
          }
          expect(description).toContain("customers_view");
          expect(response.result.tools[1]).toEqual(tools[1]);
          expect(tools[0]!.description).toBe("Run SQL");
        }
        expect(introspect).toHaveBeenCalledOnce();
      } finally {
        await pipeline.stop();
      }
    },
  );

  it("preserves metadata errors and closes the connection with comments disabled", async () => {
    const failure = new Error("Synthetic metadata read failed");
    if (dialect === "postgres") adapters.pgQuery.mockRejectedValueOnce(failure);
    else adapters.mysqlQuery.mockRejectedValueOnce(failure);
    await expect(driver.introspect(connectionString, { includeComments: false })).rejects.toBe(
      failure,
    );
    expect(dialect === "postgres" ? adapters.pgEnd : adapters.mysqlEnd).toHaveBeenCalledOnce();
  });
});
