#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

NODE_VERSION=24.18.0
NODE_SHA256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
TRANSPORT_KEY_FINGERPRINT=SHA256:hJWYngqSXdsSsEp+uA1M9NdP9Hty16UmxLDfRgbPeGc
NODE_ROOT=/opt/skyjo-online
APP_ROOT=/srv/skyjo-online
LIB_ROOT=/usr/local/lib/skyjo-online
BOOTSTRAP_STORE=$LIB_ROOT/bootstrap
BOOTSTRAP_WRAPPER=/usr/local/sbin/skyjo-delivery-bootstrap
SHARE_ROOT=/usr/local/share/skyjo-online
STAGED_UNIT=$SHARE_ROOT/skyjo-online.service
AUTH_ROOT=/etc/skyjo-deploy-auth
REPLAY_ROOT=/var/lib/skyjo-deploy-authorizations
ASSET_MANIFEST=$SHARE_ROOT/delivery-assets.sha256

die() { printf '%s\n' "$*" >&2; exit 1; }
require_root() { [ "$(/usr/bin/id -u)" -eq 0 ] || die 'Run this bootstrap as root.'; }
require_root

SCRIPT_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && /usr/bin/pwd -P)
BUNDLE_FILES='bootstrap-skyjo-delivery.sh
bootstrap-safety-lib.sh
bootstrap-generation-guard-lib.sh
activation-transaction-lib.sh
activation-unit-state-lib.sh
admission-lock.mjs
adoption-state-lib.sh
legacy-proof-environment-lib.sh
legacy-proof-unit-cleanup-lib.sh
node-runtime-installer.sh
node-runtime-guard-lib.sh
transport-key-lib.sh
skyjo-delivery-bootstrap
skyjo-controller-launch
release-controller.mjs
release-controller-lib.mjs
state-snapshot-lib.mjs
deployment-authorization-lib.mjs
skyjo-deploy-dispatch.mjs
validate-deployment-public-keys.mjs
legacy-runtime-proof.mjs
skyjo-canary-launch
skyjo-smoke-launch
skyjo-state-proof-launch
skyjo-release-controller
skyjo-online.service
skyjo-online-canary@.service
skyjo-online-canary-smoke@.service
skyjo-online-smoke@.service
skyjo-online-state-proof@.service
skyjo-online-legacy-proof@.service
skyjo-online-tmpfiles.conf
skyjo-deploy.sudoers'

initial_assert_root_directory() {
  directory=$1
  if [ -e "$directory" ] || [ -L "$directory" ]; then
    [ -d "$directory" ] && [ ! -L "$directory" ] || die "Unsafe bootstrap directory: $directory"
  else
    parent=$(/usr/bin/dirname -- "$directory")
    [ -d "$parent" ] && [ ! -L "$parent" ] || die "Unsafe bootstrap parent: $parent"
    [ "$(/usr/bin/stat -c %u -- "$parent")" = 0 ] && [ "$(/usr/bin/stat -c %g -- "$parent")" = 0 ] || die "Bootstrap parent is not root-owned: $parent"
    mode=$(/usr/bin/stat -c %a -- "$parent")
    [ $(((0$mode) & 0022)) -eq 0 ] || die "Bootstrap parent is writable: $parent"
    /usr/bin/mkdir -m 0755 -- "$directory"
  fi
  [ "$(/usr/bin/stat -c %u -- "$directory")" = 0 ] && [ "$(/usr/bin/stat -c %g -- "$directory")" = 0 ] || die "Bootstrap directory is not root-owned: $directory"
  mode=$(/usr/bin/stat -c %a -- "$directory")
  [ $(((0$mode) & 0022)) -eq 0 ] || die "Bootstrap directory is writable: $directory"
}

