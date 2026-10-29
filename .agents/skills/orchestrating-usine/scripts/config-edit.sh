#!/usr/bin/env bash
# config-edit.sh KIND NAME [--file PATH] [--message TEXT]
# Reads the entity, lets you edit it (or takes --file), writes it back with the revision it was read at.
# KIND: loop | agent | worker | repository | label | settings (NAME instance)
. "$(dirname "$0")/lib.sh"
kind="${1:?kind}"; name="${2:?name}"; shift 2
file=""; message="edit $kind $name"
while [ $# -gt 0 ]; do
  case "$1" in
    --file) file="$2"; shift 2 ;;
    --message) message="$2"; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
usine_api GET "/api/configuration/entities/$kind/$name" > "$tmp/entity.json"
py -c '
import json, sys
e = json.load(open(sys.argv[1]))
open(sys.argv[2], "w").write(e["text"])
open(sys.argv[3], "w").write(str(e["number"]))' "$tmp/entity.json" "$tmp/text.md" "$tmp/rev"
rev=$(cat "$tmp/rev")
if [ -n "$file" ]; then
  cp "$file" "$tmp/text.md"
else
  "${EDITOR:-vi}" "$tmp/text.md"
fi
if cmp -s "$tmp/text.md" <(py -c 'import json,sys; sys.stdout.write(json.load(open(sys.argv[1]))["text"])' "$tmp/entity.json"); then
  echo "no change"; exit 0
fi
py -c '
import json, sys
print(json.dumps({"expected": int(sys.argv[1]), "message": sys.argv[2], "text": open(sys.argv[3]).read()}))' "$rev" "$message" "$tmp/text.md" > "$tmp/body.json"
usine_api PUT "/api/configuration/entities/$kind/$name" "$(cat "$tmp/body.json")"
echo
