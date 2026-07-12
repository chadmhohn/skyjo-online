#!/usr/bin/env bash
set -Eeuo pipefail

if [ ! -x /usr/bin/flock ]; then
  printf '%s\n' 'Atomic Node concurrency and interruption regressions require Linux flock and are exercised in Linux CI.'
  exit 0
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=../bootstrap-safety-lib.sh
. "$script_dir/bootstrap-safety-lib.sh"
# shellcheck source=../node-runtime-installer.sh
. "$script_dir/node-runtime-installer.sh"

tmp=$(mktemp -d)
cleanup() {
  case "$tmp" in /tmp/*|/var/tmp/*) rm -rf -- "$tmp" ;; *) exit 1 ;; esac
}
trap cleanup EXIT

version=24.18.0
archive_root="node-v$version-linux-x64"

make_payload() {
  destination=$1
  root_name=$2
  complete=$3
  mkdir -p "$destination/$root_name/bin" "$destination/$root_name/lib/node_modules/npm/bin"
  cat > "$destination/$root_name/bin/node" <<EOF
#!/bin/sh
[ "\${1:-}" = --version ] && printf '%s\n' v$version
EOF
  chmod 0755 "$destination/$root_name/bin/node"
  if [ "$complete" = true ]; then
    printf '%s\n' '// pinned npm cli fixture' > "$destination/$root_name/lib/node_modules/npm/bin/npm-cli.js"
  fi
}

make_archive() {
  source_root=$1
  root_name=$2
  archive=$3
  tar --create --xz --file "$archive" --directory "$source_root" "$root_name"
  sha256sum "$archive" | awk '{print $1}'
}

assert_no_staging() {
  node_root=$1
  if find "$node_root" -maxdepth 1 -name '.node-v*.install.*' -print -quit | grep -q .; then
    printf '%s\n' 'Node installer left a partial staging directory.' >&2
    exit 1
  fi
}

wrong_payload="$tmp/wrong-payload"
wrong_root="node-v$version"
make_payload "$wrong_payload" "$wrong_root" true
wrong_archive="$tmp/wrong-root.tar.xz"
wrong_digest=$(make_archive "$wrong_payload" "$wrong_root" "$wrong_archive")
wrong_node_root="$tmp/wrong-node-root"
mkdir "$wrong_node_root"
if skyjo_install_node_archive "$wrong_archive" "$wrong_digest" "$wrong_node_root" \
  "$wrong_node_root/node-v$version" "$archive_root" "$version" -; then
  printf '%s\n' 'Installer accepted an archive whose root omitted the platform suffix.' >&2
  exit 1
fi
[ ! -e "$wrong_node_root/node-v$version" ]
assert_no_staging "$wrong_node_root"

incomplete_payload="$tmp/incomplete-payload"
make_payload "$incomplete_payload" "$archive_root" false
incomplete_archive="$tmp/incomplete.tar.xz"
incomplete_digest=$(make_archive "$incomplete_payload" "$archive_root" "$incomplete_archive")
incomplete_node_root="$tmp/incomplete-node-root"
mkdir "$incomplete_node_root"
if skyjo_install_node_archive "$incomplete_archive" "$incomplete_digest" "$incomplete_node_root" \
  "$incomplete_node_root/node-v$version" "$archive_root" "$version" -; then
  printf '%s\n' 'Installer published an incomplete extracted runtime.' >&2
  exit 1
fi
[ ! -e "$incomplete_node_root/node-v$version" ]
assert_no_staging "$incomplete_node_root"

valid_payload="$tmp/valid-payload"
make_payload "$valid_payload" "$archive_root" true
valid_archive="$tmp/valid.tar.xz"
valid_digest=$(make_archive "$valid_payload" "$archive_root" "$valid_archive")
node_root="$tmp/node-root"
target="$node_root/node-v$version"
mkdir "$node_root"
PATH="$tmp/poisoned-path" skyjo_install_node_archive "$valid_archive" "$valid_digest" "$node_root" "$target" "$archive_root" "$version" -
skyjo_node_target_valid "$target" "$version" "$valid_digest" -
[ "$(cat "$target/.skyjo-node-runtime")" = "$(skyjo_node_marker "$version" "$valid_digest")" ]
printf '%s\n' preserve-me > "$target/idempotency-marker"
skyjo_install_node_archive "$tmp/does-not-exist.tar.xz" "$valid_digest" \
  "$node_root" "$target" "$archive_root" "$version" -
[ "$(cat "$target/idempotency-marker")" = preserve-me ]
assert_no_staging "$node_root"

partial_root="$tmp/preexisting-partial-root"
partial_target="$partial_root/node-v$version"
mkdir -p "$partial_target/bin" "$partial_target/lib/node_modules/npm/bin"
printf '#!/bin/sh\nprintf "v%s\\n"\n' "$version" > "$partial_target/bin/node"
chmod 0755 "$partial_target/bin/node"
printf '%s\n' fake > "$partial_target/lib/node_modules/npm/bin/npm-cli.js"
skyjo_node_marker "$version" "$(printf '0%.0s' {1..64})" > "$partial_target/.skyjo-node-runtime"
if skyjo_install_node_archive "$valid_archive" "$valid_digest" "$partial_root" "$partial_target" "$archive_root" "$version" -; then
  printf '%s\n' 'Installer trusted a fake pre-existing Node tree without the pinned marker.' >&2
  exit 1
fi
[ "$(cat "$partial_target/lib/node_modules/npm/bin/npm-cli.js")" = fake ]
assert_no_staging "$partial_root"

unsafe_actual="$tmp/unsafe-actual"
mkdir "$unsafe_actual"
ln -s "$unsafe_actual" "$tmp/unsafe-root"
if skyjo_install_node_archive "$valid_archive" "$valid_digest" "$tmp/unsafe-root" \
  "$tmp/unsafe-root/node-v$version" "$archive_root" "$version" -; then
  printf '%s\n' 'Installer accepted a symlinked Node root.' >&2
  exit 1
fi

interrupt_root="$tmp/interrupted-root"
interrupt_ready="$tmp/interrupted.ready"
mkdir "$interrupt_root"
(
  export SKYJO_NODE_INSTALL_TEST_READY_FILE="$interrupt_ready"
  export SKYJO_NODE_INSTALL_TEST_PAUSE_SECONDS=30
  skyjo_install_node_archive "$valid_archive" "$valid_digest" "$interrupt_root" \
    "$interrupt_root/node-v$version" "$archive_root" "$version" -
) &
interrupt_pid=$!
for _ in {1..200}; do [ -e "$interrupt_ready" ] && break; sleep 0.01; done
[ -e "$interrupt_ready" ] || { printf '%s\n' 'Interrupted-install test never reached staging.' >&2; exit 1; }
kill -TERM "$interrupt_pid"
if wait "$interrupt_pid"; then
  printf '%s\n' 'Interrupted Node installation unexpectedly succeeded.' >&2
  exit 1
fi
[ ! -e "$interrupt_root/node-v$version" ]
assert_no_staging "$interrupt_root"

concurrent_root="$tmp/concurrent-root"
mkdir "$concurrent_root"
skyjo_install_node_archive "$valid_archive" "$valid_digest" "$concurrent_root" \
  "$concurrent_root/node-v$version" "$archive_root" "$version" - &
first=$!
skyjo_install_node_archive "$valid_archive" "$valid_digest" "$concurrent_root" \
  "$concurrent_root/node-v$version" "$archive_root" "$version" - &
second=$!
wait "$first"
wait "$second"
skyjo_node_target_valid "$concurrent_root/node-v$version" "$version" "$valid_digest" -
assert_no_staging "$concurrent_root"

skyjo_publish_node_symlink "$concurrent_root" "$version" "$valid_digest" - &
first=$!
skyjo_publish_node_symlink "$concurrent_root" "$version" "$valid_digest" - &
second=$!
wait "$first"
wait "$second"
[ -L "$concurrent_root/node" ]
[ "$(readlink "$concurrent_root/node")" = "node-v$version" ]

victim_root="$tmp/victim-root"
mkdir "$victim_root"
cp -a "$concurrent_root/node-v$version" "$victim_root/node-v$version"
printf '%s\n' untouched > "$tmp/victim"
ln -s "$tmp/victim" "$victim_root/node"
if skyjo_publish_node_symlink "$victim_root" "$version" "$valid_digest" -; then
  printf '%s\n' 'Node symlink publication accepted an unexpected destination symlink.' >&2
  exit 1
fi
[ "$(cat "$tmp/victim")" = untouched ]

printf '%s\n' 'node runtime installer adversarial regression passed'
