#!/usr/bin/env bash
# Fresh-clone gauntlet: proves the README's claims from a cold start.
#
#   bash scripts/fresh-clone-gauntlet.sh [repo-url-or-path]
#
# Defaults to cloning THIS repo (the one the script runs from), so it can be
# pointed at the public repo after a snapshot: pass the URL as $1.
# Requires only git, Node >= 20 and pnpm >= 10, the same floor as the README.
set -euo pipefail

SRC="${1:-$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "gauntlet: cloning $SRC -> $WORK/warrant"

step() { echo; echo "── gauntlet step: $* ──"; }

step "clone"
git clone --quiet "$SRC" "$WORK/warrant"
cd "$WORK/warrant"

step "pnpm install"
pnpm install --frozen-lockfile

step "pnpm typecheck"
pnpm typecheck

step "pnpm demo (offline, no infra)"
pnpm demo
test -s packages/warrant-eve-outbound-demo/out/proof.md
echo "proof.md written and non-empty"

step "verify the production certificate"
pnpm --filter @idriszade/warrant-verify build
cd packages/warrant-eve-outbound-demo/ceremony
node ../../warrant-verify/dist/cli.js ledger.json \
  --verify-dsse certificate.dsse.json \
  --key "$(cat public-key.txt)"

echo
echo "gauntlet: ALL STEPS GREEN"