initial_assert_root_directory_chain() {
  current=$1
  case "$current" in /*) ;; *) die 'Bootstrap source directory must be absolute.' ;; esac
  while :; do
    [ -d "$current" ] && [ ! -L "$current" ] || die "Bootstrap source path component is unsafe: $current"
    [ "$(/usr/bin/stat -c %u -- "$current")" = 0 ] && [ "$(/usr/bin/stat -c %g -- "$current")" = 0 ] || \
      die "Bootstrap source path component is not root-owned: $current"
    mode=$(/usr/bin/stat -c %a -- "$current")
    [ $(((0$mode) & 0022)) -eq 0 ] || die "Bootstrap source path component is writable: $current"
    [ "$current" = / ] && break
    current=$(/usr/bin/dirname -- "$current")
  done
}

initial_assert_generation() {
  generation=$1
  [ -d "$generation" ] && [ ! -L "$generation" ] || die 'Bootstrap generation is not a real directory.'
  [ "$(/usr/bin/stat -c %u -- "$generation")" = 0 ] && [ "$(/usr/bin/stat -c %g -- "$generation")" = 0 ] || die 'Bootstrap generation is not root-owned.'
  [ "$(/usr/bin/stat -c %a -- "$generation")" = 700 ] || die 'Bootstrap generation mode is not 0700.'
  if /usr/bin/find "$generation" -xdev \( ! -user root -o ! -group root \) -print -quit | /usr/bin/grep -q .; then
    die 'Bootstrap generation contains a non-root-owned entry.'
  fi
  if /usr/bin/find "$generation" -xdev \( -type d -o -type f \) -perm /022 -print -quit | /usr/bin/grep -q .; then
    die 'Bootstrap generation contains a group/world-writable entry.'
  fi
  if /usr/bin/find "$generation" -xdev \( ! -type d ! -type f \) -print -quit | /usr/bin/grep -q .; then
    die 'Bootstrap generation contains a symbolic link or special entry.'
  fi
  (cd "$generation" && /usr/bin/sha256sum --check --strict bundle.sha256 >/dev/null) || die 'Bootstrap generation checksum failed.'
}

initial_copy_regular() {
  source=$1
  destination=$2
  mode=$3
  [ -f "$source" ] && [ ! -L "$source" ] || die "Bootstrap snapshot source is unsafe: $source"
  [ "$(/usr/bin/stat -c %u -- "$source")" = 0 ] && [ "$(/usr/bin/stat -c %g -- "$source")" = 0 ] || die "Bootstrap snapshot source is not root-owned: $source"
  source_mode=$(/usr/bin/stat -c %a -- "$source")
  [ $(((0$source_mode) & 0022)) -eq 0 ] || die "Bootstrap snapshot source is writable: $source"
  /usr/bin/cp --no-dereference --reflink=never -- "$source" "$destination"
  [ -f "$destination" ] && [ ! -L "$destination" ] || die "Bootstrap snapshot copy is unsafe: $destination"
  /usr/bin/chown root:root -- "$destination"
  /usr/bin/chmod "$mode" -- "$destination"
}

snapshot_and_exec_prepare() {
  [ "$#" -eq 3 ] || die 'Usage: bootstrap-skyjo-delivery.sh prepare <transport-public-key> <canary-authorization-public-pem> <production-authorization-public-pem>'
  transport=$1
  canary=$2
  production=$3
  initial_assert_root_directory_chain "$SCRIPT_DIR"
  for input in "$transport" "$canary" "$production"; do
    [ -f "$input" ] && [ ! -L "$input" ] || die "Bootstrap key input is unsafe: $input"
    [ "$(/usr/bin/stat -c %u -- "$input")" = 0 ] && [ "$(/usr/bin/stat -c %g -- "$input")" = 0 ] || die "Bootstrap key input is not root-owned: $input"
    input_mode=$(/usr/bin/stat -c %a -- "$input")
    [ $(((0$input_mode) & 0022)) -eq 0 ] || die "Bootstrap key input is writable: $input"
    bytes=$(/usr/bin/stat -c %s -- "$input")
    [ "$bytes" -ge 1 ] && [ "$bytes" -le 16384 ] || die "Bootstrap key input has an unsafe size: $input"
  done

  initial_assert_root_directory /usr/local
  initial_assert_root_directory /usr/local/lib
  initial_assert_root_directory "$LIB_ROOT"
  initial_assert_root_directory "$BOOTSTRAP_STORE"
  /usr/bin/chown root:root "$BOOTSTRAP_STORE"
  /usr/bin/chmod 0755 "$BOOTSTRAP_STORE"
  temporary=$(/usr/bin/mktemp -d "$BOOTSTRAP_STORE/.generation.XXXXXX")
  cleanup_snapshot() {
    case "$temporary" in "$BOOTSTRAP_STORE"/.generation.*) /usr/bin/rm -rf -- "$temporary" ;; *) return 1 ;; esac
  }
  trap cleanup_snapshot EXIT HUP INT TERM
  /usr/bin/mkdir -m 0700 "$temporary/inputs"
  for file in $BUNDLE_FILES; do
    case "$file" in bootstrap-skyjo-delivery.sh|skyjo-delivery-bootstrap) file_mode=0500 ;; *) file_mode=0400 ;; esac
    initial_copy_regular "$SCRIPT_DIR/$file" "$temporary/$file" "$file_mode"
  done
  initial_copy_regular "$transport" "$temporary/inputs/transport.pub" 0600
  initial_copy_regular "$canary" "$temporary/inputs/canary.pem" 0600
  initial_copy_regular "$production" "$temporary/inputs/production.pem" 0600
  (
    cd "$temporary"
    /usr/bin/find . -type f ! -name bundle.sha256 -print0 | LC_ALL=C /usr/bin/sort -z | /usr/bin/xargs -0 /usr/bin/sha256sum
  ) > "$temporary/bundle.sha256"
  /usr/bin/chown root:root "$temporary/bundle.sha256"
  /usr/bin/chmod 0400 "$temporary/bundle.sha256"
  digest=$(/usr/bin/sha256sum "$temporary/bundle.sha256" | /usr/bin/awk '{print $1}')
  target="$BOOTSTRAP_STORE/$digest"
  if [ -e "$target" ] || [ -L "$target" ]; then
    initial_assert_generation "$target"
    cleanup_snapshot
  else
    /usr/bin/chown -R root:root "$temporary"
    /usr/bin/chmod 0700 "$temporary" "$temporary/inputs"
    /usr/bin/mv -T "$temporary" "$target"
  fi
  trap - EXIT HUP INT TERM
  initial_assert_generation "$target"
  /usr/bin/sync -f "$BOOTSTRAP_STORE" 2>/dev/null || true
  exec "$target/bootstrap-skyjo-delivery.sh" prepare \
    "$target/inputs/transport.pub" "$target/inputs/canary.pem" "$target/inputs/production.pem"
}

case "$SCRIPT_DIR" in
  "$BOOTSTRAP_STORE"/*)
    generation_name=${SCRIPT_DIR##*/}
    printf '%s' "$generation_name" | /usr/bin/grep -Eq '^[a-f0-9]{64}$' || die 'Installed bootstrap generation name is invalid.'
    ;;
  *)
    [ "${1:-}" = prepare ] || die "Run delayed bootstrap actions through $BOOTSTRAP_WRAPPER."
    shift
    snapshot_and_exec_prepare "$@"
    ;;
esac

initial_assert_generation "$SCRIPT_DIR"
for helper in bootstrap-safety-lib.sh activation-transaction-lib.sh activation-unit-state-lib.sh adoption-state-lib.sh legacy-proof-environment-lib.sh legacy-proof-unit-cleanup-lib.sh node-runtime-installer.sh transport-key-lib.sh; do
  [ -f "$SCRIPT_DIR/$helper" ] && [ ! -L "$SCRIPT_DIR/$helper" ] && [ "$(/usr/bin/stat -c %u -- "$SCRIPT_DIR/$helper")" = 0 ] || \
    die "Installed bootstrap helper is unsafe: $helper"
done
. "$SCRIPT_DIR/bootstrap-safety-lib.sh"
. "$SCRIPT_DIR/activation-transaction-lib.sh"
. "$SCRIPT_DIR/activation-unit-state-lib.sh"
. "$SCRIPT_DIR/adoption-state-lib.sh"
. "$SCRIPT_DIR/legacy-proof-environment-lib.sh"
. "$SCRIPT_DIR/legacy-proof-unit-cleanup-lib.sh"
. "$SCRIPT_DIR/node-runtime-installer.sh"
. "$SCRIPT_DIR/transport-key-lib.sh"

