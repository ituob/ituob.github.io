import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ruby = process.env.PARITY_RUBY ?? "ruby";
const generate = (directory) => spawnSync(ruby, ["test/generate_parity_evidence.rb"], {
  cwd: root, encoding: "utf8",
  env: { ...process.env, DEPLOYED_SITE: join(directory, "reference"), LOCAL_DIST: join(directory, "build"), OUTPUT_DIR: join(directory, "output") },
});

function fixture(callback) {
  const directory = mkdtempSync(join(tmpdir(), "parity-evidence-spec-"));
  try {
    mkdirSync(join(directory, "reference"));
    mkdirSync(join(directory, "build"));
    callback(directory);
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test("an empty reference cannot produce a successful gate", () => fixture((directory) => {
  const result = generate(directory);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /No classified variants/);
}));

test("a missing local page is retained as a failed variant", () => fixture((directory) => {
  const issue = join(directory, "reference/issues/1-en");
  mkdirSync(issue, { recursive: true });
  writeFileSync(join(issue, "index.html"), "<main><h1>Printed issue</h1><p>Missing note.</p></main>");
  const result = generate(directory);
  assert.equal(result.status, 1, result.stderr);
  const evidence = JSON.parse(readFileSync(join(directory, "output/parity_variants.json"), "utf8"));
  assert.equal(evidence.classified_variants, 1);
  assert.equal(evidence.variants[0].deployed, "issues/1-en/index.html");
  assert.equal(evidence.variants[0].coverage, 0);
  assert.equal(evidence.variants[0].verdict, "missing");
  assert.equal(evidence.variants[0].local_sha256, null);
}));

test("cached link membership is identical to the canonical method, including input-set changes", () => {
  const code = `
    require './test/generate_parity_evidence'
    require './data-ob/ituob/lib/ituob/auditors/content_parity'
    klass = Ituob::Auditors::ContentParity
    klass.prepend(ParityEvidence::Comparisons)
    auditor = klass.new
    cached = auditor.method(:href_matches_any?)
    original = cached.super_method
    links = ['/issues/1296-en/', '/issues/1296/', 'https://www.itu.int/pub/T-SP-OB.1296-2024', '#year-2024', '', 'https://example.org/é', '/different']
    [Set.new(links.first(2)), Set.new(links[2..]), Set.new, Set.new(links)].each do |actual|
      links.each do |href|
        raise "changed link result: #{href}" unless cached.call(href, actual) == original.call(href, actual)
      end
    end
  `;
  const result = spawnSync(ruby, ["-e", code], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});


test("an existing local page produces a scored, hashed variant", () => fixture((directory) => {
  const html = "<main><h1>Printed bulletin</h1><p>Applicant labels and explanatory notes.</p></main>";
  writeFileSync(join(directory, "reference/index.html"), html);
  writeFileSync(join(directory, "build/index.html"), html);
  const result = generate(directory);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const evidence = JSON.parse(readFileSync(join(directory, "output/parity_variants.json"), "utf8"));
  assert.equal(evidence.classified_variants, 1);
  assert.equal(evidence.included_variants, 1);
  assert.equal(evidence.local_pages, 1);
  assert.equal(evidence.variants[0].deployed, "index.html");
  assert.equal(evidence.variants[0].local, "index.html");
  assert.equal(evidence.variants[0].coverage, 1);
  assert.equal(evidence.variants[0].verdict, "pass");
  assert.equal(evidence.variants[0].local_sha256, evidence.variants[0].deployed_sha256);
}));


test("descendant text traversal matches canonical XPath ordering and exclusions", () => {
  const code = `
    require './test/generate_parity_evidence'
    require './data-ob/ituob/lib/ituob/auditors/content_parity'
    klass = Ituob::Auditors::ContentParity
    klass.prepend(ParityEvidence::Comparisons)
    auditor = klass.new
    doc = Nokogiri::HTML('<html><head><style>hidden</style></head><body><main>Before<h1>Title</h1><p>A <em>nested</em> note<br>after break</p><script>hidden</script><table><tr><td>Left</td><td>Right</td></tr></table><!--ignored--><p>Unicode: é 日 &amp; spacing</p></main><script><span>hidden</span></script></body></html>')
    roots = [doc, *doc.css('*').to_a]
    roots << Nokogiri::XML('<root>A<![CDATA[B]]><nested>C</nested>D</root>').root
    %i[node_text spaced_text].each do |name|
      replacement = auditor.method(name)
      canonical = replacement.super_method
      roots.each do |root|
        raise "changed text for #{name}/#{root.name}" unless replacement.call(root) == canonical.call(root)
      end
    end
  `;
  const result = spawnSync(ruby, ["-e", code], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
