#!/usr/bin/env bash
# build.sh — Bundle Trystero for the EchoForge browser mesh
# Run from packages/ruvon-echoforge/browser/

set -e
cd "$(dirname "$0")"

echo "→ Installing browser dependencies..."
npm install --silent

echo "→ Bundling Trystero (torrent strategy)..."
npx esbuild \
  node_modules/trystero/src/torrent.js \
  --bundle \
  --format=esm \
  --outfile=trystero-torrent.js \
  --minify \
  --define:process.env.NODE_ENV='"production"'

echo "✓ trystero-torrent.js ready ($(wc -c < trystero-torrent.js | tr -d ' ') bytes)"