valid_sha() { printf '%s' "$1" | /usr/bin/grep -Eq '^[a-f0-9]{40}$'; }

install_node() {
  [ "$(/usr/bin/uname -m)" = x86_64 ] || die 'The pinned runtime installer currently supports x86_64 only.'
  skyjo_secure_directory "$NODE_ROOT" root root 0755
  skyjo_assert_root_directory_chain "$NODE_ROOT"
  target="$NODE_ROOT/node-v$NODE_VERSION"
  if [ -e "$target" ] || [ -L "$target" ]; then
    skyjo_node_target_valid "$target" "$NODE_VERSION" "$NODE_SHA256" root:root || die 'Existing pinned Node runtime is incomplete or invalid.'
  else
    tmp=$(/usr/bin/mktemp -d /var/tmp/skyjo-node-download.XXXXXX)
    cleanup_node_download() {
      case "$tmp" in /var/tmp/skyjo-node-download.*) /usr/bin/rm -rf -- "$tmp" ;; *) die 'Refusing to clean an unexpected Node download path.' ;; esac
    }
    trap cleanup_node_download EXIT HUP INT TERM
    archive="$tmp/node.tar.xz"
    /usr/bin/curl --fail --silent --show-error --location \
      "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" --output "$archive"
    skyjo_install_node_archive \
      "$archive" "$NODE_SHA256" "$NODE_ROOT" "$target" \
      "node-v$NODE_VERSION-linux-x64" "$NODE_VERSION" root:root || die 'Pinned Node runtime installation failed.'
    cleanup_node_download
    trap - EXIT HUP INT TERM
  fi
  skyjo_node_target_valid "$target" "$NODE_VERSION" "$NODE_SHA256" root:root || die 'Pinned Node runtime validation failed.'
  skyjo_publish_node_symlink "$NODE_ROOT" "$NODE_VERSION" "$NODE_SHA256" root:root
  skyjo_node_target_valid "$target" "$NODE_VERSION" "$NODE_SHA256" root:root || die 'Pinned Node runtime changed during publication.'
}

install_asset() {
  source=$1
  destination=$2
  mode=$3
  skyjo_atomic_install "$source" "$destination" root root "$mode"
}

ensure_system_identity() {
  name=$1
  home=$2
  shell=$3
  if ! /usr/bin/getent group "$name" >/dev/null; then
    /usr/sbin/groupadd --system "$name" || die "Unable to create runtime group: $name"
  fi
  group_entry=$(/usr/bin/getent group "$name")
  IFS=: read -r group_name _ group_gid group_members <<EOF
$group_entry
EOF
  [ "$group_name" = "$name" ] && printf '%s' "$group_gid" | /usr/bin/grep -Eq '^[0-9]+$' || die "Runtime group is malformed: $name"
  [ "$group_gid" -gt 0 ] && [ "$group_gid" -lt 1000 ] || die "Runtime group is not an unprivileged system group: $name"
  [ -z "$group_members" ] || die "Runtime group has unexpected supplementary members: $name"

  if ! /usr/bin/id "$name" >/dev/null 2>&1; then
    /usr/sbin/useradd --system --no-create-home --gid "$name" --home-dir "$home" --shell "$shell" "$name" || \
      die "Unable to create runtime identity: $name"
  fi
  passwd_entry=$(/usr/bin/getent passwd "$name")
  IFS=: read -r account_name _ account_uid account_gid _ account_home account_shell <<EOF
$passwd_entry
EOF
  [ "$account_name" = "$name" ] && printf '%s' "$account_uid:$account_gid" | /usr/bin/grep -Eq '^[0-9]+:[0-9]+$' || die "Runtime identity is malformed: $name"
  [ "$account_uid" -gt 0 ] && [ "$account_uid" -lt 1000 ] || die "Runtime identity is not an unprivileged system user: $name"
  [ "$account_gid" = "$group_gid" ] || die "Runtime identity primary group is unexpected: $name"
  [ "$account_home" = "$home" ] && [ "$account_shell" = "$shell" ] || die "Runtime identity home or shell is incompatible: $name"
  [ "$(/usr/bin/id -G "$name")" = "$group_gid" ] || die "Runtime identity has unexpected supplementary groups: $name"
  primary_gid_alias=$(/usr/bin/getent passwd | /usr/bin/awk -F: -v owner="$name" -v gid="$group_gid" '$4 == gid && $1 != owner { print $1; exit }')
  [ -z "$primary_gid_alias" ] || die "Runtime private group is shared by another primary identity: $name"
  /usr/sbin/usermod --lock "$name" || die "Unable to lock runtime identity: $name"
  password_state=$(/usr/bin/passwd --status "$name" | /usr/bin/awk '{print $2}')
  case "$password_state" in L|LK) ;; *) die "Runtime identity password is not locked: $name" ;; esac
}

prepare_identities() {
  ensure_system_identity skyjo /var/lib/skyjo-online /usr/sbin/nologin
  ensure_system_identity skyjo-canary /var/empty/skyjo-canary /usr/sbin/nologin
  ensure_system_identity skyjo-deploy /var/lib/skyjo-deploy /bin/sh
  skyjo_uid=$(/usr/bin/id -u skyjo)
  canary_uid=$(/usr/bin/id -u skyjo-canary)
  deploy_uid=$(/usr/bin/id -u skyjo-deploy)
  [ "$skyjo_uid" != "$canary_uid" ] && [ "$skyjo_uid" != "$deploy_uid" ] && [ "$canary_uid" != "$deploy_uid" ] || \
    die 'Runtime identities must have distinct user IDs.'
  skyjo_gid=$(/usr/bin/id -g skyjo)
  canary_gid=$(/usr/bin/id -g skyjo-canary)
  deploy_gid=$(/usr/bin/id -g skyjo-deploy)
  [ "$skyjo_gid" != "$canary_gid" ] && [ "$skyjo_gid" != "$deploy_gid" ] && [ "$canary_gid" != "$deploy_gid" ] || \
    die 'Runtime identities must have distinct primary group IDs.'
}

