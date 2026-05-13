#!/usr/bin/env bash
# Prepend directories that may contain the pnpm global `ao` shim (layout varies by pnpm major).
# shellcheck shell=bash
append_pnpm_global_paths() {
  export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
  export PATH="$PNPM_HOME:${HOME}/.npm-global/bin:$PATH"
  # Prefer the same pnpm binary that ran `pnpm install -g` (Corepack can route
  # different versions by cwd; `root -g` must match the installer).
  local pnpm_cmd="${AO_PNPM_FOR_GLOBAL:-}"
  if [ -z "$pnpm_cmd" ]; then
    pnpm_cmd="$(command -v pnpm 2>/dev/null || true)"
  fi
  [ -n "$pnpm_cmd" ] || return 0
  local global_bin=""
  global_bin="$("$pnpm_cmd" bin -g 2>/dev/null || true)"
  if [ -n "$global_bin" ] && [ "$global_bin" != "undefined" ] && [ -d "$global_bin" ]; then
    export PATH="${global_bin}:$PATH"
  fi
  local root_g pre gbin
  root_g="$("$pnpm_cmd" root -g 2>/dev/null || true)"
  if [ -n "$root_g" ] && [ "$root_g" != "undefined" ]; then
    gbin="$(cd "$(dirname "$root_g")" && pwd)/bin"
    if [ -d "$gbin" ]; then
      export PATH="$gbin:$PATH"
    fi
  fi
  pre="$("$pnpm_cmd" prefix -g 2>/dev/null || true)"
  if [ -n "$pre" ] && [ "$pre" != "undefined" ] && [ -d "${pre}/bin" ]; then
    export PATH="${pre}/bin:$PATH"
  fi
  hash -r 2>/dev/null || true
}
