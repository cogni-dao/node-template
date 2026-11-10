#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/agent/install-git-hooks.sh
# Purpose: Point git at the repo-owned hooks so every clone and worktree enforces
#   them (commit-msg strips agent attribution trailers). Idempotent; never fails a
#   non-git context (e.g. a tarball build) so it is safe as an npm "prepare" step.
# Wiring: root package.json "prepare" and scripts/conductor-worktree-setup.sh.

set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$root" ]] || exit 0

git -C "$root" config core.hooksPath scripts/agent/git-hooks
chmod +x "$root/scripts/agent/git-hooks/"* 2>/dev/null || true
