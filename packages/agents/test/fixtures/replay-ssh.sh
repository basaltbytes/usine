#!/bin/sh
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
/bin/sh -c "$1"
code=$?
if [ -f "$REPLAY_DROP" ]; then
  rm -f "$REPLAY_DROP"
  exit 255
fi
exit "$code"
