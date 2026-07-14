#!/bin/sh
set -eu

version=2.0.0
archive_name="k6-v${version}-linux-amd64.tar.gz"
archive_sha256=2ae87d976f6cdba17185bdd980d8819a3a98e9092c6f0638cd58272ecefc8b90
archive_root="k6-v${version}-linux-amd64"
download_url="https://github.com/grafana/k6/releases/download/v${version}/${archive_name}"

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo 'Usage: scripts/install-k6.sh ABSOLUTE_DESTINATION_DIRECTORY' >&2
  exit 64
fi

destination=$1
case "$destination" in
  /*) ;;
  *) echo 'The k6 destination must be an absolute path.' >&2; exit 64 ;;
esac

parent=$(dirname "$destination")
if [ -e "$destination" ] || [ -L "$destination" ]; then
  echo 'The k6 destination must not already exist.' >&2
  exit 65
fi
if [ ! -d "$parent" ] || [ -L "$parent" ]; then
  echo 'The k6 destination parent must be an existing regular directory.' >&2
  exit 65
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/skyjo-k6.XXXXXX")
cleanup() {
  rm -rf -- "$work"
}
trap cleanup EXIT HUP INT TERM

archive="$work/$archive_name"
extract="$work/extract"
mkdir -m 0700 "$extract"

curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  "$download_url" --output "$archive"
printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --strict

manifest=$(tar --list --gzip --file "$archive")
expected_manifest=$(printf '%s\n%s\n' "$archive_root/" "$archive_root/k6")
if [ "$manifest" != "$expected_manifest" ]; then
  echo 'The pinned k6 archive contains an unexpected entry set.' >&2
  exit 66
fi

tar --extract --gzip --file "$archive" --directory "$extract" \
  --no-same-owner --no-same-permissions
binary="$extract/$archive_root/k6"
if [ ! -f "$binary" ] || [ -L "$binary" ] || [ "$(find "$extract" -type f | wc -l)" -ne 1 ]; then
  echo 'The extracted k6 binary failed the regular-file allowlist.' >&2
  exit 66
fi

mkdir -m 0700 -- "$destination"
if [ -L "$destination" ] || [ "$(find "$destination" -mindepth 1 -maxdepth 1 | wc -l)" -ne 0 ]; then
  echo 'The k6 destination failed its empty-directory allowlist.' >&2
  exit 65
fi
install -m 0555 "$binary" "$destination/k6"

installed_version=$($destination/k6 version)
case "$installed_version" in
  "k6 v${version} "*) ;;
  "k6 v${version}"*) ;;
  *) echo 'The installed executable did not report the pinned k6 version.' >&2; exit 67 ;;
esac

printf '%s\n' "$destination/k6"
