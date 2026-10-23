/**
 * #56 — resident executor transport. These cover the JSON-lines protocol
 * without a browser: the child is a tiny echo server, so the test is about
 * framing, reuse, and failure classification (retryable vs not).
 */
import { describe, it, expect } from "vitest";
import { ResidentProcess, ResidentNotRunningError } from "../src/resident.ts";
import { isColdStartError, superviseResidentFailure } from "../src/index.ts";

/** Minimal `--serve`-shaped peer: echoes each request back as a frame. */
const ECHO = `
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim() === "") continue;
    const req = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, stdout: "echo:" + req.code, stderr: "" }) + "\\n");
  }
});
`;

const WEDGED = `process.stdin.on("data", () => {});`;

function makeResident(
  script: string,
  overrides: Partial<ConstructorParameters<typeof ResidentProcess>[0]> = {},
): ResidentProcess {
  return new ResidentProcess({
    argv: [process.execPath, "-e", script],
    env: process.env,
    cwd: process.cwd(),
    graceMs: 5_000,
    idleMs: 0,
    ...overrides,
  });
}

describe("ResidentProcess (#56)", () => {
  it("answers one request with its frame", async () => {
    const resident = makeResident(ECHO);
    try {
      const frame = await resident.run("console.log(1)");
      expect(frame.ok).toBe(true);
      expect(frame.stdout).toBe("echo:console.log(1)");
      expect(resident.alive).toBe(true);
    } finally {
      resident.stop();
    }
  });

  it("reuses one process across sequential requests", async () => {
    const resident = makeResident(ECHO);
    try {
      const first = await resident.run("a");
      const second = await resident.run("b");
      expect(first.stdout).toBe("echo:a");
      expect(second.stdout).toBe("echo:b");
      expect(resident.alive).toBe(true);
    } finally {
      resident.stop();
    }
  });

  it("ignores non-frame noise printed on stdout", async () => {
    const resident = makeResident(`process.stdout.write("noise\\n");${ECHO}`);
    try {
      const frame = await resident.run("noisy");
      expect(frame.stdout).toBe("echo:noisy");
    } finally {
      resident.stop();
    }
  });

  it("rejects a request that was never written after stop (retryable error)", async () => {
    const resident = makeResident(ECHO);
    await resident.run("x");
    resident.stop();
    await expect(resident.run("y")).rejects.toBeInstanceOf(ResidentNotRunningError);
    expect(resident.alive).toBe(false);
  });

  it("kills a wedged request after the grace and reports a non-retryable failure", async () => {
    const resident = makeResident(WEDGED, { graceMs: 200 });
    await expect(resident.run("hang")).rejects.toThrow(/timed out/);
    expect(resident.alive).toBe(false);
  });

  it("stops itself after the idle window", async () => {
    const resident = makeResident(ECHO, { idleMs: 150 });
    await resident.run("x");
    expect(resident.alive).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(resident.alive).toBe(false);
  });
});

// The runtime's `--serve` loop reports a dead CDP channel with this exact
// wording; the plugin must classify it as a cold-start failure so it can park
// the resident and recover through the one-shot path (#56).
describe("resident transport error contract (#56)", () => {
  it("classifies the runtime's dead-CDP resident error as retryable", () => {
    expect(
      isColdStartError(
        "ego-browser script failed: browser is not reachable: CDP channel is closed (the browser stopped)",
      ),
    ).toBe(true);
    expect(isColdStartError("ego-browser script failed: CDP channel is not open")).toBe(true);
  });

  it("does not classify ordinary script failures as transport failures", () => {
    expect(isColdStartError("ego-browser script failed: element not found")).toBe(false);
  });
});

// #73 — supervision: after three consecutive cold-start failures the resident
// stays parked (one-shot keeps working) instead of cycling park -> respawn.
describe("resident supervision (#73)", () => {
  it("parks after three consecutive cold-start failures", () => {
    expect(superviseResidentFailure(0, "cold start")).toEqual({ failures: 1, parkReason: null });
    expect(superviseResidentFailure(1, "cold start")).toEqual({ failures: 2, parkReason: null });
    const third = superviseResidentFailure(2, "cold start");
    expect(third.failures).toBe(3);
    expect(third.parkReason).toContain("cold start");
  });
});
