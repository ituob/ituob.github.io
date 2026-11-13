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
        self.write(self.service, "ob-issues/1/meta.yaml", "historical metadata\n")
        self.write(self.service, "ob-issues/1/test/001-ADD.yaml", "historical amendment\n")
        self.write(self.service, "datasets/changes.json", '["committed baseline"]')
        self.write(self.service, "scripts/validate_data_lml.rb", '''raise 'full validation required' unless ARGV == ['--all']
raise 'wrong corpus root' unless File.realpath(ENV.fetch('OB_ISSUES_OUT_PATH')) == File.realpath('ob-issues')
raise 'wrong source root' unless ENV.fetch('ITU_OB_DATA_ROOT').end_with?('/data/issues')
paths = Dir[File.join(ENV.fetch('OB_ISSUES_OUT_PATH'), '*', 'test', '*.yaml')]
raise 'staged input missing' if paths.length < 2
raise 'unknown model field' if paths.any? { |p| File.read(p).include?('unknown_model_field:') }
File.write('.model-validated', 'valid')
''')
        self.write(self.service, "scripts/migrate_actions_to_changes.rb", '''require 'json'
raise 'model validation must precede projection' unless File.exist?('.model-validated')
paths = Dir['ob-issues/*/test/*.yaml'].sort
File.write('datasets/changes.json', JSON.generate(paths.map { |p| File.binread(p) }))
''')
        self.write(self.service, "scripts/generate_register_snapshots.rb", '''require 'json'
require 'fileutils'
FileUtils.mkdir_p(ENV.fetch('SNAPSHOTS_OUT'))
File.write(File.join(ENV.fetch('SNAPSHOTS_OUT'), 'current.json'), File.read('datasets/changes.json'))
puts 'Snapshots: 1 registers, 1 files written, 0 skipped, 0 errors'
''')
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
        self.write(self.data, f"ob-issues/{issue}/test/001-ADD.yaml", payload)
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
        self.assertEqual((self.projected / "ob-issues/2/test/001-ADD.yaml").read_bytes(), first)
        self.assertEqual((self.projected / "ob-issues/3/test/001-ADD.yaml").read_bytes(), second)
        self.assertEqual((self.projected / "ob-issues/1/test/001-ADD.yaml").read_bytes(),
                         b"historical amendment\n")
        self.assert_inputs_preserved()

    def test_historical_only_uses_committed_changes_without_helper_or_migration(self):
        (self.service / "scripts/stage_authored_patches.py").unlink()
        (self.service / "scripts/migrate_actions_to_changes.rb").unlink()
        (self.service / "scripts/validate_data_lml.rb").unlink()
        self.service_ref = self.commit(self.service)
        self.assertEqual(self.run_projection(), "historical-only")
        self.assertEqual(json.loads((self.out / "current.json").read_text()), ["committed baseline"])
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
        self.write(self.data, "ob-issues/2/test/001-ADD.yaml", "changed bytes\n")
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
        target.write_text(target.read_text() + "File.write('ob-issues/2/test/001-ADD.yaml', 'corrupted')\n")
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
