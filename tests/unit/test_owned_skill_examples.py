#!/usr/bin/env python3
"""Exercise canonical skill examples offline; never call real gh, ao, or tmux."""

import datetime
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
ELOOP = ROOT / "skills/eloop/SKILL.md"
TRIAGE = ROOT / "skills/ao-lifecycle-triage/SKILL.md"

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ["GH_CALLS"], "a") as log:
    log.write(json.dumps(args) + "\n")
fixture = json.loads(Path(os.environ["GH_FIXTURE"]).read_text())
if args[:2] == ["pr", "view"]:
    value = fixture["meta"]
elif "graphql" in args:
    value = {"data": {"repository": {"pullRequest": {"reviewThreads": {
        "pageInfo": {"hasNextPage": False, "endCursor": None},
        "nodes": [{"isResolved": fixture["resolved"]}]
    }}}}}
elif any("/comments" in arg for arg in args):
    value = [{"body": "VERDICT: SKIPPED", "created_at": "2026-01-01T00:00:00Z"}]
elif any("state=closed" in arg for arg in args):
    value = fixture["closed"]
elif any("state=open" in arg for arg in args):
    value = []
elif any("/reviews" in arg for arg in args):
    value = []
else:
    value = {"state": "pending", "head": {"sha": "a" * 40}, "mergeable_state": "blocked"}
if "--jq" in args:
    result = subprocess.run(["jq", "-r", args[args.index("--jq") + 1]],
                            input=json.dumps(value), text=True, capture_output=True)
    print(result.stdout, end="")
    sys.exit(result.returncode)
print(json.dumps(value))
'''


def example_after(marker):
    section = ELOOP.read_text().split(marker, 1)[1]
    return re.search(r"```bash\n(.*?)\n```", section, re.DOTALL).group(1)


class OwnedSkillExamples(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="ao-owned-skill-test-")
        self.addCleanup(self.scratch.cleanup)
        self.directory = Path(self.scratch.name)
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        # Only explicitly allowed local tools are reachable by extracted snippets.
        for name in ["bash", "jq", "grep", "tail", "head", "cut"]:
            executable = shutil.which(name)
            self.assertIsNotNone(executable, f"Required offline test tool missing: {name}")
            (self.bin / name).symlink_to(executable)
        (self.bin / "python3").symlink_to(sys.executable)
        for name, body in {
            "gh": FAKE_GH,
            "tmux": "#!/bin/sh\nexit 0\n",
            "ao": "#!/bin/sh\necho 'Unexpected operational AO command' >&2\nexit 99\n",
        }.items():
            path = self.bin / name
            path.write_text(body)
            path.chmod(0o755)
        now = datetime.datetime.now(datetime.timezone.utc)

        def iso(hours):
            return (now - datetime.timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")

        self.fixture = {
            "meta": {
                "state": "OPEN", "mergedAt": None, "mergeable": "MERGEABLE",
                "reviewDecision": "APPROVED", "url": "https://example.invalid/pr/761",
                "title": "[agento] docs: skills",
                "statusCheckRollup": [{"name": "Test", "status": "COMPLETED",
                                       "conclusion": "SUCCESS", "completedAt": iso(1)}],
            },
            "resolved": True,
            "closed": [
                {"number": 1, "title": "[agento] recent", "merged_at": iso(1)},
                {"number": 2, "title": "[agento] old", "merged_at": iso(25)},
                {"number": 3, "title": "unmerged", "merged_at": None},
                {"number": 4, "title": "recent manual", "merged_at": iso(2)},
            ],
        }

    def run_example(self, marker):
        fixture = self.directory / "fixture.json"
        fixture.write_text(json.dumps(self.fixture))
        calls = self.directory / "calls.jsonl"
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-c", example_after(marker)],
            cwd=ROOT, capture_output=True, text=True, timeout=15,
            env={"PATH": str(self.bin), "PR_NUM": "761",
                 "REPO": "jleechanorg/agent-orchestrator-ts",
                 "GH_FIXTURE": str(fixture), "GH_CALLS": str(calls)},
        )
        return result, [json.loads(line) for line in calls.read_text().splitlines()]

    def test_observe_queries_the_typescript_fork(self):
        result, calls = self.run_example("Reference commands:")
        self.assertEqual(result.returncode, 0, result.stderr)
        endpoints = [call[1] for call in calls if call[0] == "api"]
        self.assertTrue(any("repos/jleechanorg/agent-orchestrator-ts/pulls?" in x for x in endpoints))
        self.assertFalse(any("repos/jleechanorg/agent-orchestrator/pulls?" in x for x in endpoints))

    def test_measure_selects_only_last_24_hours_and_preserves_title_classification(self):
        result, _ = self.run_example("### Phase 2: Measure")
        self.assertEqual(result.returncode, 0, result.stderr)
        # jq may pretty-print several independent objects rather than an array.
        decoder = json.JSONDecoder()
        output = result.stdout.strip()
        records = []
        while output:
            value, end = decoder.raw_decode(output)
            records.append(value)
            output = output[end:].strip()
        self.assertEqual([item["number"] for item in records], [1, 4])
        self.assertEqual([item["agento"] for item in records], [True, False])

    def test_premerge_example_rejects_failing_or_pending_checks(self):
        for status, conclusion in [("COMPLETED", "FAILURE"), ("IN_PROGRESS", None)]:
            with self.subTest(status=status):
                self.fixture["meta"]["statusCheckRollup"][0].update(status=status, conclusion=conclusion)
                result, _ = self.run_example("Pre-merge gate check:")
                self.assertNotEqual(result.returncode, 0, "The documented gate accepted blocked CI")

    def test_premerge_example_rejects_unresolved_threads_and_missing_approval(self):
        for resolved, review in [(False, "APPROVED"), (True, "CHANGES_REQUESTED")]:
            with self.subTest(resolved=resolved, review=review):
                self.fixture["resolved"] = resolved
                self.fixture["meta"]["reviewDecision"] = review
                result, _ = self.run_example("Pre-merge gate check:")
                self.assertNotEqual(result.returncode, 0, "The documented gate accepted missing review approval")

    def test_premerge_example_accepts_complete_structural_proof(self):
        result, _ = self.run_example("Pre-merge gate check:")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("passes structural preflight", result.stdout)

    def test_installable_skills_do_not_require_personal_files_or_host_paths(self):
        intro = ELOOP.read_text().split("## Purpose", 1)[0].lower()
        self.assertIn("optional", intro)
        for path in [ELOOP, TRIAGE]:
            self.assertNotRegex(path.read_text(), r"/Users/[^/]+/|/home/[^/]+/|bb5e6b7f8db3")

    def test_cleanup_and_recording_preserve_owner_and_review_boundaries(self):
        text = ELOOP.read_text() + TRIAGE.read_text()
        self.assertNotIn("tmux kill-session", text)
        self.assertNotIn("git worktree remove --force", text)
        self.assertNotRegex(text, r"(?i)push[^\n]*to [`\"]?origin/main")
        self.assertNotIn('grep -oiE "VERDICT:', text)
        self.assertIn("ao session kill", text)
        self.assertIn("isFreshPassVerdictContractSatisfied", text)

    def test_discovery_stubs_still_forward_to_canonical_skills(self):
        for name in ["ao-lifecycle-triage", "eloop"]:
            stub = (ROOT / ".agents/skills" / name / "SKILL.md").read_text()
            self.assertIn(f"skills/{name}/SKILL.md", stub)
            self.assertIn("discovery metadata only", stub)
            self.assertNotIn("```bash", stub)


if __name__ == "__main__":
    unittest.main(verbosity=2)
