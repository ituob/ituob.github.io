"""Bounded Git fixtures; reuse the pinned service's real byte-exact staging helper."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "project-authored-data.py"
spec = importlib.util.spec_from_file_location("projection", SCRIPT)
projection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(projection)


FAKE_NO_REGISTERS = """module Ituob
  module Catalogs
    module Registers
      def self.all_register_ids = []
    end
  end
end
"""


class ProjectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        service = Path(os.environ.get("PROJECTION_SERVICE_ROOT", SCRIPT.parents[1] / "data-ob"))
        cls.stager = projection.git(service, "show", "HEAD:scripts/stage_authored_patches.py")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data, self.service = self.root / "data", self.root / "service"
        for repo in (self.data, self.service):
            repo.mkdir()
            self.git(repo, "init", "-q")
            self.git(repo, "config", "user.email", "fixture@example.test")
            self.git(repo, "config", "user.name", "Fixture")
        self.write(self.data, "README.md", "canonical\n")
        self.data_ref = self.commit(self.data)
        self.write(self.service, "scripts/stage_authored_patches.py", self.stager)
        self.write(self.service, "scripts/historical_patch_baseline.json",
                   '{"source_ref":"751319a91c15459ca15f414a4591a3de008497d0","files":[]}\n')
        self.write(self.service, "ob-issues/1/meta.yaml", "historical metadata\n")
        self.write(self.service, "ob-issues/1/e118-iin/001-ADD.yaml", "historical amendment\n")
        self.write(self.service, "datasets/changes.json", '["committed baseline"]')
        self.write(self.service, "scripts/validate_data_lml.rb", '''raise 'full validation required' unless ARGV == ['--all']
raise 'wrong corpus root' unless File.realpath(ENV.fetch('OB_ISSUES_OUT_PATH')) == File.realpath('ob-issues')
raise 'wrong source root' unless ENV.fetch('ITU_OB_DATA_ROOT').end_with?('/data/issues')
paths = Dir[File.join(ENV.fetch('OB_ISSUES_OUT_PATH'), '*', '*', '*.yaml')]
raise 'staged input missing' if paths.length < 2
raise 'unknown model field' if paths.any? { |p| File.read(p).include?('unknown_model_field:') }
File.write('.model-validated', 'valid')
''')
        self.write(self.service, "scripts/migrate_actions_to_changes.rb", '''require 'json'
require 'fileutils'
raise 'model validation must precede projection' unless File.exist?('.model-validated')
paths = Dir['ob-issues/*/*/*.yaml'].sort
paths.each do |path|
  issue = path.split('/')[1]
  register = path.split('/')[2]
  seq, action = File.basename(path).match(/\\A(\\d{3})-(ADD|SUP|REP|LIR|MOD|DEL|SEED)\\.yaml\\z/).captures
  key = "#{issue}-#{seq.rjust(4, '0')}"
  filename = "%04d-%04d-%s-%s.yaml" % [issue.to_i, seq.to_i, action, key]
  target = File.join('datasets', register, 'changes', filename)
  FileUtils.mkdir_p(File.dirname(target))
  File.binwrite(target, File.binread(path))
end
File.write('datasets/changes.json', JSON.generate(paths.map { |p| File.read(p) }))
''')
        self.write(self.service, "scripts/generate_register_snapshots.rb", '''require 'json'
require 'fileutils'
FileUtils.mkdir_p(ENV.fetch('SNAPSHOTS_OUT'))
File.write(File.join(ENV.fetch('SNAPSHOTS_OUT'), 'current.json'), File.read('datasets/changes.json'))
puts 'Snapshots: 1 registers, 1 files written, 0 skipped, 0 errors'
''')
        # Orchestration fixtures have no registers; the history step only needs to load.
        self.write(self.service, "ituob/lib/ituob.rb", FAKE_NO_REGISTERS)
        for library in ("support", "registers", "catalogs", "verifiers"):
            self.write(self.service, f"ituob/lib/ituob/{library}.rb", "")
        self.service_ref = self.commit(self.service)
        # Execute actual Ruby without requiring gems for these orchestration fixtures.
        bindir = self.root / "bin"
        bindir.mkdir()
        bundle = bindir / "bundle"
        bundle.write_text('#!/bin/sh\nunset GEM_HOME GEM_PATH RUBYOPT RUBYLIB\nshift\nexec "$@"\n')
        bundle.chmod(0o755)
        self.environment = patch.dict(os.environ, {"PATH": str(bindir) + os.pathsep + os.environ["PATH"]})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.out = self.root / "snapshots"
        self.projected = self.root / "projected-service"

    def git(self, repo, *args):
        return projection.git(repo, *args).decode().strip()

    def write(self, root, path, content):
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content if isinstance(content, bytes) else content.encode())

    def commit(self, repo):
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-qm", "fixture")
        return self.git(repo, "rev-parse", "HEAD")

    def authored(self, issue, payload):
        self.write(self.data, f"ob-issues/{issue}/meta.yaml", f"issue: {issue}\n")
        self.write(self.data, f"ob-issues/{issue}/e118-iin/001-ADD.yaml", payload)
        self.data_ref = self.commit(self.data)

    def run_projection(self, **overrides):
        args = dict(data_root=self.data, service_root=self.service, data_ref=self.data_ref,
                    service_ref=self.service_ref, snapshots_out=self.out, projection_root=self.projected)
        args.update(overrides)
        return projection.project(**args)

    def assert_inputs_preserved(self):
        self.assertEqual(self.git(self.data, "status", "--porcelain"), "")
        self.assertEqual(self.git(self.service, "status", "--porcelain"), "")
        self.assertEqual(self.git(self.data, "rev-parse", "HEAD"), self.data_ref)
        self.assertEqual(self.git(self.service, "rev-parse", "HEAD"), self.service_ref)

    def test_cumulative_exact_bytes_overlay_preserves_historical_corpus(self):
        first = b"# authored formatting\r\ntype: ADD\r\n"
        second = b"type: ADD\n# later commit\n"
        self.authored(2, first)
        self.authored(3, second)
        self.assertEqual(self.run_projection(), "authored projection")
        self.assertEqual(json.loads((self.out / "current.json").read_text()),
                         ["historical amendment\n", first.decode(), second.decode()])
        self.assertEqual((self.projected / "ob-issues/2/e118-iin/001-ADD.yaml").read_bytes(), first)
        self.assertEqual((self.projected / "ob-issues/3/e118-iin/001-ADD.yaml").read_bytes(), second)
        self.assertEqual((self.projected / "ob-issues/1/e118-iin/001-ADD.yaml").read_bytes(),
                         b"historical amendment\n")
        self.assert_inputs_preserved()

    def test_authored_patch_reaches_change_record_and_generated_snapshot(self):
        patch = b"# exact authored patch\r\ntype: ADD\r\n"
        self.authored(2, patch)

        self.assertEqual(self.run_projection(), "authored projection")
        record = self.projected / "datasets/e118-iin/changes/0002-0001-ADD-2-0001.yaml"
        self.assertEqual(record.read_bytes(), patch)
        self.assertEqual(
            json.loads((self.out / "current.json").read_text()),
            ["historical amendment\n", patch.decode()],
        )
        self.assertEqual(
            (self.projected / "ob-issues/2/e118-iin/001-ADD.yaml").read_bytes(), patch
        )
        self.assert_inputs_preserved()

    def test_historical_only_uses_committed_changes_without_helper_or_migration(self):
        (self.service / "scripts/stage_authored_patches.py").unlink()
        (self.service / "scripts/migrate_actions_to_changes.rb").unlink()
        (self.service / "scripts/validate_data_lml.rb").unlink()
        self.service_ref = self.commit(self.service)
        self.assertEqual(self.run_projection(), "historical-only")
        self.assertEqual(json.loads((self.out / "current.json").read_text()), ["committed baseline"])
        self.assert_inputs_preserved()

    def yaml_json(self, path):
        return json.loads(subprocess.check_output(
            ["bundle", "exec", "ruby", "-ryaml", "-rjson", "-rdate", "-e",
             "puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), "
             "permitted_classes: [Date, Time], aliases: true))", str(path)], text=True))

    def e164_fixture(self):
        # Source message extracted without editing from canonical data commit
        # 90f99728acd1e96d025ce0034fe43a38b572aa62, issue 1001.
        fixtures = SCRIPT.parent / "tests/fixtures/e164-acn"
        source = (fixtures / "1001-source.yaml").read_bytes()
        normalized = (fixtures / "1001-normalized.yaml").read_bytes()
        self.write(self.data, "issues/1001/amendments.yaml", source)
        self.data_ref = self.commit(self.data)
        self.write(self.service, "ob-issues/1001/e164-acn/001-LIR.yaml", normalized)
        record = "datasets/1015-E.164B/changes/1001-0001-LIR-55.yaml"
        self.write(self.service, record, b"register: E164_ACN\n" + normalized)
        self.service_ref = self.commit(self.service)
        return fixtures, record

    def test_source_multiline_patterns_reach_issue_and_snapshot_preserving_other_rows(self):
        fixtures, record = self.e164_fixture()
        original = self.yaml_json(fixtures / "1001-normalized.yaml")
        source = self.yaml_json(fixtures / "1001-source.yaml")
        row = source["messages"][0]["contents"]["en"]["content"][4]["content"][0]
        # The fixture's Brazil table cell is the public source oracle.
        patterns = [node["text"] for node in row["content"][2]["content"][0]["content"]
                    if node["type"] == "text"]
        self.assertEqual(len(patterns), 5)
        expected = "\n".join(patterns)
        self.assertNotEqual(original["data"]["entries"][0]["mobile_telephone_numbers"]["en"], expected)
        self.write(self.service, "scripts/generate_register_snapshots.rb",
                   "require 'yaml'\nrequire 'json'\nrequire 'fileutils'\n"
                   "FileUtils.mkdir_p(ENV.fetch('SNAPSHOTS_OUT'))\n"
                   f"data = YAML.safe_load(File.read('{record}'))\n"
                   "File.write(File.join(ENV.fetch('SNAPSHOTS_OUT'), 'current.json'), JSON.generate(data))\n"
                   "puts 'Snapshots: 1 registers, 1 files written, 0 skipped, 0 errors'\n")
        self.service_ref = self.commit(self.service)
        # A dirty legacy source must not override the pinned canonical bytes.
        self.write(self.data, "issues/1001/amendments.yaml", "uncommitted source ignored\n")
        self.run_projection()
        projected = self.projected / "ob-issues/1001/e164-acn/001-LIR.yaml"
        result = self.yaml_json(projected)
        self.assertEqual(result["data"]["entries"][0]["mobile_telephone_numbers"]["en"], expected)
        result["data"]["entries"][0]["mobile_telephone_numbers"]["en"] = original["data"]["entries"][0]["mobile_telephone_numbers"]["en"]
        self.assertEqual(result, original)  # Every other field and row is preserved.
        snapshot = json.loads((self.out / "current.json").read_text())
        self.assertEqual(snapshot["data"]["entries"][0]["mobile_telephone_numbers"]["en"], expected)
        self.assertEqual(snapshot["data"]["entries"][1:], original["data"]["entries"][1:])
        before = {path: path.read_bytes() for path in (projected, self.projected / record)}
        subprocess.run(["bundle", "exec", "ruby", str(SCRIPT.with_name("repair-historical-cells.rb")),
                        str(self.data), self.data_ref, str(self.projected)], check=True)
        self.assertEqual({path: path.read_bytes() for path in before}, before)
        self.assertEqual(self.git(self.service, "status", "--porcelain"), "")

    def test_source_row_identity_mismatch_preserves_projected_bytes(self):
        fixtures, record = self.e164_fixture()
        changed = (fixtures / "1001-normalized.yaml").read_bytes().replace(b"country_code: '55'", b"country_code: '999'")
        self.write(self.service, "ob-issues/1001/e164-acn/001-LIR.yaml", changed)
        self.write(self.service, record, b"register: E164_ACN\n" + changed)
        self.service_ref = self.commit(self.service)
        self.run_projection()
        self.assertEqual((self.projected / "ob-issues/1001/e164-acn/001-LIR.yaml").read_bytes(), changed)
        self.assertEqual((self.projected / record).read_bytes(), b"register: E164_ACN\n" + changed)
        self.assert_inputs_preserved()

    def test_authored_e164_rows_remain_byte_exact(self):
        fixtures, _ = self.e164_fixture()
        normalized = (fixtures / "1001-normalized.yaml").read_bytes()
        self.write(self.data, "ob-issues/1001/meta.yaml", "issue: 1001\n")
        self.write(self.data, "ob-issues/1001/e164-acn/001-LIR.yaml", normalized)
        self.data_ref = self.commit(self.data)
        self.run_projection()
        self.assertEqual((self.projected / "ob-issues/1001/e164-acn/001-LIR.yaml").read_bytes(), normalized)
        self.assert_inputs_preserved()

    def e212_fixture(self):
        # Unedited rows extracted from canonical issue 1007 at data commit
        # 90f99728acd1e96d025ce0034fe43a38b572aa62, with real normalized/change rows.
        fixtures = SCRIPT.parent / "tests/fixtures/e212-mnc"
        self.write(self.data, "issues/1007/amendments.yaml", (fixtures / "1007-source.yaml").read_bytes())
        self.data_ref = self.commit(self.data)
        for seq in ("003", "004", "017"):
            self.write(self.service, f"ob-issues/1007/e212-mnc/{seq}-ADD.yaml",
                       (fixtures / f"{seq}-ADD.yaml").read_bytes())
            self.write(self.service, f"datasets/1162-E.212/changes/1007-{seq}-ADD-fixture.yaml",
                       (fixtures / f"{seq}-change.yaml").read_bytes())
        self.service_ref = self.commit(self.service)
        return fixtures

    def test_complete_e212_network_cells_reach_projection_and_snapshot(self):
        fixtures = self.e212_fixture()
        rows = self.yaml_json(fixtures / "1007-source.yaml")["messages"][0]["contents"]["en"]["content"][0]["content"]
        source_networks = {}
        for row in rows:
            cells = row["content"]
            code = cells[1]["content"][0]["content"][0]["text"].replace(" ", "")
            source_networks[code] = "\n".join("".join(n.get("text", "\n") for n in para["content"])
                                               for para in cells[2]["content"])
        self.assertEqual(len(source_networks), 3)
        self.write(self.service, "scripts/generate_register_snapshots.rb",
                   "require 'yaml'\nrequire 'json'\nrequire 'fileutils'\n"
                   "FileUtils.mkdir_p(ENV.fetch('SNAPSHOTS_OUT'))\n"
                   "rows = Dir['datasets/1162-E.212/changes/*.yaml'].sort.map { |p| YAML.safe_load(File.read(p)) }\n"
                   "File.write(File.join(ENV.fetch('SNAPSHOTS_OUT'), 'current.json'), JSON.generate(rows))\n"
                   "puts 'Snapshots: 1 registers, 1 files written, 0 skipped, 0 errors'\n")
        self.service_ref = self.commit(self.service)
        self.run_projection()
        snapshots = json.loads((self.out / "current.json").read_text())
        for seq, snapshot in zip(("003", "004", "017"), snapshots):
            with self.subTest(sequence=seq):
                path = self.projected / f"ob-issues/1007/e212-mnc/{seq}-ADD.yaml"
                original = self.yaml_json(fixtures / f"{seq}-ADD.yaml")
                result = self.yaml_json(path)
                entry = result["data"]["entries"][0]
                expected = (original["data"]["entries"][0]["networks"] if seq == "004"
                            else source_networks[entry["mcc_mnc_codes"].replace(" ", "")])
                self.assertEqual(entry["networks"], expected)
                self.assertEqual(snapshot["data"]["networks"], expected)
                entry["networks"] = original["data"]["entries"][0]["networks"]
                self.assertEqual(result, original)
        unchanged = self.projected / "ob-issues/1007/e212-mnc/004-ADD.yaml"
        self.assertEqual(unchanged.read_bytes(), (fixtures / "004-ADD.yaml").read_bytes())
        before = {p: p.read_bytes() for p in self.projected.rglob("*.yaml")}
        subprocess.run(["bundle", "exec", "ruby", str(SCRIPT.with_name("repair-historical-cells.rb")),
                        str(self.data), self.data_ref, str(self.projected)], check=True)
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.assert_inputs_preserved()

    def test_e212_code_spacing_does_not_prevent_source_match(self):
        fixtures = self.e212_fixture()
        source = (fixtures / "1007-source.yaml").read_bytes()
        compact = source.replace(b"text: 342 600", b"text: '342600'")
        self.assertNotEqual(compact, source)
        self.write(self.data, "issues/1007/amendments.yaml", compact)
        self.data_ref = self.commit(self.data)
        self.run_projection()
        entry = self.yaml_json(self.projected / "ob-issues/1007/e212-mnc/003-ADD.yaml")["data"]["entries"][0]
        self.assertEqual(entry["mcc_mnc_codes"], "342 600")
        self.assertEqual(entry["networks"], "Cable & Wireless (Barbados) Limited\ntrading as LIME")
        self.assert_inputs_preserved()

    def test_authored_e212_rows_remain_byte_exact(self):
        fixtures = self.e212_fixture()
        payload = (fixtures / "003-ADD.yaml").read_bytes()
        self.write(self.data, "ob-issues/1007/meta.yaml", "issue: 1007\n")
        self.write(self.data, "ob-issues/1007/e212-mnc/003-ADD.yaml", payload)
        self.data_ref = self.commit(self.data)
        self.run_projection()
        self.assertEqual((self.projected / "ob-issues/1007/e212-mnc/003-ADD.yaml").read_bytes(), payload)
        self.assert_inputs_preserved()

    def test_requires_exact_shas_matching_checkouts(self):
        previous_ref = self.data_ref
        self.authored(2, "type: ADD\n")
        for overrides in ({"data_ref": "HEAD"}, {"service_ref": "main"},
                          {"data_ref": previous_ref},
                          {"data_ref": self.service_ref}):
            with self.subTest(overrides=overrides), self.assertRaises((ValueError, subprocess.CalledProcessError)):
                self.run_projection(**overrides)
        self.assertFalse(self.out.exists())

    def test_missing_trusted_helper_fails_with_authored_input(self):
        self.authored(2, "type: ADD\n")
        (self.service / "scripts/stage_authored_patches.py").unlink()
        self.service_ref = self.commit(self.service)
        with self.assertRaisesRegex(ValueError, "pinned service lacks"):
            self.run_projection()
        self.assertFalse(self.out.exists())

    def test_uncommitted_service_script_is_never_executed(self):
        self.authored(2, "type: ADD\n")
        self.write(self.service, "scripts/migrate_actions_to_changes.rb", "raise 'untrusted checkout'\n")
        self.run_projection()
        self.assertIn("type: ADD\n", json.loads((self.out / "current.json").read_text()))

    def test_dirty_authored_input_fails(self):
        self.authored(2, "type: ADD\n")
        self.write(self.data, "ob-issues/2/e118-iin/001-ADD.yaml", "changed bytes\n")
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_projection()
        self.assertFalse(self.out.exists())

    def test_projection_failure_preserves_existing_output(self):
        self.authored(2, "type: ADD\n")
        self.write(self.service, "scripts/migrate_actions_to_changes.rb", "exit 9\n")
        self.service_ref = self.commit(self.service)
        self.write(self.out, "current.json", '["previous"]')
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_projection()
        self.assertEqual((self.out / "current.json").read_text(), '["previous"]')
        self.assertFalse(self.projected.exists())
        self.assert_inputs_preserved()

    def test_invalid_model_fails_before_projection_and_preserves_output(self):
        self.authored(2, "type: ADD\nunknown_model_field: rejected\n")
        self.write(self.out, "current.json", '["previous"]')
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            self.run_projection()
        self.assertIn("scripts/validate_data_lml.rb", caught.exception.cmd)
        self.assertEqual((self.out / "current.json").read_text(), '["previous"]')
        self.assertFalse(self.projected.exists())
        self.assert_inputs_preserved()

    def test_missing_or_failed_validator_fails_closed(self):
        self.authored(2, "type: ADD\n")
        self.write(self.out, "current.json", '["previous"]')
        for validator in (None, "exit 7\n"):
            with self.subTest(validator=validator):
                path = self.service / "scripts/validate_data_lml.rb"
                if validator is None:
                    path.unlink()
                else:
                    path.write_text(validator)
                self.service_ref = self.commit(self.service)
                with self.assertRaises(subprocess.CalledProcessError) as caught:
                    self.run_projection()
                self.assertIn("scripts/validate_data_lml.rb", caught.exception.cmd)
                self.assertEqual((self.out / "current.json").read_text(), '["previous"]')
                self.assertFalse(self.projected.exists())
                self.assert_inputs_preserved()

    def test_post_projection_mutation_is_rejected(self):
        self.authored(2, "type: ADD\n")
        target = self.service / "scripts/generate_register_snapshots.rb"
        target.write_text(target.read_text() + "File.write('ob-issues/2/e118-iin/001-ADD.yaml', 'corrupted')\n")
        self.service_ref = self.commit(self.service)
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_projection()
        self.assertFalse(self.out.exists())
        self.assert_inputs_preserved()

    def test_rescued_snapshot_error_is_rejected(self):
        target = self.service / "scripts/generate_register_snapshots.rb"
        target.write_text(target.read_text().replace('0 errors', '1 errors'))
        self.service_ref = self.commit(self.service)
        with self.assertRaisesRegex(ValueError, "zero-error summary"):
            self.run_projection()
        self.assertFalse(self.out.exists())

    def test_output_paths_cannot_replace_inputs_or_each_other(self):
        for overrides in ({"snapshots_out": self.data},
                          {"snapshots_out": self.data / "ob-issues"},
                          {"projection_root": self.service / "projection"},
                          {"projection_root": self.out}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                self.run_projection(**overrides)
        self.assert_inputs_preserved()


if __name__ == "__main__":
    unittest.main()
