// Approval -> branch -> PR, behind an interface (docs/submission-workflow.adoc
// "Approval -> branch -> PR"). Tests can override the configured GitHub App client.
// Protected branches change only through reviewed pull requests.

export interface OpenPatchPrRequest {
  repo: string;
  /** Always `rt-sub-*`; the idempotency key. */
  branch: string;
  path: string;
  content: string;
  title: string;
  body: string;
  idempotencyKey: string;
}
import { classify } from "../../src/lib/form/corpus.ts";

export interface OpenGeneralMessagePrRequest extends OpenPatchPrRequest {
  edition: number;
  revision: number;
  messageId: string;
  messageType: string;
}
export interface OpenMetadataPrRequest extends OpenPatchPrRequest {
  edition: number;
  revision: number;
}
export interface OpenedPr {
  prNumber: number;
  commitSha: string;
  baseSha: string;
  url: string;
}
export interface OpenRevertPrRequest {
  repo: string;
  /** `rt-sub-*`, distinct from the patch branch. Also the idempotency key. */
  branch: string;
  /** The patch file the revert PR deletes. */
  path: string;
  title: string;
  body: string;
  idempotencyKey: string;
}
export interface PullRequestState {
  state: "open" | "closed";
  merged: boolean;
  mergeSha: string | null;
  /** The branch the PR targets, as GitHub reports it. */
  baseRef: string;
}
export interface PinBumpRequest {
  edition: number;
  items: { submissionId: string; mergeSha: string | null }[];
  /** Deterministic per edition: a replay returns the same bump, never a second. */
  idempotencyKey: string;
}
export interface PinBump {
  /** Data-repo commit the data-ob gitlink points at. */
  freezeSha: string;
  /** The site-repo commit that moved the gitlink. */
  siteCommit: string;
  /** The pin PR or its staging checks are not complete; never publish yet. */
  pending?: { prNumber: number; url: string; reason: string };
}
export interface PatchPublisher {
  /** Idempotent per `idempotencyKey`: a replay returns the same PR, never a second. */
  openPatchPr(req: OpenPatchPrRequest): Promise<OpenedPr>;
  openMetadataPr(req: OpenMetadataPrRequest): Promise<OpenedPr>;
  openGeneralMessagePr(req: OpenGeneralMessagePrRequest): Promise<OpenedPr>;
  getGeneralMessagePullRequest(req: { repo: string; prNumber: number }): Promise<PullRequestState>;
  getMetadataPullRequest(req: { repo: string; prNumber: number }): Promise<PullRequestState>;
  /** Close the PR and delete the Worker-created branch (never merges, never touches other refs). */
  closePatchPr(req: { repo: string; branch: string; prNumber: number }): Promise<void>;
  /** A PR (never a push to main) that deletes `path`. Idempotent per `idempotencyKey`. */
  openRevertPr(req: OpenRevertPrRequest): Promise<OpenedPr>;
  /** Read-only: the reconciler's view of a PR we created. */
  getPullRequest(req: { repo: string; prNumber: number }): Promise<PullRequestState>;
  /** Publication is a pin bump (the data-ob gitlink on the site repo). Idempotent per key. */
  bumpDataPin(req: PinBumpRequest): Promise<PinBump>;
}

export class PublisherNotConfigured extends Error {
  constructor() {
    super("not configured");
  }
}

export const PATCH_BRANCH = /^rt-sub-\d+-\d{3}-[a-z0-9-]+-[0-9A-Z]{8}$/;

/** The single guard every publisher implementation calls first. */
export function assertPatchBranch(branch: string): void {
  if (!PATCH_BRANCH.test(branch)) throw new Error(`refusing branch ${JSON.stringify(branch)}: only rt-sub-* patch branches are writable`);
}

export const MESSAGE_BRANCH = /^rt-msg-[1-9]\d*-[0-9A-Z]{26}-r[1-9]\d*$/;
export function assertMessageRequest(req: OpenGeneralMessagePrRequest): void {
  if (!Number.isSafeInteger(req.edition) || req.edition < 1 || !Number.isSafeInteger(req.revision) || req.revision < 1 || !/^[0-9A-Z]{26}$/.test(req.messageId) || req.branch !== `rt-msg-${req.edition}-${req.messageId}-r${req.revision}`) throw new Error("Invalid general message destination");
  const prefix = `ob-issues/${req.edition}/`;
  const relative = req.path.startsWith(prefix) ? req.path.slice(prefix.length) : "";
  const singleton = ["running_annexes", "approved_recommendations"].includes(req.messageType);
  if (singleton ? relative !== `general/${req.messageType}.yaml` : !new RegExp(`^${req.messageType}/(?!000)[0-9]{3}\\.yaml$`).test(relative)) throw new Error("Invalid general message path");
  if (classify(relative, { type: req.messageType })?.role !== "general") throw new Error("Unknown general message type");
}

export const METADATA_BRANCH = /^rt-meta-[1-9]\d*-r[1-9]\d*$/;
export function assertMetadataRequest(req: OpenMetadataPrRequest): void {
  if (!Number.isSafeInteger(req.edition) || req.edition < 1 || !Number.isSafeInteger(req.revision) || req.revision < 1 || req.branch !== `rt-meta-${req.edition}-r${req.revision}` || req.path !== `ob-issues/${req.edition}/meta.yaml`) throw new Error("Invalid edition metadata destination");
}

export function branchName(issue: number, seq: number, slug: string, submissionId: string): string {
  const nnn = String(seq).padStart(3, "0");
  const s = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `rt-sub-${issue}-${nnn}-${s}-${submissionId.slice(-8)}`;
}

