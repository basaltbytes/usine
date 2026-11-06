#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec 3<&0
/bin/sh -c "$1" <&3 3<&- &
child=$!
exec 3<&-
if [ -n "$REPLAY_DROP" ]; then
  printf %s "$child" > "$REPLAY_DROP.pid"
fi
wait "$child"
code=$?
if [ -f "$REPLAY_DROP" ]; then
  rm -f "$REPLAY_DROP"
  exit 255
fi
exit "$code"
