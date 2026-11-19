import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function isIgnored(path: string): boolean {
  try {
    const output = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
      encoding: "utf8",
      input: `${path}\n`,
    });
    return output.trim() === path;
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 1) {
      return false;
    }
    throw error;
  }
}

describe("mock IdP local secrets ignore rules", () => {
  it("ignores local vars files while allowing the checked-in example", () => {
    expect(isIgnored(".dev.vars")).toBe(true);
    expect(isIgnored(".dev.vars.local")).toBe(true);
    expect(isIgnored(".dev.vars.test")).toBe(true);
    expect(isIgnored(".dev.vars.example")).toBe(false);
    expect(isIgnored("ordinary-file.txt")).toBe(false);
  });
});
