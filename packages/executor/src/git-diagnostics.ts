/** Copies HTTP transport diagnostics without changing Git's protocol output or exit status. */
export const HTTP_TRANSPORT = String.raw`#!/bin/sh
umask 077
helpers=$(dirname "$0")
original=$(cat "$helpers/original")
export GIT_EXEC_PATH="$original"
diagnostic="$GIT_TRACE2_EVENT.http/$GIT_TRACE2_PARENT_SID.stderr"
mkdir -p "$(dirname "$diagnostic")"
GIT_TRACE2_EVENT=0 git rev-parse --symbolic-full-name HEAD > "$diagnostic.head" 2>/dev/null
mkfifo "$diagnostic.pipe"
sed -E \
  -e 's#(https?://)[^/[:space:]]*@#\1[REDACTED]@#g' \
  -e 's/(gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/[REDACTED]/g' \
  < "$diagnostic.pipe" > "$diagnostic" &
scrubber=$!
{
  {
    "$original/$(basename "$0")" "$@" 2>&1 1>&3
    printf '%s' "$?" > "$diagnostic.status"
  } | tee "$diagnostic.pipe" >&2
} 3>&1
wait "$scrubber"
status=$(cat "$diagnostic.status")
rm -f "$diagnostic.status" "$diagnostic.pipe"
if [ "$status" = 0 ]; then rm -f "$diagnostic" "$diagnostic.head"; fi
exit "$status"
`;

export const INSTALL_GIT_DIAGNOSTICS = String.raw`
set -e
umask 077
original=$(git --exec-path)
helpers="$1.helpers"
mkdir -p "$helpers"
for helper in "$original"/*; do
  name=$(basename "$helper")
  case "$name" in git-remote-http|git-remote-https) continue ;; esac
  ln -sfn "$helper" "$helpers/$name"
done
printf '%s' "$original" > "$helpers/original"
for name in git-remote-http git-remote-https; do
  printf '%s' "$2" > "$helpers/$name"
  chmod 755 "$helpers/$name"
done
`.trim();
