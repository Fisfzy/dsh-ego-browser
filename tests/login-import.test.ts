import { describe, it, expect } from "vitest";
import {
  chromiumCandidates,
  detectSystemBrowsers,
  profilesFromLocalState,
  cookieMatchesDomains,
  toCookieParam,
  parseDevToolsActivePort,
  resolveEgoStateDir,
} from "../src/login-import.ts";

describe("chromiumCandidates / detectSystemBrowsers", () => {
  it("builds Windows candidate paths from env", () => {
    const c = chromiumCandidates(
      { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
      "win32",
    );
    expect(c.length).toBeGreaterThanOrEqual(5);
    expect(c[0].exePath).toContain("chrome.exe");
    expect(c[0].userDataDir).toBe("C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data");
    expect(c.some((b) => b.id === "edge")).toBe(true);
  });

  it("builds Linux candidate paths", () => {
    const c = chromiumCandidates({ HOME: "/home/u" }, "linux");
    expect(c[0].exePath).toBe("/usr/bin/google-chrome");
    expect(c[0].userDataDir).toBe("/home/u/.config/google-chrome");
  });

  it("detectSystemBrowsers filters out nonexistent installs", () => {
    // No fabricated env paths exist on disk → empty.
    const env = {
      LOCALAPPDATA: "Z:\\definitely\\not\\here",
      ProgramFiles: "Z:\\nope",
      "ProgramFiles(x86)": "Z:\\nope2",
    };
    expect(detectSystemBrowsers(env, "win32")).toEqual([]);
  });
});

describe("profilesFromLocalState", () => {
  it("reads profile.info_cache into dir/name pairs", () => {
    const json = JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Person 1" },
          "Profile 1": { name: "Work" },
        },
      },
    });
    const profiles = profilesFromLocalState(json, "C:\\UD");
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toEqual({ dir: "C:\\UD\\Default", dirName: "Default", name: "Person 1" });
    expect(profiles[1].name).toBe("Work");
  });

  it("falls back to Default on garbage input", () => {
    const p = profilesFromLocalState("not json", "/ud");
    expect(p).toHaveLength(1);
    expect(p[0].dirName).toBe("Default");
    expect(p[0].name).toBe("Default");
  });

  it("falls back to Default when info_cache is empty", () => {
    expect(profilesFromLocalState("{}", "/ud")[0].dirName).toBe("Default");
  });
});

describe("cookieMatchesDomains", () => {
  it("matches exact and subdomain, case-insensitive, leading-dot tolerant", () => {
    expect(cookieMatchesDomains(".bilibili.com", ["bilibili.com"])).toBe(true);
    expect(cookieMatchesDomains("api.bilibili.com", ["Bilibili.com"])).toBe(true);
    expect(cookieMatchesDomains("bilibili.com", [".bilibili.com"])).toBe(true);
  });

  it("rejects unrelated and sibling domains", () => {
    expect(cookieMatchesDomains("notbilibili.com", ["bilibili.com"])).toBe(false);
    expect(cookieMatchesDomains("bilibili.com.evil.cn", ["bilibili.com"])).toBe(false);
    expect(cookieMatchesDomains("zhihu.com", ["bilibili.com"])).toBe(false);
  });

  it("empty domain list matches everything", () => {
    expect(cookieMatchesDomains("anything.example", [])).toBe(true);
  });
});

describe("toCookieParam", () => {
  it("keeps a full persistent cookie", () => {
    const p = toCookieParam({
      name: "SESSDATA", value: "abc", domain: ".bilibili.com", path: "/",
      expires: 1893456000, secure: true, httpOnly: true, sameSite: "Lax",
    });
    expect(p).toEqual({
      name: "SESSDATA", value: "abc", domain: ".bilibili.com", path: "/",
      secure: true, httpOnly: true, sameSite: "Lax", expires: 1893456000,
    });
  });

  it("drops expires on session cookies", () => {
    const p = toCookieParam({ name: "s", value: "v", domain: "x.com", path: "/", session: true, expires: 0 });
    expect(p).not.toHaveProperty("expires");
  });

  it("defaults path and omits invalid sameSite", () => {
    const p = toCookieParam({ name: "a", value: "b", domain: "x.com", path: "" });
    expect(p!.path).toBe("/");
    expect(p).not.toHaveProperty("sameSite");
  });

  it("rejects cookies without name or domain", () => {
    expect(toCookieParam({ name: "", value: "v", domain: "x.com", path: "/" })).toBeNull();
    expect(toCookieParam({ name: "n", value: "v", domain: "", path: "/" })).toBeNull();
    expect(toCookieParam(null as never)).toBeNull();
  });
});

describe("parseDevToolsActivePort", () => {
  it("parses the first line", () => {
    expect(parseDevToolsActivePort("51803\n/devtools/browser/abc-123")).toBe(51803);
  });
  it("rejects garbage", () => {
    expect(parseDevToolsActivePort("")).toBeNull();
    expect(parseDevToolsActivePort("abc\n")).toBeNull();
    expect(parseDevToolsActivePort("99999\n")).toBeNull();
    expect(parseDevToolsActivePort("-1\n")).toBeNull();
  });
});

describe("resolveEgoStateDir", () => {
  it("prefers EGO_LINUX_STATE_DIR", () => {
    expect(resolveEgoStateDir({ EGO_LINUX_STATE_DIR: "/custom" }, "linux")).toBe("/custom");
  });
  it("uses LOCALAPPDATA on win32", () => {
    expect(resolveEgoStateDir({ LOCALAPPDATA: "C:\\L" }, "win32")).toBe("C:\\L\\ego-lite-linux");
  });
  it("uses XDG_STATE_HOME / ~/.local/state on POSIX", () => {
    expect(resolveEgoStateDir({ HOME: "/h" }, "linux")).toBe("/h/.local/state/ego-lite-linux");
    expect(resolveEgoStateDir({ XDG_STATE_HOME: "/x", HOME: "/h" }, "linux")).toBe("/x/ego-lite-linux");
  });
});