validate_admission_lock_parent() {
  for directory in / /var /var/lib /var/lib/skyjo-deploy; do
    [ -d "$directory" ] && [ ! -L "$directory" ] || die "Deployment admission lock trust path is unsafe: $directory"
    [ "$(/usr/bin/stat -c %u:%g:%a -- "$directory")" = 0:0:755 ] || \
      die "Deployment admission lock trust path contract is invalid: $directory"
  done
}

validate_admission_lock() {
  lock=/var/lib/skyjo-deploy/.admission.lock
  validate_admission_lock_parent
  [ -f "$lock" ] && [ ! -L "$lock" ] || die 'Deployment admission lock is not a regular file.'
  deploy_gid=$(/usr/bin/id -g skyjo-deploy)
  [ "$(/usr/bin/stat -c %u:%g:%a:%h:%s -- "$lock")" = "0:$deploy_gid:640:1:0" ] || \
    die 'Deployment admission lock does not match its immutable file contract.'
}

ensure_admission_lock() {
  lock=/var/lib/skyjo-deploy/.admission.lock
  validate_admission_lock_parent
  if [ -e "$lock" ] || [ -L "$lock" ]; then
    [ -f "$lock" ] && [ ! -L "$lock" ] || die 'Existing deployment admission lock is unsafe.'
    deploy_gid=$(/usr/bin/id -g skyjo-deploy)
    lock_state=$(/usr/bin/stat -c %u:%g:%a:%h:%s -- "$lock")
    case "$lock_state" in
      "0:$deploy_gid:640:1:0") ;;
      0:0:640:1:0) /usr/bin/chown root:skyjo-deploy "$lock" ;;
      *) die 'Existing deployment admission lock is neither complete nor a resumable root-owned intermediate.' ;;
    esac
  else
    (umask 0137; set -C; : > "$lock") || die 'Unable to create the deployment admission lock.'
    [ "$(/usr/bin/stat -c %u:%g:%a:%h:%s -- "$lock")" = 0:0:640:1:0 ] || \
      die 'New deployment admission lock did not match its root-owned intermediate contract.'
    /usr/bin/chown root:skyjo-deploy "$lock"
  fi
  /usr/bin/chmod 0640 "$lock"
  /usr/bin/sync -f "$lock"
  /usr/bin/sync -f /var/lib/skyjo-deploy
  validate_admission_lock
}

acquire_admission_lock() {
  validate_admission_lock
  exec 7</var/lib/skyjo-deploy/.admission.lock
  /usr/bin/flock --exclusive --nonblock --conflict-exit-code 75 7 || die 'Another deployment admission is active.'
  validate_admission_lock
}

