import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = resolve("src/cli.ts");
// Match the source checker's loader selection on early and modern Node 20.
const sourceRequire = nodeModule.createRequire(import.meta.url);
const loader = pathToFileURL(sourceRequire.resolve("tsx")).href;
const TSX_EXEC_ARGV =
  typeof nodeModule.register === "function"
    ? ["--import", loader]
    : ["--require", sourceRequire.resolve("tsx/cjs"), "--loader", loader];
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "januscope-cli-entry-"));
  temporary.push(path);
  return path;
}

function run(entry: string, args: string[] = []) {
  return spawnSync(process.execPath, [...TSX_EXEC_ARGV, entry, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("CLI direct-entry detection", () => {
  it("delivers a complete JSON check report to a slow pipe reader before exiting", async () => {
    const path = directory();
    const server = join(path, "large-catalog.mjs");
    const names = Array.from(
      { length: 20_000 },
      (_, index) => `tool_${String(index).padStart(59, "0")}`,
    );
    writeFileSync(
      server,
      `import { createInterface } from 'node:readline';
const tools = ${JSON.stringify(names)}.map(name => ({ name, inputSchema: { type: 'object' } }));
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'initialize'
    ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'large-catalog', version: '1.0.0' } }
    : { tools };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});`,
    );
    const config = join(path, "config.json");
    writeFileSync(
      config,
      JSON.stringify({ target: { command: process.execPath, args: [server] } }),
    );
    const child = spawn(
      process.execPath,
      [...TSX_EXEC_ARGV, CLI, "check", "--config", config, "--timeout", "5000", "--json"],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, env: { ...process.env, HOME: path } },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let resume: ReturnType<typeof setTimeout> | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (stdout.length === 1) {
        child.stdout.pause();
        resume = setTimeout(() => child.stdout.resume(), 100);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    try {
      const [code, signal] = await once(child, "close");
      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(Buffer.concat(stderr).toString()).toBe("");
      expect(JSON.parse(Buffer.concat(stdout).toString())).toMatchObject({
        ok: true,
        tools: { allowed: names, blocked: [] },
      });
    } finally {
      clearTimeout(resume);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }, 15_000);

  it.runIf(process.platform !== "win32")(
    "runs version and rejects invalid arguments through an actual symlink chain",
    () => {
      const path = directory();
      symlinkSync(CLI, join(path, "source-entry"));
      const entry = join(path, "januscope");
      symlinkSync("source-entry", entry);
      const expectedVersion = (
        JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string }
      ).version;
      const version = run(entry, ["--version"]);
      expect(version.status).toBe(0);
      expect(version.stdout).toBe(expectedVersion + "\n");
      expect(version.stderr).toBe("");
      const invalid = run(entry, ["--invalid-installed-option"]);
      expect(invalid.status).toBe(2);
      expect(invalid.stderr).toContain("unknown argument");
    },
  );

  it.runIf(process.platform !== "win32")(
    "runs check through a symlink without starting the imported CLI in its worker",
    () => {
      const path = directory();
      const entry = join(path, "januscope");
      symlinkSync(CLI, entry);
      const config = join(path, "config.json");
      writeFileSync(
        config,
        JSON.stringify({
          target: {
            command: process.execPath,
            args: [resolve("test/fixtures/fake-mcp-server.mjs")],
          },
        }),
      );
      const result = run(entry, ["check", "--config", config, "--timeout", "5000", "--json"]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        tools: { allowed: ["echo", "dangerous_delete", "query"] },
      });
    },
  );

  it("keeps normal imports inert", () => {
    const path = directory();
    const caller = join(path, "caller.mjs");
    writeFileSync(
      caller,
      `await import(${JSON.stringify(pathToFileURL(CLI).href)});process.stdout.write('import-only\\n');`,
    );
    const result = run(caller);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("import-only\n");
    expect(result.stderr).toBe("");
  });

  it.each(["missing", "not-a-directory"])("keeps imports with a %s argv entry inert", (kind) => {
    const path = directory();
    const ordinaryFile = join(path, "ordinary-file");
    writeFileSync(ordinaryFile, "not a directory");
    const missing =
      kind === "missing" ? join(path, "absent-entry.mjs") : join(ordinaryFile, "entry.mjs");
    const caller = join(path, "caller.mjs");
    writeFileSync(
      caller,
      `process.argv[1]=${JSON.stringify(missing)};await import(${JSON.stringify(pathToFileURL(CLI).href)});process.stdout.write('import-only\\n');`,
    );
    const result = run(caller);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("import-only\n");
    expect(result.stderr).toBe("");
  });

  it.runIf(process.platform !== "win32")("surfaces unexpected entry-resolution errors", () => {
    const path = directory();
    const loop = join(path, "loop");
    symlinkSync("loop", loop);
    const caller = join(path, "caller.mjs");
    writeFileSync(
      caller,
      `process.argv[1]=${JSON.stringify(loop)};try{await import(${JSON.stringify(pathToFileURL(CLI).href)});process.stdout.write('unexpected success');}catch(error){process.stdout.write(error.code);}`,
    );
    const result = run(caller);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ELOOP");
    expect(result.stderr).toBe("");
  });
});
