"""Item history gains printed pre-seed changes, in bulletin order, without new items."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "add-pre-seed-item-history.rb"

# Stands in for the pinned service: one register seeded at OB 10 whose change source
# prints ADD 5 (A), SUP 8 (A and B), and a seed-issue SUP 10 (A) the seed already reflects.
FAKE_SERVICE = """module Ituob
  Change = Struct.new(:type, :ob_issue_no, :data, :code) do
    def seed? = type == 'SEED'
    def identifier
      code_value = code
      Struct.new(:code) { def direct? = true; def to_hash = { 'code' => code } }.new(code_value)
    end
  end
  module Registers
    module Strategies
      class Base
        def self.rows_for(change, _key_field, _fallbacks) = change.data['entries']
        def self.entry_key(row, key_field, _fallbacks) = row[key_field]
      end
    end
  end
  module Catalogs
    module Registers
      Entry = Struct.new(:slug, :key_field, :fallback_key_fields)
      def self.all_register_ids = ['R']
      def self.find(_id) = Entry.new('r', 'code', [])
    end
  end
  module Verifiers
    class RegisterStateIntegrityVerifier
      Source = Struct.new(:seed_issue, :pre_seed_changes, :each_sorted)
      Replay = Struct.new(:source)
      def self.build_replay(_entry)
        rows = ->(*codes) { { 'entries' => codes.map { |c| { 'code' => c } } } }
        pre = [Change.new('ADD', 5, rows.('A'), 'A'), Change.new('SUP', 8, rows.('A', 'B'), 'A')]
        at_seed = [Change.new('SEED', 10, {}, '__seed__'), Change.new('SUP', 10, rows.('A'), 'A'),
                   Change.new('MOD', 12, rows.('A'), 'A')]
        Replay.new(Source.new(10, pre, at_seed))
      end
    end
  end
end
"""


def event(kind, issue, code="A"):
    return {"type": kind, "ob_issue": issue, "identifier": {"code": code}}


class PreSeedItemHistoryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        lib = root / "lib"
        (lib / "ituob").mkdir(parents=True)
        (lib / "ituob.rb").write_text(FAKE_SERVICE)
        for name in ("support", "registers", "catalogs", "verifiers"):
            (lib / "ituob" / f"{name}.rb").write_text("")
        self.lib, self.snapshots = lib, root / "snapshots"
        (self.snapshots / "r").mkdir(parents=True)

    def write(self, name, key_history):
        (self.snapshots / "r" / name).write_text(json.dumps({"slug": "r", "key_history": key_history, "history": []}))

    def read(self, name):
        return json.loads((self.snapshots / "r" / name).read_text())

    def run_step(self):
        return subprocess.run(["ruby", "-I", str(self.lib), str(SCRIPT), str(self.snapshots)],
                              check=True, capture_output=True, text=True).stdout

    def test_printed_changes_merge_in_order_for_existing_items_only(self):
        seed = {"type": "SEED", "ob_issue": 10, "identifier": {"code": "__seed__"}}
        mod = event("MOD", 12)
        for name in ("current.json", "at-12.json"):
            self.write(name, {"A": [seed, mod], "C": [seed]})
        self.assertIn("3 printed", self.run_step())
        for name in ("current.json", "at-12.json"):
            state = self.read(name)
            self.assertEqual([(e["type"], e["ob_issue"]) for e in state["key_history"]["A"]],
                             [("ADD", 5), ("SUP", 8), ("SUP", 10), ("SEED", 10), ("MOD", 12)])
            self.assertEqual(state["key_history"]["C"], [seed])
            self.assertNotIn("B", state["key_history"])
            self.assertEqual(state["history"], [])

    def test_second_run_adds_nothing_and_applied_seed_issue_changes_are_not_duplicated(self):
        sup10 = event("SUP", 10)
        self.write("current.json", {"A": [sup10, event("MOD", 12)]})
        self.run_step()
        once = self.read("current.json")
        self.assertIn("0 printed", self.run_step())
        self.assertEqual(self.read("current.json"), once)
        self.assertEqual([(e["type"], e["ob_issue"]) for e in once["key_history"]["A"]],
                         [("ADD", 5), ("SUP", 8), ("SUP", 10), ("MOD", 12)])


if __name__ == "__main__":
    unittest.main()
