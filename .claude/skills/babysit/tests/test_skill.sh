#!/usr/bin/env bash
# test_skill.sh — sanity checks for the babysit SKILL content
#
# Verifies the structural shape of .claude/skills/babysit/SKILL.md and
# .claude/commands/babysit.md after the DRIVER mode + fix-all invariant
# changes (bd-fh89, bd-6gld).
#
# Acceptance: every check exits 0 on success, the script exits 0 only when
# all checks pass. Run from anywhere: paths are resolved relative to this
# script's parent.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL="$HERE/../SKILL.md"
COMMAND_FILE="$HERE/../../../commands/babysit.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok: $*"; }

# 1. SKILL.md exists and is non-empty
[ -f "$SKILL" ] || fail "missing $SKILL"
[ -s "$SKILL" ] || fail "$SKILL is empty"
ok "SKILL.md exists and is non-empty"

# 2. DRIVER mode is mentioned
grep -q "DRIVER mode" "$SKILL" || fail "DRIVER mode not mentioned in SKILL.md"
ok "SKILL.md mentions DRIVER mode"

# 3. Fix-all invariant subsection exists
grep -q "Fix-all invariant" "$SKILL" || fail "Fix-all invariant subsection missing"
ok "SKILL.md has Fix-all invariant subsection"

# 4. Step 3 spawn example does NOT advertise a fake --driver CLI flag.
#    Only check lines that begin with `ao spawn` (the actual command).
if grep -E '^[[:space:]]*ao spawn.*--driver' "$SKILL" >/dev/null 2>&1; then
  fail "SKILL.md documents a non-existent --driver flag for ao spawn"
fi
ok "SKILL.md does not advertise fake --driver CLI flag"

# 5. The spawn example DOES include a DRIVER MODE prompt (contract in prompt)
grep -q "DRIVER MODE:" "$SKILL" || fail "DRIVER MODE prompt missing from spawn example"
ok "SKILL.md spawn example uses DRIVER MODE prompt"

# 6. The fix-all invariant 5-step loop is present, scoped to that section.
#    Extract content between "### Fix-all invariant" and the next "### " or
#    "## " heading (or EOF), then count numbered list items within.
FIXALL_SECTION=$(awk '
  /^### Fix-all invariant/ {flag=1; next}
  /^### / && flag {flag=0}
  /^## / && flag {flag=0}
  flag
' "$SKILL")
[ -n "$FIXALL_SECTION" ] || fail "could not extract Fix-all invariant section"
STEP_COUNT=$(printf '%s\n' "$FIXALL_SECTION" | grep -cE '^[0-9]+\.[[:space:]]' || true)
[ "$STEP_COUNT" -eq 5 ] || fail "expected 5 fix-all steps in Fix-all invariant section, found $STEP_COUNT"
ok "SKILL.md Fix-all invariant section has 5 numbered steps"

# 7. /babysit command file documents --driver
[ -f "$COMMAND_FILE" ] || fail "missing $COMMAND_FILE"
grep -q "/babysit --driver N" "$COMMAND_FILE" || fail "/babysit --driver N arg missing from babysit.md"
ok "babysit.md documents /babysit --driver N"

# 8. /babysit command file has 4 numbered rules in DRIVER mode contract,
#    scoped to that section only (stop at next "## " heading).
DRIVER_SECTION=$(awk '
  /^## DRIVER mode contract/ {flag=1; next}
  /^## / && flag {flag=0}
  flag
' "$COMMAND_FILE")
[ -n "$DRIVER_SECTION" ] || fail "could not extract DRIVER mode contract section"
RULE_COUNT=$(printf '%s\n' "$DRIVER_SECTION" | grep -cE '^[0-9]+\.[[:space:]]' || true)
[ "$RULE_COUNT" -eq 4 ] || fail "expected 4 DRIVER rules in DRIVER mode contract section, found $RULE_COUNT"
ok "babysit.md DRIVER mode contract section has 4 numbered rules"

echo
echo "ALL CHECKS PASSED"
