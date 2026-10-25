#!/bin/sh
# Copies the harness files that the executor mounts read-only under the seed
# directory into the home directory, where the harnesses can write them, then
# runs the container's command.
set -eu
seed=/usr/local/share/usine/seed
if [ -d "$seed" ]; then
  (
    cd "$seed"
    find . -type f | while IFS= read -r file; do
      mkdir -p "$HOME/$(dirname "$file")"
      cp "$file" "$HOME/$file"
    done
  )
fi
exec "$@"
