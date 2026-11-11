#!/usr/bin/env bash
# Session-start cognition loader — shared by the Claude Code (.claude/settings.json)
# and Codex (.codex/config.toml) SessionStart hooks. Refreshes THIS node's own
# cognition cache; only Codex also consumes hook stdout as its injection channel.
#
# Design: LOCAL-FIRST PRESENT + ASYNC REFRESH. The hook fires on every
# startup/resume/compact and on every process respawn — so it must NEVER put a
# live call to the apex hub on the boot path. Acquisition (fetch) and
# presentation (inject) are separate concerns:
#   - presentation reads a durable, gitignored local cache
#     (.cogni/.cognition-cache.md) and is pure-offline, instant, and
#     deterministic;
#   - acquisition is a backgrounded, TTL-gated refresh whose failure is silent,
#     because a stale-but-present bundle always beats a network stall or a scary
#     wall. Once a session has ever oriented, a hub outage is invisible here.
# Only genuine first-boot with no cache surfaces a short, honest notice, and it
# never cries wolf: it separates "no credentials yet" (a setup step) from a
# key-present failure (hub down/slow, or a key without a principal).
#
# Why this matters: this hook runs on every agent session across the whole
# fleet. Coupling boot to a live cognidao.org fetch made the apex a fleet-wide
# SPOF and, worst of all, broke the very tooling meant to warn "prod is down"
# precisely because prod was down (bug.5122 — cognition boot self-dependency).
#
# .env.cogni holds two accounts (see .env.cogni.example): the NODE account
# (this node's own hub — the bearer used here) and the OPERATOR account
# (cognidao.org — CI/CD only: flight, deploy, secrets; never used by this loader).
set -u

CACHE_FILE=".cogni/.cognition-cache.md"
REFRESH_TTL_SECONDS=900   # only refresh in the background if cache older than this
FETCH_TIMEOUT=6           # bound the foreground first-boot fetch

# Hooks may start from a subdirectory. Resolve every repo-relative path from the
# git root so credentials, repo-spec, and the durable cache never depend on cwd.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || exit 0

# Older Cogni setups installed a user-level Codex hook. Codex runs matching
# user + project hooks concurrently. Both presenters take the same short-lived
# per-thread lock, so exactly one writes this event's developer context; the
# winner releases it immediately for later resume/clear/compact events.
if [ -n "${CODEX_THREAD_ID:-}" ]; then
  safe_thread_id="$(printf '%s' "$CODEX_THREAD_ID" | tr -cd '[:alnum:]_-')"
  COGNI_HOOK_LOCK="${TMPDIR:-/tmp}/cogni-cognition-${safe_thread_id}.lock"
  mkdir "$COGNI_HOOK_LOCK" 2>/dev/null || exit 0
  trap 'rmdir "$COGNI_HOOK_LOCK" 2>/dev/null || true' EXIT
fi

# emit_agent_context <text> — surface <text> only where the hook is the selected
# injection channel. The bundle is a live projection of the Dolt knowledge hub.
# Harnesses ingest it differently:
#   - Codex reads raw stdout as developer context and the .codex/config.toml
#     `additionalContextLimit = 0` disables its head/tail spill, so the full
#     payload lands untruncated.
#   - Claude Code expands CLAUDE.md @imports before/at SessionStart, so hook output
#     is too late for that session and duplicates a preview of the same bundle.
#     Its hook is therefore write-only; the committed AGENTS.md floor covers a
#     cold first boot and the warmed cache supplies the rich contract thereafter.
emit_agent_context() {
  if [ -n "${CODEX_THREAD_ID:-}" ]; then
    printf '%s\n' "$1"
  fi
}

