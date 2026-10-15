#!/usr/bin/env bash
# Restore test. Run on a TRUSTED machine (your own computer), NOT on the production box:
# it needs your PRIVATE key. Restores into a throwaway postgres:17 container and prints PASS/FAIL.
#
# Usage:
#   restore-test.sh --key <private-key-path> [--file <local dump>] [--expected <counts file>]
#                   [--bucket B --region R [--prefix P] [--profile NAME]]
# Counts file lines: "<table> <rowcount>" (taken read-only from the live DB).
# Without --expected, the counts are printed and PASS means the restore itself succeeded.
set -euo pipefail
umask 077

KEY="" FILE="" EXPECTED="" BUCKET="" REGION="" PREFIX="agenthydra-api" PROFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY=$2; shift 2 ;;
    --file) FILE=$2; shift 2 ;;
    --expected) EXPECTED=$2; shift 2 ;;
    --bucket) BUCKET=$2; shift 2 ;;
    --region) REGION=$2; shift 2 ;;
    --prefix) PREFIX=$2; shift 2 ;;
    --profile) PROFILE=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$KEY" ] || [ ! -r "$KEY" ]; then
  echo "--key <private key path> is required" >&2
  exit 2
fi

WORK=$(mktemp -d)
CNAME="agenthydra-restore-test-$$"
GNUPGTMP=""
cleanup() {
  docker rm -f "$CNAME" >/dev/null 2>&1 || true
  [ -z "$GNUPGTMP" ] || rm -rf "$GNUPGTMP"
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ -z "$FILE" ]; then
  if [ -z "$BUCKET" ] || [ -z "$REGION" ]; then
    echo "give --file, or --bucket and --region" >&2
    exit 2
  fi
  awsargs=(--region "$REGION")
  [ -z "$PROFILE" ] || awsargs+=(--profile "$PROFILE")
  newest=$(aws s3 ls "s3://$BUCKET/$PREFIX/" "${awsargs[@]}" | awk '{print $4}' | grep '^agenthydra-' | sort | tail -n 1)
  [ -n "$newest" ] || { echo "no objects found" >&2; exit 1; }
  echo "downloading $newest"
  aws s3 cp "s3://$BUCKET/$PREFIX/$newest" "$WORK/$newest" "${awsargs[@]}" --only-show-errors
  FILE="$WORK/$newest"
fi
echo "dump: $(basename "$FILE") bytes=$(stat -c %s "$FILE") sha256=$(sha256sum "$FILE" | cut -d' ' -f1)"

case "$FILE" in
  *.age) age -d -i "$KEY" "$FILE" >"$WORK/plain.dump" ;;
  *.gpg)
    GNUPGTMP=$(mktemp -d)
    chmod 700 "$GNUPGTMP"
    gpg --homedir "$GNUPGTMP" --batch --quiet --import "$KEY"
    gpg --homedir "$GNUPGTMP" --batch --quiet --decrypt "$FILE" >"$WORK/plain.dump"
    ;;
  *) echo "unknown extension (expected .age or .gpg)" >&2; exit 2 ;;
esac

docker run -d --name "$CNAME" -e POSTGRES_PASSWORD=throwaway postgres:17 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CNAME" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
sleep 2
docker exec "$CNAME" psql -U postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE agenthydra_restore_test' >/dev/null
docker cp "$WORK/plain.dump" "$CNAME:/tmp/restore.dump"
# Production roles do not exist here, so ownership and grants are skipped.
docker exec "$CNAME" pg_restore -U postgres -d agenthydra_restore_test --no-owner --no-privileges /tmp/restore.dump

psql_q() { docker exec "$CNAME" psql -U postgres -d agenthydra_restore_test -At -F ' ' -c "$1"; }
tables=$(psql_q "select schemaname||'.'||tablename from pg_tables where schemaname not in ('pg_catalog','information_schema') order by 1")
if [ -z "$tables" ]; then
  echo "FAIL: no tables restored"
  exit 1
fi
: >"$WORK/actual"
while read -r t; do
  n=$(psql_q "select count(*) from $t")
  echo "$t $n" | tee -a "$WORK/actual"
done <<<"$tables"

if [ -n "$EXPECTED" ]; then
  if diff <(sort "$EXPECTED") <(sort "$WORK/actual") >/dev/null; then
    echo "PASS: restored row counts match $EXPECTED"
  else
    echo "FAIL: row counts differ from $EXPECTED"
    diff <(sort "$EXPECTED") <(sort "$WORK/actual") || true
    exit 1
  fi
else
  echo "PASS: restore succeeded (no expected counts given; check the table above)"
fi
