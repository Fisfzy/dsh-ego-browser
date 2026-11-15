import { describe, it, expect } from "vitest";
import { TargetSessions } from "../src/worker/capture-cdp.ts";

describe("capture session recovery", () => {
  it("re-attaches once when Chrome reports a destroyed session", async () => {
    let attaches = 0;
    let starts = 0;
    const cdp = {
      on: () => () => {},
      call: async (method: string, _params?: unknown, sessionId?: string) => {
        if (method === "Target.attachToTarget") {
          attaches += 1;
          return { sessionId: `s${attaches}` };
        }
        if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
        if (method === "Page.startScreencast") {
          starts += 1;
          if (starts === 1) throw new Error("Session with given id not found.");
          expect(sessionId).toBe("s2");
          return {};
        }
        return {};
      },
    };
    const sessions = new TargetSessions(cdp as never);
    await expect(sessions.call("target-1", "Page.startScreencast")).resolves.toEqual({});
    expect(attaches).toBe(2);
    expect(starts).toBe(2);
  });
});