# emit_claude_context <text> — Claude Code only, and only when this session's
# CLAUDE.md @import could not have seen the cache: Claude resolves imports
# before its SessionStart hook writes the file. Claude Code shows at most
# 10,000 characters of hook context; anything longer is saved to a file with a
# 2 KB preview, which loses the contract. So send the agent-contract section
# itself (it fits), never the whole bundle; the import loads the rest next
# session. A recovery notice is short and goes as is.
CLAUDE_CONTEXT_MAX_CHARS=9900
emit_claude_context() {
  [ -z "${CODEX_THREAD_ID:-}" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  payload="$1"
  if bundle_is_complete "$1"; then
    contract="$(printf '%s\n' "$1" | awk '/^## The agent-contract/{on=1} on{print} /^<\/agent-contract>/{exit}')"
    payload="$(printf '%s\n\n%s\n\n%s' \
      "COGNI COGNITION (first boot): the CLAUDE.md import ran before the cache existed. This is the agent-contract; the full bundle loads through CLAUDE.md next session." \
      "$contract" \
      "Governing index for this session: GET the node's /api/v1/knowledge/index.")"
  fi
  [ "$(printf '%s' "$payload" | wc -m | tr -d ' ')" -le "$CLAUDE_CONTEXT_MAX_CHARS" ] || return 0
  printf '%s' "$payload" \
    | jq -Rs '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:.}}'
}

# The hook's JSON input names the SessionStart source (startup, resume, clear,
# compact). Read it once; absent input counts as startup.
HOOK_SOURCE="startup"
hook_input=""
if [ ! -t 0 ]; then
  # Bounded read: a caller's stdin may stay open (e.g. a setup script), so never
  # block on it. Hook input is one small JSON object, delivered at once.
  IFS= read -r -d '' -t 1 hook_input || true
  if [ -n "$hook_input" ] && command -v jq >/dev/null 2>&1; then
    HOOK_SOURCE="$(printf '%s' "$hook_input" | jq -r '.source // "startup"' 2>/dev/null || printf startup)"
  fi
fi

# cache_is_fresh_for_this_boot — a new session (source startup) and a cache
# written in the last 10 minutes, e.g. by workspace setup racing this start, so
# the import may have missed it. Resume, clear and compact keep the import's
# copy and get nothing here.
cache_is_fresh_for_this_boot() {
  [ "$HOOK_SOURCE" = "startup" ] || return 1
  [ -n "$(find "$CACHE_FILE" -mmin -10 2>/dev/null)" ]
}

read_env_file_value() {
  var_name="$1"
  env_file="${2:-.env.cogni}"
  [ -f "$env_file" ] || return 0
  awk -F= -v key="$var_name" '
    $1 == key {
      value = substr($0, length(key) + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^["'\'']|["'\'']$/, "", value)
      print value
      exit
    }
  ' "$env_file" 2>/dev/null
}

# Node hub URL from repo-spec intent.name (root .cogni/repo-spec.yaml).
node_slug=""
if [ -f .cogni/repo-spec.yaml ]; then
  node_slug="$(awk '
    /^intent:/ { in_intent = 1; next }
    in_intent && /^[^[:space:]]/ { in_intent = 0 }
    in_intent && /^[[:space:]]+name:/ {
      sub(/^[[:space:]]+name:[[:space:]]*/, ""); gsub(/["'"'"']/, ""); print; exit
    }
  ' .cogni/repo-spec.yaml 2>/dev/null)"
fi

# operator is the apex (cognidao.org); its monorepo root repo-spec carries the
# slug `cogni-template`, the same apex node. Every other slug is its own hub.
case "$node_slug" in
  operator | cogni-template | "") URL="https://cognidao.org/api/v1/cognition" ;;
  *) URL="https://${node_slug}.cognidao.org/api/v1/cognition" ;;
esac

# Bearer = this node's NODE account key (environment first, then ./.env.cogni).
AGENT_KEY="${COGNI_NODE_API_KEY:-$(read_env_file_value COGNI_NODE_API_KEY)}"

# fetch_bundle → prints the .markdown bundle on stdout, or nothing on any failure.
fetch_bundle() {
  if [ -n "$AGENT_KEY" ]; then
    curl -fsS --max-time "$FETCH_TIMEOUT" -H "Authorization: Bearer ${AGENT_KEY}" "$URL" 2>/dev/null \
      | jq -r '.markdown // empty' 2>/dev/null
  else
    curl -fsS --max-time "$FETCH_TIMEOUT" "$URL" 2>/dev/null \
      | jq -r '.markdown // empty' 2>/dev/null
  fi
}

# write_cache_atomic <content> — replace the cache in one rename, never a torn file.
write_cache_atomic() {
  write_file_atomic "$CACHE_FILE" "$1"
  # Keep the clone root's copy current too, so a new worktree whose first fetch
  # fails (hub slow or down) still boots from the last complete bundle.
  if [ -n "$SHARED_CACHE" ] && bundle_is_complete "$1"; then
    write_file_atomic "$SHARED_CACHE" "$1"
  fi
}

write_file_atomic() {
  mkdir -p "$(dirname "$1")" 2>/dev/null || return 0
  tmp="${1}.tmp.$$"
  printf '%s\n' "$2" > "$tmp" 2>/dev/null && mv -f "$tmp" "$1" 2>/dev/null
  rm -f "$tmp" 2>/dev/null
}

# bundle_is_complete <text> — carries the agent-contract and its status-contract.
bundle_is_complete() {
  case "$1" in *"<agent-contract"*"<status-contract"*) return 0 ;; esac
  return 1
}

