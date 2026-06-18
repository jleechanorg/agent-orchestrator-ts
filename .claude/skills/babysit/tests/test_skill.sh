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

# 6. The fix-all invariant 5-step loop is present (1. ... 2. ... 3. ... 4. ... 5.)
STEP_COUNT=$(grep -cE '^[0-9]+\.[[:space:]]' "$SKILL" || true)
[ "$STEP_COUNT" -ge 5 ] || fail "fix-all invariant 5 numbered steps missing (found $STEP_COUNT)"
ok "SKILL.md has $STEP_COUNT numbered list items (>=5)"

# 7. /babysit command file documents --driver
[ -f "$COMMAND_FILE" ] || fail "missing $COMMAND_FILE"
grep -q "/babysit --driver N" "$COMMAND_FILE" || fail "/babysit --driver N arg missing from babysit.md"
ok "babysit.md documents /babysit --driver N"

# 8. /babysit command file has 4 numbered rules in DRIVER mode contract
DRIVER_SECTION=$(sed -n '/## DRIVER mode contract/,$p' "$COMMAND_FILE")
RULE_COUNT=$(printf '%s\n' "$DRIVER_SECTION" | grep -cE '^[0-9]+\.[[:space:]]' || true)
[ "$RULE_COUNT" -eq 4 ] || fail "expected 4 DRIVER rules, found $RULE_COUNT"
ok "babysit.md has 4 numbered DRIVER mode contract rules"

echo
echo "ALL CHECKS PASSED"
