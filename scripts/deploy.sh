#!/usr/bin/env bash
set -e

# Usage: ./scripts/deploy.sh production
MODE=${1:-production}
echo "Deploying in $MODE mode..."

# install deps, build
npm ci
npm run build

# reload/start pm2
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart ecosystem.config.js --env ${MODE} || pm2 start ecosystem.config.js --env ${MODE}
else
  echo "pm2 not found. Starting plain node (not recommended for production)."
  node dist/server.js &
fi

echo "Deploy complete."
