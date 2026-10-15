#!/usr/bin/env bash
# Writes a flag file when the disk is short or the people-pg volume is big, so the
# server answers 503 on writes. Clears it when back under. Never deletes anything.
set -euo pipefail

MIN_FREE_GB="${PEOPLE_MIN_FREE_GB:-15}"
MAX_PG_GB="${PEOPLE_MAX_PG_GB:-20}"
FLAG_DIR="${PEOPLE_FLAG_DIR:-/run/people}"
FLAG="$FLAG_DIR/write-block"
VOLUME="${PEOPLE_PG_VOLUME:-people-pg-data}"

free_gb=$(df -P --block-size=1G / | awk 'NR==2 {print $4}')
mount=$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME" 2>/dev/null || true)
pg_gb=0
if [ -n "$mount" ] && [ -d "$mount" ]; then
  pg_gb=$(du -s --block-size=1G "$mount" | awk '{print $1}')
fi

reason=""
if [ "$free_gb" -lt "$MIN_FREE_GB" ]; then
  reason="free space on / is ${free_gb} GB, under ${MIN_FREE_GB} GB"
elif [ "$pg_gb" -gt "$MAX_PG_GB" ]; then
  reason="volume ${VOLUME} is ${pg_gb} GB, over ${MAX_PG_GB} GB"
fi

mkdir -p "$FLAG_DIR"
chmod 0755 "$FLAG_DIR"
if [ -n "$reason" ]; then
  if [ ! -e "$FLAG" ]; then
    echo "writes blocked: $reason" | logger -p user.crit -t people-diskguard
  fi
  printf '%s\n' "$reason" > "$FLAG"
  chmod 0644 "$FLAG"
  state=yes
else
  if [ -e "$FLAG" ]; then
    echo "writes allowed again (free ${free_gb} GB, volume ${pg_gb} GB)" | logger -p user.notice -t people-diskguard
    rm -f -- "$FLAG"
  fi
  state=no
fi
echo "people-diskguard: free=${free_gb}GB volume=${pg_gb}GB blocked=${state}"
