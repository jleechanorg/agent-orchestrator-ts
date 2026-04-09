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
  printf '%s/.openclaw/agent-orchestrator.yaml\n' "${HOME:?HOME is required}"
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
  printf '%s/.openclaw_prod/agent-orchestrator.yaml\n' "${HOME:?HOME is required}"
}

ao_legacy_alias_paths() {
  printf '%s\n' \
    "${HOME:?HOME is required}/.agent-orchestrator.yaml" \
    "${HOME:?HOME is required}/.agent-orchestrator.yml" \
    "${HOME:?HOME is required}/.config/agent-orchestrator/config.yaml"
}

ao_realpath() {
  python3 -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$1" 2>/dev/null \
    || readlink -f "$1" 2>/dev/null \
    || printf '%s\n' "$1"
}

ao_find_config_path() {
  if [ -n "${AO_CONFIG_PATH:-}" ] && [ -f "$AO_CONFIG_PATH" ]; then
    printf '%s\n' "$AO_CONFIG_PATH"
    return 0
  fi

  local candidate
  for candidate in "$(ao_production_config_path)" "$(ao_staging_config_path)"; do
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