export interface PublisherConfig {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  PATCH_REPO?: string;
  GITHUB_SITE_REPO?: string;
  GITHUB_DATA_GITLINK?: string;
  GITHUB_STAGING_BRANCH?: string;
}
export { GitHubAppPatchPublisher } from "./github-publisher.ts";
import { GitHubAppPatchPublisher } from "./github-publisher.ts";

/** The base branch the FAKE reports for a PR (a read-side value: nothing here writes to it). */
const FAKE_BASE = "main";

export class FakePatchPublisher implements PatchPublisher {
  readonly requests: OpenPatchPrRequest[] = [];
  readonly closed: { repo: string; branch: string; prNumber: number }[] = [];
  private byKey = new Map<string, OpenedPr>();
  private next = 1;
  /** Fail the next N openPatchPr calls (simulates 5xx), then recover. */
  failNext = 0;
  /** Test seam: runs after the PR exists upstream, before openPatchPr returns (simulates a concurrent actor). */
  failClose = false;
  afterCreate: ((pr: OpenedPr) => Promise<void>) | null = null;

  async openPatchPr(req: OpenPatchPrRequest): Promise<OpenedPr> {
    assertPatchBranch(req.branch);
    return this.open(req);
  }
  private async open(req: OpenPatchPrRequest): Promise<OpenedPr> {
    this.requests.push(req);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("GitHub 502");
    }
    const hit = this.byKey.get(req.idempotencyKey);
    if (hit) return hit;
    const n = this.next++;
    const pr = { prNumber: n, commitSha: `c${n}`.padEnd(40, "0"), baseSha: "b".repeat(40), url: `https://github.invalid/${req.repo}/pull/${n}` };
    this.byKey.set(req.idempotencyKey, pr);
    if (this.afterCreate) await this.afterCreate(pr);
    return pr;
  }
  async openMetadataPr(req: OpenMetadataPrRequest): Promise<OpenedPr> {
    assertMetadataRequest(req);
    return this.open(req);
  }
  getMetadataPullRequest(req: { repo: string; prNumber: number }): Promise<PullRequestState> {
    return this.getPullRequest(req);
  }
  openGeneralMessagePr(req: OpenGeneralMessagePrRequest): Promise<OpenedPr> {
    assertMessageRequest(req);
    return this.open(req);
  }
  getGeneralMessagePullRequest(req: { repo: string; prNumber: number }): Promise<PullRequestState> { return this.getPullRequest(req); }
  async closePatchPr(req: { repo: string; branch: string; prNumber: number }): Promise<void> {
    assertPatchBranch(req.branch);
    if (this.failClose) throw new Error("GitHub 502 on close");
    this.closed.push(req);
  }
  get createdPrs(): number {
    return this.byKey.size;
  }

  // ---- 103-06: revert PRs, PR state reads, pin bump
  readonly revertRequests: OpenRevertPrRequest[] = [];
  failNextRevert = 0;
  private revertByKey = new Map<string, OpenedPr>();
  /** What GitHub would report per PR number; unset means an open PR targeting main. */
  readonly pullStates = new Map<number, PullRequestState>();
  failGet = false;
  readonly pinRequests: PinBumpRequest[] = [];
  failNextPin = 0;
  private pinByKey = new Map<string, PinBump>();

  async openRevertPr(req: OpenRevertPrRequest): Promise<OpenedPr> {
    assertPatchBranch(req.branch);
    this.revertRequests.push(req);
    if (this.failNextRevert > 0) {
      this.failNextRevert--;
      throw new Error("GitHub 502");
    }
    const hit = this.revertByKey.get(req.idempotencyKey);
    if (hit) return hit;
    const n = this.next++;
    const pr = { prNumber: n, commitSha: `r${n}`.padEnd(40, "0"), baseSha: "b".repeat(40), url: `https://github.invalid/${req.repo}/pull/${n}` };
    this.revertByKey.set(req.idempotencyKey, pr);
    return pr;
  }
  async getPullRequest(req: { repo: string; prNumber: number }): Promise<PullRequestState> {
    if (this.failGet) throw new Error("GitHub 502 on read");
    return this.pullStates.get(req.prNumber) ?? { state: "open", merged: false, mergeSha: null, baseRef: FAKE_BASE };
  }
  /** Test helper: GitHub now reports this PR merged. */
  mergePr(prNumber: number, sha = "m".repeat(40)) {
    this.pullStates.set(prNumber, { state: "closed", merged: true, mergeSha: sha, baseRef: FAKE_BASE });
  }
  /** Test helper: GitHub now reports this PR closed without merging. */
  closePr(prNumber: number) {
    this.pullStates.set(prNumber, { state: "closed", merged: false, mergeSha: null, baseRef: FAKE_BASE });
  }
  async bumpDataPin(req: PinBumpRequest): Promise<PinBump> {
    this.pinRequests.push(req);
    if (this.failNextPin > 0) {
      this.failNextPin--;
      throw new Error("GitHub 502 on pin bump");
    }
    const hit = this.pinByKey.get(req.idempotencyKey);
    if (hit) return hit;
    const n = this.pinByKey.size + 1;
    const bump = { freezeSha: `f${n}`.padEnd(40, "0"), siteCommit: `s${n}`.padEnd(40, "0") };
    this.pinByKey.set(req.idempotencyKey, bump);
    return bump;
  }
}

let override: PatchPublisher | null = null;
/** Test seam. Production resolves the explicitly configured App client. */
export function setPublisher(p: PatchPublisher | null) {
  override = p;
}
export function getPublisher(config?: PublisherConfig): PatchPublisher {
  return override ?? new GitHubAppPatchPublisher(config);
}
