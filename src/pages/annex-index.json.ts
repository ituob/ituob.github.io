import type { APIRoute } from "astro";
import { join } from "node:path";
import { listIssueIds } from "~/lib/loaders";
import { obIssuesRoot, readYamlOrNull } from "~/lib/fs";
import type { AnnexIndexEntry } from "~/lib/form/annexes";

/** Every annex ever recorded (issue, publication id, position): the picker computes running annexes from it. */
export const GET: APIRoute = () => {
  const entries: AnnexIndexEntry[] = [];
  for (const issue of listIssueIds()) {
    const annexes = readYamlOrNull<Record<string, { position_on?: unknown } | null>>(join(obIssuesRoot(), String(issue), "annexes.yaml"));
    for (const [publication_id, annex] of Object.entries(annexes ?? {})) {
      const raw = annex?.position_on;
      const position_on = raw instanceof Date ? raw.toISOString() : typeof raw === "string" ? raw : null;
      entries.push({ issue, publication_id, position_on });
    }
  }
  return new Response(JSON.stringify(entries), { headers: { "content-type": "application/json" } });
};
