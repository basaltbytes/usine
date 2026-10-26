#!/bin/sh
# The init process of a usine sandbox, under tini. When the platform restarts the host or replaces
# the instance, it sends SIGTERM and stops the container up to 15 minutes later, and a new
# container starts with an empty disk. This script records that time in the drain marker, which
# the Worker reports to usine, and keeps the container running until the platform stops it or
# usine destroys it, so that the Attempt can salvage its checkout first.
set -u
marker="$HOME/.usine/draining"
drain() {
  mkdir -p "$(dirname "$marker")"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$marker"
}
trap drain TERM
while :; do
  sleep 3600 &
  wait "$!" || true
done
