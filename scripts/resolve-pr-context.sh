#!/usr/bin/env bash
set -euo pipefail

if [ -z "${GITHUB_OUTPUT:-}" ]; then
  echo "GITHUB_OUTPUT is required" >&2
  exit 1
fi

if [ -z "${GITHUB_EVENT_NAME:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ]; then
  echo "GITHUB_EVENT_NAME and GITHUB_REPOSITORY are required" >&2
  exit 1
fi

write_output() {
  local key="$1"
  local value="$2"
  local delimiter="EOF_$(date +%s%N)"
  {
    printf '%s<<%s\n' "$key" "$delimiter"
    printf '%s\n' "$value"
    printf '%s\n' "$delimiter"
  } >> "$GITHUB_OUTPUT"
}

pr_json=""

if [ "${GITHUB_EVENT_NAME}" = "pull_request" ]; then
  if [ -z "${GITHUB_EVENT_PATH:-}" ] || [ ! -f "${GITHUB_EVENT_PATH}" ]; then
    echo "GITHUB_EVENT_PATH must point to the pull_request payload" >&2
    exit 1
  fi

  pr_json="$(jq -c '.pull_request' "${GITHUB_EVENT_PATH}")"
else
  if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
    echo "GH_TOKEN or GITHUB_TOKEN is required to resolve workflow_dispatch PR context" >&2
    exit 1
  fi
  if [ -z "${GITHUB_REF_NAME:-}" ]; then
    echo "GITHUB_REF_NAME is required to resolve workflow_dispatch PR context" >&2
    exit 1
  fi

  pr_number="$(
    gh pr view "${GITHUB_REF_NAME}" \
      --repo "${GITHUB_REPOSITORY}" \
      --json number \
      --jq '.number'
  )"

  if [ -z "${pr_number}" ] || [ "${pr_number}" = "null" ]; then
    echo "No open pull request found for branch ${GITHUB_REF_NAME}" >&2
    exit 1
  fi

  pr_json="$(
    gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}"
  )"
fi

pr_number="$(jq -r '.number' <<<"${pr_json}")"
pr_title="$(jq -r '.title // ""' <<<"${pr_json}")"
pr_body="$(jq -r '.body // ""' <<<"${pr_json}")"
base_ref="$(jq -r '.base.ref' <<<"${pr_json}")"
base_sha="$(jq -r '.base.sha' <<<"${pr_json}")"
head_sha="$(jq -r '.head.sha' <<<"${pr_json}")"
merged="$(jq -r '.merged // false' <<<"${pr_json}")"
state="$(jq -r '.state // ""' <<<"${pr_json}")"
pr_author="$(jq -r '.user.login // ""' <<<"${pr_json}")"

write_output "pr_number" "${pr_number}"
write_output "pr_title" "${pr_title}"
write_output "pr_body" "${pr_body}"
write_output "base_ref" "${base_ref}"
write_output "base_sha" "${base_sha}"
write_output "head_sha" "${head_sha}"
write_output "merged" "${merged}"
write_output "state" "${state}"
write_output "pr_author" "${pr_author}"