validate_stage_root() {
  filesystem=$(/usr/bin/findmnt --noheadings --output FSTYPE --target /var/tmp/skyjo-deploy | /usr/bin/tr -d '[:space:]')
  [ "$filesystem" = ext4 ] || die 'Deployment staging requires ext4 link-count admission semantics.'
  if /usr/bin/find /var/tmp/skyjo-deploy -mindepth 1 -maxdepth 1 ! -type d -print -quit | /usr/bin/grep -q .; then
    die 'Deployment staging root contains an unexpected file or symbolic link.'
  fi
  if /usr/bin/find /var/tmp/skyjo-deploy -mindepth 1 -maxdepth 1 -printf '%f\0' | \
      /usr/bin/grep -zEqv '^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-(canary|production)$'; then
    die 'Deployment staging root contains an unexpected run directory name.'
  fi
  run_count=$(/usr/bin/find /var/tmp/skyjo-deploy -mindepth 1 -maxdepth 1 -type d -printf . | /usr/bin/wc -c | /usr/bin/tr -d '[:space:]')
  [ "$run_count" -le 32 ] || die 'Deployment staging root exceeds the admitted run quota.'
  expected_links=$((run_count + 2))
  [ "$(/usr/bin/stat -c %h /var/tmp/skyjo-deploy)" -eq "$expected_links" ] || die 'Deployment staging link count does not match admitted run directories.'
  deploy_uid=$(/usr/bin/id -u skyjo-deploy)
  deploy_gid=$(/usr/bin/id -g skyjo-deploy)
  /usr/bin/find /var/tmp/skyjo-deploy -mindepth 1 -maxdepth 1 -type d -exec /bin/sh -eu -c '
    expected_uid=$1
    expected_gid=$2
    shift 2
    for directory do
      name=${directory##*/}
      stage_uid=$(/usr/bin/stat -c %u "$directory")
      stage_gid=$(/usr/bin/stat -c %g "$directory")
      stage_mode=$(/usr/bin/stat -c %a "$directory")
      uploader_stage=false
      root_stage=false
      [ "$stage_uid:$stage_gid:$stage_mode" = "$expected_uid:$expected_gid:700" ] && uploader_stage=true
      { [ "$stage_uid:$stage_gid:$stage_mode" = 0:0:700 ] || [ "$stage_uid:$stage_gid:$stage_mode" = 0:0:711 ]; } && root_stage=true
      [ "$uploader_stage" = true ] || [ "$root_stage" = true ]
      marker="$directory/.quota-admitted"
      [ -f "$marker" ] && [ ! -L "$marker" ]
      [ "$(/usr/bin/stat -c %a "$marker")" = 400 ]
      marker_owner="$(/usr/bin/stat -c %u:%g "$marker")"
      [ "$marker_owner" = "$expected_uid:$expected_gid" ] || [ "$marker_owner" = 0:0 ]
      [ "$(/usr/bin/cat "$marker")" = "$name" ]
      [ "$(/usr/bin/tail -c 1 "$marker" | /usr/bin/od -An -tx1 | /usr/bin/tr -d "[:space:]")" = 0a ]
      [ "$(/usr/bin/wc -c < "$marker" | /usr/bin/tr -d "[:space:]")" -eq "$((${#name} + 1))" ]
      archive_count=0
      for archive in "$directory"/skyjo-runtime-*.tar.gz; do
        [ -e "$archive" ] || [ -L "$archive" ] || continue
        archive_count=$((archive_count + 1))
        archive_name=${archive##*/}
        printf "%s" "$archive_name" | /usr/bin/grep -Eq "^skyjo-runtime-[a-f0-9]{40}\\.tar\\.gz$"
        [ -f "$archive" ] && [ ! -L "$archive" ]
        archive_owner="$(/usr/bin/stat -c %u:%g "$archive")"
        archive_mode=$(/usr/bin/stat -c %a "$archive")
        { [ "$archive_owner:$archive_mode" = "$expected_uid:$expected_gid:600" ] || \
          [ "$archive_owner:$archive_mode" = 0:0:600 ] || [ "$archive_owner:$archive_mode" = 0:0:400 ]; }
      done
      [ "$archive_count" -eq 1 ]
    done
  ' stage-validation "$deploy_uid" "$deploy_gid" {} + || die 'Deployment staging run claim state is invalid.'
}

prepare() {
  public_key=${1:-}
  canary_authorization_key=${2:-}
  production_authorization_key=${3:-}
  [ "$#" -eq 3 ] || die 'Installed prepare requires the three immutable key snapshots.'
  [ "$public_key" = "$SCRIPT_DIR/inputs/transport.pub" ] && \
    [ "$canary_authorization_key" = "$SCRIPT_DIR/inputs/canary.pem" ] && \
    [ "$production_authorization_key" = "$SCRIPT_DIR/inputs/production.pem" ] || die 'Prepare key inputs must be the installed immutable snapshots.'
  exec 8>/run/lock/skyjo-release-controller.lock
  /usr/bin/flock --exclusive --nonblock --conflict-exit-code 73 8 || die 'Another Skyjo release or adoption transaction holds the host lock.'
  key=$(skyjo_canonical_transport_public_key "$public_key" "$TRANSPORT_KEY_FINGERPRINT") || die 'Deploy transport public-key validation failed.'

  install_node
  "$NODE_ROOT/node-v$NODE_VERSION/bin/node" "$SCRIPT_DIR/validate-deployment-public-keys.mjs" \
    "$canary_authorization_key" "$production_authorization_key" >/dev/null

  prepare_identities

  for unit in \
    skyjo-online.service \
    skyjo-online-canary@.service \
    skyjo-online-canary-smoke@.service \
    skyjo-online-smoke@.service \
    skyjo-online-state-proof@.service \
    skyjo-online-legacy-proof@.service; do
    dropin="/etc/systemd/system/$unit.d"
    if [ -e "$dropin" ] || [ -L "$dropin" ]; then
      die "Unexpected systemd drop-in directory must be removed before preparation: $unit.d"
    fi
  done

  skyjo_secure_directory "$APP_ROOT" root root 0755
  skyjo_secure_directory "$APP_ROOT/releases" root root 0755
  skyjo_secure_directory "$LIB_ROOT" root root 0755
  skyjo_secure_directory "$SHARE_ROOT" root root 0755
  if [ -e /var/lib/skyjo-online ] || [ -L /var/lib/skyjo-online ]; then
    [ -d /var/lib/skyjo-online ] && [ ! -L /var/lib/skyjo-online ] || die 'Existing production state directory is unsafe.'
    state_mode=$(/usr/bin/stat -c %a /var/lib/skyjo-online)
    [ $(((0$state_mode) & 0022)) -eq 0 ] || die 'Existing production state directory is writable by group or others.'
  else
    skyjo_secure_directory /var/lib/skyjo-online root root 0700
  fi
  skyjo_secure_directory /var/backups/skyjo-online root root 0700
  skyjo_secure_directory /var/lib/skyjo-deploy root root 0755
  ensure_admission_lock
  acquire_admission_lock
  skyjo_secure_directory /var/tmp/skyjo-deploy root skyjo-deploy 1731 true
  validate_stage_root
  skyjo_secure_directory "$REPLAY_ROOT" root root 0700
  skyjo_secure_directory "$AUTH_ROOT" root root 0700
  skyjo_secure_directory /var/lib/skyjo-deploy/.ssh root root 0755

  skyjo_atomic_install "$canary_authorization_key" "$AUTH_ROOT/canary-2026-07.pem" root root 0600
  skyjo_atomic_install "$production_authorization_key" "$AUTH_ROOT/production-2026-07.pem" root root 0600
  /usr/bin/cmp -s "$canary_authorization_key" "$AUTH_ROOT/canary-2026-07.pem" || die 'Installed canary key differs from its immutable snapshot.'
  /usr/bin/cmp -s "$production_authorization_key" "$AUTH_ROOT/production-2026-07.pem" || die 'Installed production key differs from its immutable snapshot.'

  for file in admission-lock.mjs release-controller.mjs release-controller-lib.mjs state-snapshot-lib.mjs deployment-authorization-lib.mjs skyjo-deploy-dispatch.mjs validate-deployment-public-keys.mjs legacy-runtime-proof.mjs node-runtime-guard-lib.sh bootstrap-generation-guard-lib.sh; do
    install_asset "$SCRIPT_DIR/$file" "$LIB_ROOT/$file" 0555
  done
  for file in skyjo-canary-launch skyjo-smoke-launch skyjo-state-proof-launch skyjo-controller-launch; do
    install_asset "$SCRIPT_DIR/$file" "$LIB_ROOT/$file" 0555
  done
  install_asset "$SCRIPT_DIR/skyjo-release-controller" /usr/local/sbin/skyjo-release-controller 0555

  /usr/sbin/visudo -cf "$SCRIPT_DIR/skyjo-deploy.sudoers" >/dev/null || die 'Immutable sudoers source failed preflight.'
  /usr/bin/systemd-analyze verify \
    "$SCRIPT_DIR/skyjo-online-canary@.service" \
    "$SCRIPT_DIR/skyjo-online-canary-smoke@.service" \
    "$SCRIPT_DIR/skyjo-online-smoke@.service" \
    "$SCRIPT_DIR/skyjo-online-state-proof@.service" \
    "$SCRIPT_DIR/skyjo-online-legacy-proof@.service" \
    "$SCRIPT_DIR/skyjo-online.service" >/dev/null || die 'Immutable systemd unit sources failed preflight.'

  install_asset "$SCRIPT_DIR/skyjo-online-tmpfiles.conf" /etc/tmpfiles.d/skyjo-online.conf 0444
  /usr/bin/systemd-tmpfiles --create /etc/tmpfiles.d/skyjo-online.conf
  install_asset "$SCRIPT_DIR/skyjo-online.service" "$STAGED_UNIT" 0444
  install_asset "$SCRIPT_DIR/skyjo-online-canary@.service" /etc/systemd/system/skyjo-online-canary@.service 0444
  install_asset "$SCRIPT_DIR/skyjo-online-canary-smoke@.service" /etc/systemd/system/skyjo-online-canary-smoke@.service 0444
  install_asset "$SCRIPT_DIR/skyjo-online-smoke@.service" /etc/systemd/system/skyjo-online-smoke@.service 0444
  install_asset "$SCRIPT_DIR/skyjo-online-state-proof@.service" /etc/systemd/system/skyjo-online-state-proof@.service 0444
  install_asset "$SCRIPT_DIR/skyjo-online-legacy-proof@.service" /etc/systemd/system/skyjo-online-legacy-proof@.service 0444
  install_asset "$SCRIPT_DIR/skyjo-deploy.sudoers" /etc/sudoers.d/skyjo-deploy 0440
  /usr/sbin/visudo -cf /etc/sudoers.d/skyjo-deploy >/dev/null
  /usr/bin/systemd-analyze verify \
    /etc/systemd/system/skyjo-online-canary@.service \
    /etc/systemd/system/skyjo-online-canary-smoke@.service \
    /etc/systemd/system/skyjo-online-smoke@.service \
    /etc/systemd/system/skyjo-online-state-proof@.service \
    /etc/systemd/system/skyjo-online-legacy-proof@.service \
    "$STAGED_UNIT" >/dev/null

  options='restrict,no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding,command="/opt/skyjo-online/node/bin/node /usr/local/lib/skyjo-online/skyjo-deploy-dispatch.mjs"'
  authorized_keys=$(printf '%s %s\n' "$options" "$key")
  skyjo_atomic_write_text /var/lib/skyjo-deploy/.ssh/authorized_keys root root 0644 "$authorized_keys
"

  manifest_source=$(/usr/bin/mktemp "$SHARE_ROOT/.delivery-assets.XXXXXX")
  /usr/bin/rm -f "$manifest_source"
  for asset in \
    "$LIB_ROOT/admission-lock.mjs" \
    "$LIB_ROOT/release-controller.mjs" \
    "$LIB_ROOT/release-controller-lib.mjs" \
    "$LIB_ROOT/state-snapshot-lib.mjs" \
    "$LIB_ROOT/deployment-authorization-lib.mjs" \
    "$LIB_ROOT/skyjo-deploy-dispatch.mjs" \
    "$LIB_ROOT/validate-deployment-public-keys.mjs" \
    "$LIB_ROOT/legacy-runtime-proof.mjs" \
    "$LIB_ROOT/node-runtime-guard-lib.sh" \
    "$LIB_ROOT/bootstrap-generation-guard-lib.sh" \
    "$LIB_ROOT/skyjo-canary-launch" \
    "$LIB_ROOT/skyjo-smoke-launch" \
    "$LIB_ROOT/skyjo-state-proof-launch" \
    "$LIB_ROOT/skyjo-controller-launch" \
    /usr/local/sbin/skyjo-release-controller \
    "$STAGED_UNIT" \
    /etc/systemd/system/skyjo-online-canary@.service \
    /etc/systemd/system/skyjo-online-canary-smoke@.service \
    /etc/systemd/system/skyjo-online-smoke@.service \
    /etc/systemd/system/skyjo-online-state-proof@.service \
    /etc/systemd/system/skyjo-online-legacy-proof@.service \
    /etc/tmpfiles.d/skyjo-online.conf \
    /etc/sudoers.d/skyjo-deploy \
    "$AUTH_ROOT/canary-2026-07.pem" \
    "$AUTH_ROOT/production-2026-07.pem" \
    "$SCRIPT_DIR/bundle.sha256" \
    "$SCRIPT_DIR/inputs/transport.pub" \
    "$SCRIPT_DIR/inputs/canary.pem" \
    "$SCRIPT_DIR/inputs/production.pem"; do
    /usr/bin/sha256sum "$asset" >> "$manifest_source"
  done
  wrapper_sha=$(/usr/bin/sha256sum "$SCRIPT_DIR/skyjo-delivery-bootstrap" | /usr/bin/awk '{print $1}')
  printf '%s  %s\n' "$wrapper_sha" "$BOOTSTRAP_WRAPPER" >> "$manifest_source"
  for asset in $BUNDLE_FILES; do /usr/bin/sha256sum "$SCRIPT_DIR/$asset" >> "$manifest_source"; done
  skyjo_atomic_install "$manifest_source" "$ASSET_MANIFEST" root root 0444
  /usr/bin/rm -f "$manifest_source"

  if [ -e /etc/skyjo-online.env ] || [ -L /etc/skyjo-online.env ]; then
    skyjo_assert_regular_destination /etc/skyjo-online.env
    [ "$(/usr/bin/stat -c %u /etc/skyjo-online.env)" = 0 ] || die 'Production environment is not root-owned.'
    /usr/bin/chown root:root /etc/skyjo-online.env
    /usr/bin/chmod 0600 /etc/skyjo-online.env
    env_checksum=$(/usr/bin/sha256sum /etc/skyjo-online.env | /usr/bin/awk '{print $1}')
    [ "$(/usr/bin/sha256sum /etc/skyjo-online.env | /usr/bin/awk '{print $1}')" = "$env_checksum" ] || die 'Production environment content changed during preparation.'
  else
    skyjo_atomic_write_text /etc/skyjo-online.env root root 0600 ''
    printf '%s\n' 'Created empty /etc/skyjo-online.env; populate required secrets before verification.' >&2
  fi
  /usr/bin/systemctl daemon-reload
  skyjo_atomic_install "$SCRIPT_DIR/skyjo-delivery-bootstrap" "$BOOTSTRAP_WRAPPER" root root 0555
  generation=${SCRIPT_DIR##*/}
  printf '%s' "$generation" | /usr/bin/grep -Eq '^[a-f0-9]{64}$' || die 'Prepared bootstrap generation name is invalid.'
  skyjo_publish_relative_symlink "$BOOTSTRAP_STORE/current" "$generation"
  printf '%s\n' 'Prepared Skyjo delivery assets. The live production unit was not replaced or restarted.'
}

adopt_legacy() {
  sha=${1:-}
  valid_sha "$sha" || die 'Usage: skyjo-delivery-bootstrap adopt-legacy <40-char-current-sha>'
  exec 8>/run/lock/skyjo-release-controller.lock
  /usr/bin/flock --exclusive --nonblock --conflict-exit-code 73 8 || die 'Another Skyjo release or adoption transaction holds the host lock.'
  acquire_admission_lock
  target="$APP_ROOT/releases/$sha"
  skyjo_secure_directory /var/backups/skyjo-online/bootstrap root root 0700
  live_unit=/etc/systemd/system/skyjo-online.service
  backup_unit=/var/backups/skyjo-online/bootstrap/legacy-skyjo-online.service
  backup_checksum="$backup_unit.sha256"
  skyjo_prepare_unit_backup "$live_unit" "$backup_unit" "$backup_checksum" root root || die 'Unable to prepare and verify the original production unit backup.'

  skyjo_cleanup_legacy_staging "$APP_ROOT/releases" "$sha" 0 0 4 || die 'Legacy staging cleanup found an unsafe or unbounded partial state.'
  if [ -e "$target" ] || [ -L "$target" ]; then
    skyjo_validate_legacy_release "$target" "$sha" root root || die 'Existing legacy release target does not match the requested immutable anchor.'
  else
    [ -f "$APP_ROOT/server.mjs" ] && [ ! -L "$APP_ROOT/server.mjs" ] && [ -d "$APP_ROOT/dist" ] && [ ! -L "$APP_ROOT/dist" ] && [ -d "$APP_ROOT/node_modules" ] && [ ! -L "$APP_ROOT/node_modules" ] || die 'Legacy runtime tree is incomplete or unsafe.'
    if [ -d "$APP_ROOT/.git" ] && [ ! -L "$APP_ROOT/.git" ]; then
      actual=$(/usr/bin/git -C "$APP_ROOT" rev-parse HEAD)
      [ "$actual" = "$sha" ] || die 'Legacy checkout HEAD does not match requested SHA.'
    fi
    tmp="$APP_ROOT/releases/.legacy-$sha-$$"
    [ ! -e "$tmp" ] && [ ! -L "$tmp" ] || die 'Legacy staging destination already exists.'
    /usr/bin/mkdir -m 0700 "$tmp"
    for item in dist server-dist scripts package.json package-lock.json server.mjs server-account-store.mjs server-room-persistence.mjs server-persistence-health.mjs server-readiness.mjs server-release.mjs server-state-backup.mjs; do
      [ ! -e "$APP_ROOT/$item" ] || /usr/bin/cp -a "$APP_ROOT/$item" "$tmp/$item"
    done
    (cd "$tmp" && "$NODE_ROOT/node-v$NODE_VERSION/bin/node" "$NODE_ROOT/node-v$NODE_VERSION/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --ignore-scripts --no-audit --no-fund)
    /usr/bin/rm -rf "$tmp/node_modules/.bin"
    if /usr/bin/find "$tmp" -type l -print -quit | /usr/bin/grep -q .; then
      /usr/bin/rm -rf "$tmp"
      die 'Legacy rollback snapshot contains a symbolic link.'
    fi
    "$NODE_ROOT/node-v$NODE_VERSION/bin/node" --check "$tmp/server.mjs"
    printf '%s\n' "$sha" > "$tmp/.skyjo-legacy"
    printf '{"releaseSha":"%s","legacy":true}\n' "$sha" > "$tmp/.skyjo-deployment.json"
    (cd "$tmp" && /usr/bin/find . -type f ! -name .skyjo-legacy-manifest.sha256 -print0 | LC_ALL=C /usr/bin/sort -z | /usr/bin/xargs -0 /usr/bin/sha256sum) > "$tmp/.skyjo-legacy-manifest.sha256"
    /usr/bin/chown -R root:root "$tmp"
    /usr/bin/chmod -R u=rwX,go=rX "$tmp"
    skyjo_validate_legacy_release "$tmp" "$sha" root root || die 'Prepared legacy release target failed immutable validation.'
    /usr/bin/mv -T "$tmp" "$target"
    /usr/bin/sync -f "$target" 2>/dev/null || true
    /usr/bin/sync -f "$APP_ROOT/releases" 2>/dev/null || true
    skyjo_validate_legacy_release "$target" "$sha" root root || die 'Published legacy release target failed immutable validation.'
  fi
  skyjo_ensure_legacy_link "$APP_ROOT/current" "releases/$sha" 0 0 || die 'Current legacy anchor is ambiguous or unsafe.'
  skyjo_ensure_legacy_link "$APP_ROOT/previous" "releases/$sha" 0 0 || die 'Previous legacy anchor is ambiguous or unsafe.'
  printf '%s\n' "Adopted immutable legacy rollback anchor $sha without restarting production."
}

run_legacy_proof() {
  release=$1
  release_sha=$(/usr/bin/basename "$release")
  valid_sha "$release_sha" || return 1
  instance=bootstrap-activation
  env_path="/run/skyjo-online-canary/$instance.env"
  env_content=$(printf '%s\n' \
    "SKYJO_LEGACY_RELEASE_DIR=$release" \
    "SKYJO_EXPECTED_RELEASE_SHA=$release_sha" \
    'SKYJO_SMOKE_BASE_URL=http://127.0.0.1:4180')
  skyjo_publish_legacy_proof_environment "$env_path" root skyjo "$env_content
" || return 1
  unit="skyjo-online-legacy-proof@$instance.service"
  if /usr/bin/systemctl start "$unit"; then proof_status=0; else proof_status=$?; fi
  skyjo_finalize_bootstrap_legacy_proof "$proof_status" "$unit" "$env_path" \
    /usr/bin/systemctl skyjo_remove_legacy_proof_environment
}

activate_unit() {
  [ "${SYSTEMD_EXEC_PID:-}" = "$$" ] || \
    die 'activate-production-unit must run as the direct main process of the documented systemd transient service.'
  acquire_admission_lock
  [ -L "$APP_ROOT/current" ] || die 'A validated current rollback anchor is required before activating the hardened unit.'
  target=$(/usr/bin/readlink -f "$APP_ROOT/current")
  case "$target" in "$APP_ROOT/releases/"*) ;; *) die 'Current link is outside the release store.';; esac
  [ -L "$APP_ROOT/previous" ] || die 'A validated previous rollback anchor is required before activating the hardened unit.'
  previous_target=$(/usr/bin/readlink -f "$APP_ROOT/previous")
  [ "$previous_target" = "$target" ] || die 'Initial current and previous anchors must identify the same immutable legacy release.'
  [ -f "$target/.skyjo-legacy" ] || [ -f "$target/release.json" ] || die 'Current release anchor is not validated.'
  if [ -f "$target/.skyjo-legacy" ]; then
    (cd "$target" && /usr/bin/sha256sum --check --strict .skyjo-legacy-manifest.sha256 >/dev/null) || die 'Legacy rollback checksum manifest is invalid.'
  fi
  old_unit=/var/backups/skyjo-online/bootstrap/legacy-skyjo-online.service
  [ -f "$old_unit" ] && [ ! -L "$old_unit" ] || die 'The original production unit backup is missing or unsafe.'
  old_unit_checksum="$old_unit.sha256"
  [ -f "$old_unit_checksum" ] && [ ! -L "$old_unit_checksum" ] || die 'The original production unit checksum is missing or unsafe.'
  /usr/bin/sha256sum --check --strict "$old_unit_checksum" >/dev/null || die 'The original production unit backup checksum failed.'
  skyjo_assert_regular_destination /etc/systemd/system/skyjo-online.service
  activation_mode=$(skyjo_classify_activation_unit /etc/systemd/system/skyjo-online.service "$old_unit" "$STAGED_UNIT") || \
    die 'Live production unit matches neither the verified legacy backup nor the validated staged hardened unit.'
  state=/var/lib/skyjo-online
  [ -d "$state" ] && [ ! -L "$state" ] || die 'Production state directory is unsafe.'
  if /usr/bin/find "$state" -mindepth 1 \( -type l -o \( ! -type f ! -type d \) \) -print -quit | /usr/bin/grep -q .; then
    die 'Production state contains a symlink or special file.'
  fi
  for file in rooms.json skyjo.sqlite skyjo.sqlite-wal skyjo.sqlite-shm; do
    [ ! -e "$state/$file" ] || { [ -f "$state/$file" ] && [ ! -L "$state/$file" ]; } || die "Unsafe production state file: $file"
  done

  activation_stop() { /usr/bin/systemctl stop skyjo-online.service || return 1; }
  activation_prepare_state() {
    /usr/bin/chown -R skyjo:skyjo "$state" || return 1
    /usr/bin/chmod 0700 "$state" || return 1
    for file in rooms.json skyjo.sqlite skyjo.sqlite-wal skyjo.sqlite-shm; do
      [ ! -e "$state/$file" ] || /usr/bin/chmod 0600 "$state/$file" || return 1
    done
  }
  activation_install_unit() { skyjo_atomic_install "$STAGED_UNIT" /etc/systemd/system/skyjo-online.service root root 0444 || return 1; }
  activation_reload() { /usr/bin/systemctl daemon-reload || return 1; }
  activation_start() { /usr/bin/systemctl start skyjo-online.service || return 1; }
  activation_health() {
    count=0
    while [ "$count" -lt 60 ]; do
      if /usr/bin/curl --fail --silent --show-error http://127.0.0.1:4180/healthz | /usr/bin/grep -qx ok; then return 0; fi
      count=$((count + 1))
      /usr/bin/sleep 0.25 || return 1
    done
    return 1
  }
  activation_proof() { run_legacy_proof "$target" || return 1; }
  activation_recover() {
    /usr/bin/systemctl stop skyjo-online.service >/dev/null 2>&1 || return 1
    /usr/bin/sha256sum --check --strict "$old_unit_checksum" >/dev/null || return 1
    skyjo_atomic_install "$old_unit" /etc/systemd/system/skyjo-online.service root root 0644 || return 1
    /usr/bin/systemctl daemon-reload || return 1
    /usr/bin/systemctl start skyjo-online.service || return 1
    run_legacy_proof "$target" || return 1
  }

  if [ "$activation_mode" = legacy ]; then
    activation_steps='activation_stop activation_prepare_state activation_install_unit activation_reload activation_start activation_health activation_proof'
    success_message='Activated and health-verified the hardened unit against the immutable legacy rollback anchor.'
  else
    activation_steps='activation_stop activation_prepare_state activation_reload activation_start activation_health activation_proof'
    success_message='Resumed and fully reverified the interrupted hardened-unit activation.'
  fi
  if skyjo_run_activation_transaction activation_recover $activation_steps; then
    printf '%s\n' "$success_message"
    return 0
  else
    activation_status=$?
    if [ "$activation_status" -eq 125 ]; then
      die 'Hardened unit cutover failed and the original unit could not be fully restored and reverified.'
    else
      die 'Hardened unit cutover failed; the original unit was restored and reverified.'
    fi
  fi
}

case "${1:-}" in
  prepare) shift; prepare "$@" ;;
  adopt-legacy) shift; [ "$#" -eq 1 ] || die 'adopt-legacy takes one SHA'; adopt_legacy "$@" ;;
  activate-production-unit) shift; [ "$#" -eq 0 ] || die 'activate-production-unit takes no arguments'; activate_unit ;;
  *) die 'Usage: skyjo-delivery-bootstrap {prepare <snapshots>|adopt-legacy <sha>|activate-production-unit}' ;;
esac
