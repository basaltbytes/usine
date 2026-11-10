#!/bin/sh
# Installs the boxd CLI at BOXD_VERSION as BOXD_INSTALL_DIR/boxd (default
# /usr/local/bin), when the binary that boxd serves has the checksum of
# BOXD_SHA256_AMD64 or BOXD_SHA256_ARM64 and reports that version.
#
# When the download fails or either check fails, installs nothing, prints a
# warning that names the pinned version and the version that boxd serves, and
# exits 0. Exits 1 on an architecture without a boxd binary.
set -eu

version=${BOXD_VERSION:?}
install_dir=${BOXD_INSTALL_DIR:-/usr/local/bin}
downloads=https://boxd.sh/downloads/cli

arch=$(dpkg --print-architecture)
case "$arch" in
  amd64) sum=${BOXD_SHA256_AMD64:?} ;;
  arm64) sum=${BOXD_SHA256_ARM64:?} ;;
  *) echo "boxd has no Linux binary for $arch" >&2; exit 1 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

skip() {
  served=$(curl -fsSL "$downloads/latest-linux-$arch.json" 2>/dev/null | jq -r '.version // empty' 2>/dev/null) || served=
  echo "warning: boxd CLI not installed: $1. The image pins boxd $version; boxd serves ${served:-an unknown version}. Update BOXD_VERSION and both checksums in infra/worker-image/Dockerfile." >&2
  exit 0
}

curl -fsSL -o "$work/boxd" "$downloads/boxd-linux-$arch" || skip "the download failed"
echo "$sum  $work/boxd" | sha256sum -c --status - || skip "the checksum doesn't match"
chmod 0755 "$work/boxd"
reported=$(BOXD_TELEMETRY=0 "$work/boxd" --version) || skip "boxd --version failed"
[ "$reported" = "boxd $version" ] || skip "the binary reports \"$reported\""
install -m 0755 "$work/boxd" "$install_dir/boxd"
echo "boxd CLI $version installed as $install_dir/boxd"
