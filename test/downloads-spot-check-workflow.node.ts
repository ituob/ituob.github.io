import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const workflow = parse(readFileSync(new URL("../.github/workflows/build-deploy.yml", import.meta.url), "utf8")) as {
  on: Record<string, unknown>;
  jobs: Record<string, { env?: Record<string, string>; steps: Array<{ name?: string; run?: string }> }>;
};

describe("publication downloads CI workflow", () => {
  it("requires publication artifacts for every hosted build event", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(workflow.jobs.build.env?.PUBLICATIONS_REQUIRED).toBe("true");
  });

  it("spot-checks every publication and language entry", () => {
    const step = workflow.jobs.build.steps.find((candidate) => candidate.name === "Downloads spot-check on the built site");
    expect(step?.run).toBe("node --experimental-strip-types scripts/spot-check-downloads.ts --dist dist --sample all");
  });
});
