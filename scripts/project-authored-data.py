#!/usr/bin/env python3
"""Project pinned canonical amendments through pinned service code into site snapshots."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def exact_head(root, ref):
    if not re.fullmatch(r"[0-9a-f]{40}", ref):
        raise ValueError("refs must be explicit lowercase 40-character commit SHAs")
    if git(root, "rev-parse", "--verify", ref + "^{commit}").decode().strip() != ref:
        raise ValueError(f"not an exact commit: {ref}")
    if git(root, "rev-parse", "HEAD").decode().strip() != ref:
        raise ValueError(f"checkout HEAD does not match pinned ref: {root}")


def project(data_root, service_root, data_ref, service_ref, snapshots_out, projection_root):
    data_root, service_root, snapshots_out, projection_root = (
        Path(p).resolve() for p in (data_root, service_root, snapshots_out, projection_root)
    )
    if projection_root.exists():
        raise ValueError("projection root must be a new output directory")
    if (projection_root == snapshots_out or projection_root in snapshots_out.parents
            or snapshots_out in projection_root.parents):
        raise ValueError("projection and snapshot outputs must not overlap")
    exact_head(data_root, data_ref)
    exact_head(service_root, service_ref)
    # Publishing may replace only the snapshot output, never either input tree.
    for source in (data_root, service_root):
        if snapshots_out == source or snapshots_out in source.parents:
            raise ValueError("snapshot output must not replace an input tree")
        authored_root = source / "ob-issues"
        if snapshots_out == authored_root or authored_root in snapshots_out.parents:
            raise ValueError("snapshot output must not overwrite authored inputs")
        if projection_root == source or source in projection_root.parents or projection_root in source.parents:
            raise ValueError("projection output must not overlap an input tree")
    paths = git(data_root, "ls-tree", "-rz", "--name-only", data_ref).split(b"\0")
    authored = any(p.startswith(b"ob-issues/") for p in paths)

    with tempfile.TemporaryDirectory(prefix="ituob-site-projection-") as temporary:
        temporary = Path(temporary)
        overlay = temporary / "service"
        overlay.mkdir()
        archive = temporary / "service.tar"
        subprocess.run(["git", "-C", str(service_root), "archive", "--format=tar",
                        "--output", str(archive), service_ref], check=True)
        subprocess.run(["tar", "-xf", str(archive), "-C", str(overlay)], check=True)
        snapshots = temporary / "snapshots"
        env = dict(os.environ, BUNDLE_GEMFILE=str(overlay / "ituob/Gemfile"),
                   SNAPSHOTS_OUT=str(snapshots))

        def run(*command, capture=False):
            result = subprocess.run(command, cwd=overlay, env=env, check=True,
                                    text=True, stdout=subprocess.PIPE if capture else None)
            if capture:
                print(result.stdout, end="")
            return result

        manifest = temporary / "authored-manifest.json"
        stage_args = ("--data-root", str(data_root), "--service-root", str(overlay),
                      "--manifest", str(manifest))
        if authored:
            helper = overlay / "scripts/stage_authored_patches.py"
            if not helper.is_file():
                raise ValueError("pinned service lacks scripts/stage_authored_patches.py")
            run(sys.executable, str(helper), "stage", *stage_args,
                "--base-ref", data_ref, "--data-ref", data_ref)
            if json.loads(manifest.read_text()).get("messages"):
                run(sys.executable, str(helper), "validate-messages", *stage_args)
            run("bundle", "exec", "ruby", "scripts/migrate_actions_to_changes.rb")

        result = run("bundle", "exec", "ruby", "scripts/generate_register_snapshots.rb", capture=True)
        # The generator can rescue per-register errors without exiting nonzero.
        summary = re.findall(r"^Snapshots: .*?, ([0-9]+) errors$", result.stdout, re.MULTILINE)
        if summary != ["0"]:
            raise ValueError("snapshot generator did not report exactly one zero-error summary")
        if authored:
            run(sys.executable, str(helper), "check", *stage_args)
        exact_head(data_root, data_ref)
        exact_head(service_root, service_ref)
        if not snapshots.is_dir() or not any(snapshots.rglob("*.json")):
            raise ValueError("snapshot generator produced no JSON snapshots")
        if snapshots_out.exists():
            shutil.rmtree(snapshots_out)
        snapshots_out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(snapshots, snapshots_out)
        projection_root.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(overlay), str(projection_root))
    mode = "authored projection" if authored else "historical-only"
    print(f"Site snapshots: {mode}; data={data_ref}; service={service_ref}")
    print(f"OB_DATA_ROOT={projection_root}")
    return mode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--service-root", type=Path, required=True)
    parser.add_argument("--data-ref", required=True)
    parser.add_argument("--service-ref", required=True)
    parser.add_argument("--snapshots-out", type=Path, required=True)
    parser.add_argument("--projection-root", type=Path, required=True)
    args = parser.parse_args()
    try:
        project(**vars(args))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"site authored projection: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
