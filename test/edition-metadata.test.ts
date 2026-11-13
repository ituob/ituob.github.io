import { beforeEach, expect, it } from "vitest";
import { metadataArtifact, readMetadata, saveMetadata, scheduleMetadata } from "../worker/lib/edition-metadata.ts";
import { verifyChain } from "../worker/lib/audit.ts";
import { Forbidden } from "../worker/lib/authz.ts";
import { ConflictError } from "../worker/lib/membership.ts";
import { ValidationFailed } from "../worker/lib/submissions.ts";
import type { Session } from "../worker/lib/types.ts";
import { BOOTSTRAP_ADMIN_ID, db, seedFixtures } from "./helpers.ts";
import { parse } from "yaml";

const admin: Session = { userId: BOOTSTRAP_ADMIN_ID, roles: ["itu-admin"], memberStateId: null };
const member: Session = { userId: "member-A", roles: ["member-submitter"], memberStateId: "A" };
const metadata = { id: 1400, publication_date: "2027-02-01", cutoff_date: "2027-01-20", languages: { en: true }, authors: [{ name: "TSB", contacts: [{ type: "email", data: "tsb@itu.int" }] }] };
beforeEach(async () => {
  await db().prepare("DELETE FROM edition_metadata_prs").run();
  await db().prepare("DELETE FROM edition_metadata").run();
  await seedFixtures();
});
it("D1 refuses invalid/stale/nonstaff edits and preserves exact scheduled metadata", async () => {
  await expect(saveMetadata(db(), member, 1400, { metadata, expected_revision: 0 })).rejects.toBeInstanceOf(Forbidden);
  await expect(saveMetadata(db(), admin, 1400, { metadata: { ...metadata, cutoff_date: "2027-02-30" }, expected_revision: 0 })).rejects.toBeInstanceOf(ValidationFailed);
  expect(await readMetadata(db(), admin, 1400)).toBeNull();
  await saveMetadata(db(), admin, 1400, { metadata, expected_revision: 0 });
  const scheduled = await scheduleMetadata(db(), admin, 1400, 1);
  await expect(saveMetadata(db(), admin, 1400, { metadata: { id: 1400 }, expected_revision: 1 })).rejects.toBeInstanceOf(ConflictError);
  expect(await readMetadata(db(), admin, 1400)).toEqual(scheduled);
  expect(parse((await metadataArtifact(db(), 1400, scheduled.revision)).content)).toEqual(metadata);
  expect(await verifyChain(db())).toBeNull();
});
it("D1 concurrent editors cannot both replace the same metadata revision", async () => {
  await saveMetadata(db(), admin, 1400, { metadata, expected_revision: 0 });
  const writes = await Promise.allSettled([
    saveMetadata(db(), admin, 1400, { metadata: { ...metadata, issn: "first" }, expected_revision: 1 }),
    saveMetadata(db(), admin, 1400, { metadata: { ...metadata, issn: "second" }, expected_revision: 1 }),
  ]);
  expect(writes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(writes.filter(r => r.status === "rejected")).toHaveLength(1);
  const saved = await readMetadata(db(), admin, 1400);
  expect(saved?.revision).toBe(2); expect(["first", "second"]).toContain(saved?.metadata.issn);
  expect(await verifyChain(db())).toBeNull();
});
it("D1 reserved PR bytes lock the draft before the external response", async () => {
  await saveMetadata(db(), admin, 1400, { metadata, expected_revision: 0 });
  const scheduled = await scheduleMetadata(db(), admin, 1400, 1);
  const artifact = await metadataArtifact(db(), 1400, 2);
  await db().prepare("INSERT INTO edition_metadata_prs(ob_issue_no,revision,repo,branch,path,content_yaml) VALUES (?1,?2,?3,?4,?5,?6)")
    .bind(1400, 2, "ituob/itu-ob-data", "rt-edition-1400-meta", artifact.path, artifact.content).run();
  await expect(saveMetadata(db(), admin, 1400, { metadata: { id: 1400 }, expected_revision: 2 })).rejects.toBeInstanceOf(ConflictError);
  expect(await readMetadata(db(), admin, 1400)).toEqual(scheduled);
  expect(await metadataArtifact(db(), 1400, 2)).toEqual(artifact);
});
