#!/bin/bash

ao_staging_config_path() {
  if [ -n "${AO_STAGING_CONFIG_PATH:-}" ]; then
    printf '%s\n' "$AO_STAGING_CONFIG_PATH"
    return 0
  fi
  if [ -n "${AO_CONFIG_STAGING_PATH:-}" ]; then
    printf '%s\n' "$AO_CONFIG_STAGING_PATH"
    return 0
  fi
  if [ -f "${HOME}/.openclaw/agent-orchestrator.yaml" ]; then
    # Backward-compatibility fallback
    printf '%s/.openclaw/agent-orchestrator.yaml\n' "$HOME"
    return 0
  fi
  printf '%s/.hermes/agent-orchestrator.yaml\n' "${HOME:?HOME is required}"
}

ao_production_config_path() {
  if [ -n "${AO_PROD_CONFIG_PATH:-}" ]; then
    printf '%s\n' "$AO_PROD_CONFIG_PATH"
    return 0
  fi
  if [ -n "${AO_PRODUCTION_CONFIG_PATH:-}" ]; then
    printf '%s\n' "$AO_PRODUCTION_CONFIG_PATH"
    return 0
  fi
  # HERMES_HOME is the canonical AO/Hermes worker config directory (ao-install.sh,
  # ao-repo-setup.sh, and the launchd plist all use it). Check it first so the
  # config written by ao-install.sh is auto-discovered without AO_CONFIG_PATH.
  # Tilde-expand HERMES_HOME when it starts with literal ~ (not when already $HOME-based).
  local hermes_home_expanded="${HERMES_HOME:-}"
  if [ "${hermes_home_expanded:0:1}" = "~" ]; then
    hermes_home_expanded="${HOME}${hermes_home_expanded:1}"
  fi
  if [ -n "${HERMES_HOME:-}" ] && [ -f "${hermes_home_expanded}/agent-orchestrator.yaml" ]; then
    printf '%s/agent-orchestrator.yaml\n' "$hermes_home_expanded"
    return 0
  fi
  if [ -f "${HOME}/.hermes_prod/agent-orchestrator.yaml" ]; then
    printf '%s/.hermes_prod/agent-orchestrator.yaml\n' "$HOME"
    return 0
  fi
  if [ -f "${HOME}/.openclaw_prod/agent-orchestrator.yaml" ]; then
    # Backward-compatibility fallback
    printf '%s/.openclaw_prod/agent-orchestrator.yaml\n' "$HOME"
    return 0
  fi
  # Default: use .hermes_prod when nothing exists yet.
  printf '%s/.hermes_prod/agent-orchestrator.yaml\n' "${HOME:?HOME is required}"
}

ao_legacy_alias_paths() {
  printf '%s\n' \
    "${HOME:?HOME is required}/.agent-orchestrator.yaml" \
    "${HOME:?HOME is required}/.agent-orchestrator.yml" \
    "${HOME:?HOME is required}/.config/agent-orchestrator/config.yaml"
}

ao_realpath() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$1" 2>/dev/null && return 0
  fi
  if command -v node >/dev/null 2>&1; then
    node -e 'const fs = require("node:fs"); console.log(fs.realpathSync(process.argv[1]));' "$1" 2>/dev/null && return 0
  fi
  if command -v readlink >/dev/null 2>&1; then
    readlink -f "$1" 2>/dev/null && return 0
  fi

  local dir base
  dir="$(dirname "$1")"
  base="$(basename "$1")"
  if [ -d "$dir" ]; then
    (
      cd "$dir" >/dev/null 2>&1 &&
      printf '%s/%s\n' "$(pwd -P)" "$base"
    ) && return 0
  fi

  printf '%s\n' "$1"
}

ao_find_config_path() {
  if [ -n "${AO_CONFIG_PATH:-}" ] && [ -f "$AO_CONFIG_PATH" ]; then
    printf '%s\n' "$AO_CONFIG_PATH"
    return 0
  fi

  local candidate
  for candidate in "$(ao_staging_config_path)" "$(ao_production_config_path)"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  while IFS= read -r candidate; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(ao_legacy_alias_paths)

  return 1
}

ao_validate_topology() {
  local staging_path production_path staging_real production_real
  staging_path="$(ao_staging_config_path)"
  production_path="$(ao_production_config_path)"

  if [ -L "$staging_path" ]; then
    echo "ERROR: staging config must be a real file, not a symlink: $staging_path" >&2
    return 1
  fi

  if [ -L "$production_path" ]; then
    echo "ERROR: production config must be a real file, not a symlink: $production_path" >&2
    return 1
  fi

  if [ -f "$staging_path" ] && [ -f "$production_path" ]; then
    staging_real="$(ao_realpath "$staging_path")"
    production_real="$(ao_realpath "$production_path")"
    if [ "$staging_real" = "$production_real" ]; then
      echo "ERROR: staging and production configs resolve to the same file: $staging_real" >&2
      return 1
    fi
  fi
}