# SHARED_CACHE — the clone root's cache (the main checkout every worktree hangs
# off), or empty when this checkout is the clone root.
SHARED_CACHE=""
common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
# Only an ordinary clone whose common dir is <root>/.git and whose root is this
# node's checkout; never a bare repo, a submodule's modules dir, or a tracked file.
if [ -n "$common_dir" ] && [ "$(basename "$common_dir")" = ".git" ]; then
  clone_root="$(cd "$(dirname "$common_dir")" 2>/dev/null && pwd || true)"
  if [ -n "$clone_root" ] && [ "$clone_root" != "$(pwd)" ] \
    && [ -f "$clone_root/.cogni/repo-spec.yaml" ] \
    && ! git -C "$clone_root" ls-files --error-unmatch -- "$CACHE_FILE" >/dev/null 2>&1; then
    SHARED_CACHE="$clone_root/$CACHE_FILE"
  fi
fi

# cache_is_stale — true if the cache is missing or older than the refresh TTL.
cache_is_stale() {
  [ -f "$CACHE_FILE" ] || return 0
  [ -z "$(find "$CACHE_FILE" -mmin "-$((REFRESH_TTL_SECONDS / 60))" 2>/dev/null)" ]
}

# A cognition snapshot committed to git is not a cache: every new workspace
# would inherit whatever contract happened to be current at that commit, then
# present it before the async refresh. Treat tracked snapshots as absent so a
# fresh workspace fetches live cognition before its first agent reply.
cache_is_repo_tracked() {
  git ls-files --error-unmatch -- "$CACHE_FILE" >/dev/null 2>&1
}

# refresh_in_background — TTL-gated, fully detached, silent on failure. Its result
# lands in the cache for the NEXT session; it never blocks or writes to stdout.
refresh_in_background() {
  cache_is_stale || return 0
  (
    fresh="$(fetch_bundle)"
    [ -n "$fresh" ] && write_cache_atomic "$fresh"
  ) >/dev/null 2>&1 &
}

# PRESENTATION — local-first. If we have ever oriented, boot is offline-safe and
# a hub outage is invisible; we just refresh in the background for next time.
if [ -f "$CACHE_FILE" ] && [ -s "$CACHE_FILE" ] && ! cache_is_repo_tracked; then
  emit_agent_context "$(cat "$CACHE_FILE")"
  if cache_is_fresh_for_this_boot; then
    emit_claude_context "$(cat "$CACHE_FILE")"
  fi
  refresh_in_background
  exit 0
fi

# FIRST BOOT (no usable untracked cache): this is the only path allowed to touch
# the network in the foreground, and the only one that can surface a notice.
# Bounded fetch.
bundle="$(fetch_bundle)"
if [ -n "$bundle" ]; then
  write_cache_atomic "$bundle"
  emit_agent_context "$bundle"
  emit_claude_context "$bundle"
  exit 0
fi

# Fetch failed: boot from the clone root's last complete bundle when one exists,
# then refresh behind it. A hub outage must not cost a new worktree its contract.
if [ -n "$SHARED_CACHE" ] && [ -s "$SHARED_CACHE" ]; then
  shared="$(cat "$SHARED_CACHE")"
  if bundle_is_complete "$shared"; then
    write_file_atomic "$CACHE_FILE" "$shared"
    emit_agent_context "$shared"
    emit_claude_context "$shared"
    # Catch up behind it (the TTL gate would skip a cache written just now).
    (
      fresh="$(fetch_bundle)"
      [ -n "$fresh" ] && write_cache_atomic "$fresh"
    ) >/dev/null 2>&1 &
    exit 0
  fi
fi

# First boot AND fetch failed. Be honest, never cry wolf — separate a setup gap
# (no key) from a key-present failure, without a second network probe.
if [ -z "$AGENT_KEY" ]; then
  notice="$(cat <<EOF
COGNI COGNITION — no node credentials yet (first boot)

No COGNI_NODE_API_KEY was found, so this session could not load its cognition
bundle from:
  $URL

This is a setup step, not an outage. To bootstrap:
- register a NODE agent via /api/v1/agent/register
- save COGNI_NODE_API_KEY in the clone-root .env.cogni
- for Codex, review and trust the repo's SessionStart hook via /hooks

Then restart or resume the agent. (Once it loads once, it is cached locally and
survives hub outages.)
EOF
)"
else
  notice="$(cat <<EOF
COGNI COGNITION — could not load bundle (first boot, no cache)

A credential IS present, so this is NOT a missing-key setup problem. Either the
hub is down/slow, or the key lacks a principal on this hub (or the node has no
cognition published yet). There's no local cache to fall back on this first time.

Check hub health (cognidao.org/version) and that GET /api/v1/cognition resolves
with your key. Proceed with the repo's own AGENTS.md + skills meanwhile —
cognition caches itself once it loads, and then survives hub outages.
EOF
)"
fi
# Both harnesses see the notice: Codex on stdout, Claude through its structured
# channel (this boot's import found no cache either).
emit_agent_context "$notice"
emit_claude_context "$notice"
