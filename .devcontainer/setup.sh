#!/usr/bin/env bash
# Post-create setup for the WaffleFinance dev container.
# Installs pnpm, Foundry, and stellar-cli, then wires up the workspace.
set -euo pipefail

echo "==> Installing pnpm 8.15.0"
npm install -g pnpm@8.15.0

echo "==> Installing Foundry"
curl -L https://foundry.paradigm.xyz | bash
# foundryup writes to ~/.foundry/bin — add to PATH for this shell
export PATH="$HOME/.foundry/bin:$PATH"
foundryup

echo "==> Installing stellar-cli"
cargo install --locked stellar-cli --features opt

echo "==> Adding wasm32-unknown-unknown target"
rustup target add wasm32-unknown-unknown

echo "==> Installing workspace dependencies"
pnpm install

echo "==> Building shared SDK"
pnpm --filter @wafflefinance/sdk build

if [ ! -f .env ]; then
  echo "==> Creating .env from env.example (fill in secrets before running services)"
  cp env.example .env
fi

echo ""
echo "Dev container ready. See docs/DEVELOPMENT.md for next steps."
