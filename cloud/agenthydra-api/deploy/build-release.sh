#!/usr/bin/env bash
# Usage: build-release.sh [out-dir]   (run from anywhere; needs bun)
# Builds agenthydra-api.js, migrate.js and people-export.js plus migrations/ and deploy/
# into a tarball laid out for agenthydra-api-deploy.sh. Prints the tarball path and sha256.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$here/dist}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$out"
cd "$here"
bun build src/server.ts --target=bun --outfile "$stage/agenthydra-api.js" >&2
bun build src/migrate.ts --target=bun --outfile "$stage/migrate.js" >&2
bun build src/modules/people/export.ts --target=bun --outfile "$stage/people-export.js" >&2
cp -r migrations "$stage/migrations"
mkdir "$stage/deploy"
cp deploy/*.sh "$stage/deploy/"
chmod 755 "$stage"/deploy/*.sh
ver=$(date -u +%Y%m%d%H%M%S)
tarball="$out/agenthydra-api-$ver.tar.gz"
tar -czf "$tarball" -C "$stage" .
echo "$tarball"
sha256sum "$tarball" | awk '{print $1}'
