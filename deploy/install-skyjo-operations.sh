#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

LIB_ROOT=/usr/local/lib/skyjo-online
UNIT_ROOT=/etc/systemd/system
MARKER=/etc/skyjo-online-operations.enabled
MANIFEST=/usr/local/share/skyjo-online/operations-assets.sha256
ASSET_ROOT=/usr/local/share/skyjo-online/operations
RELEASE_LOCK=/run/lock/skyjo-release-controller.lock
TMPFILES_CONFIG=/etc/tmpfiles.d/skyjo-online-operations.conf
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

die() { printf '%s\n' "$*" >&2; exit 1; }
require_root() { [ "$(id -u)" -eq 0 ] || die 'Run the operations installer as root.'; }
safe_asset() {
  [ -f "$1" ] && [ ! -L "$1" ] || die "Missing or unsafe operations asset: $1"
  [ "$(/usr/bin/stat -c %u:%h "$1")" = 0:1 ] || die "Operations asset is not a sole root-owned file: $1"
  permissions=$(/usr/bin/stat -c %A "$1")
  case "$permissions" in ?????w*|????????w*) die "Operations asset is writable outside root: $1" ;; esac
}
reject_link() { [ ! -L "$1" ] || die "Refusing a linked operations target: $1"; }
safe_file_target() {
  reject_link "$1"
  [ ! -e "$1" ] || { [ -f "$1" ] && [ "$(/usr/bin/stat -c %u:%h "$1")" = 0:1 ]; } || \
    die "Refusing a non-root-owned or hardlinked operations target: $1"
  if [ -e "$1" ]; then
    target_permissions=$(/usr/bin/stat -c %A "$1")
    case "$target_permissions" in ?????w*|????????w*) die "Refusing an operations target writable outside root: $1" ;; esac
  fi
}
safe_installed_asset() {
  safe_asset "$1"
  [ "$(/usr/bin/stat -c %u:%g:%a:%h "$1")" = "0:0:$2:1" ] || \
    die "Installed operations asset ownership or mode drifted: $1"
}
operations_asset_paths() {
  printf '%s\n' \
    "$ASSET_ROOT/install-skyjo-operations.sh" \
    "$ASSET_ROOT/validate-operations-readiness.mjs" \
    "$ASSET_ROOT/skyjo-ops-launch" \
    "$ASSET_ROOT/skyjo-online-operations.tmpfiles" \
    "$ASSET_ROOT/skyjo-backup-daily.service" "$ASSET_ROOT/skyjo-backup-daily.timer" \
    "$ASSET_ROOT/skyjo-backup-monthly.service" "$ASSET_ROOT/skyjo-backup-monthly.timer" \
    "$ASSET_ROOT/skyjo-readiness-monitor.service" "$ASSET_ROOT/skyjo-readiness-monitor.timer" \
    "$LIB_ROOT/skyjo-ops-launch" \
    "$TMPFILES_CONFIG" \
    "$UNIT_ROOT/skyjo-backup-daily.service" "$UNIT_ROOT/skyjo-backup-daily.timer" \
    "$UNIT_ROOT/skyjo-backup-monthly.service" "$UNIT_ROOT/skyjo-backup-monthly.timer" \
    "$UNIT_ROOT/skyjo-readiness-monitor.service" "$UNIT_ROOT/skyjo-readiness-monitor.timer"
}
inactive_enablement_state() {
  unit=$1
  state=$2
  result=$3
  case "$unit:$state:$result" in
    *.service:static:0|*.service:not-found:4|*.timer:disabled:1|*.timer:not-found:4) return 0 ;;
    *) return 1 ;;
  esac
}

assert_install_inactive() {
  [ ! -e "$MARKER" ] && [ ! -L "$MARKER" ] || die 'Refusing to install while operations are activated.'
  for unit in \
    skyjo-readiness-monitor.service skyjo-readiness-monitor.timer \
    skyjo-backup-daily.service skyjo-backup-daily.timer \
    skyjo-backup-monthly.service skyjo-backup-monthly.timer; do
    if /usr/bin/systemctl is-active --quiet "$unit"; then
      die "Refusing to replace an active operations unit: $unit"
    else
      result=$?
      [ "$result" -eq 3 ] || [ "$result" -eq 4 ] || die "Could not prove operations unit inactive: $unit"
    fi
    set +e
    enabled_state=$(/usr/bin/systemctl is-enabled "$unit" 2>/dev/null)
    result=$?
    set -e
    if inactive_enablement_state "$unit" "$enabled_state" "$result"; then
      :
    else
      case "$enabled_state" in
      enabled|enabled-runtime|linked|linked-runtime|alias)
        die "Refusing to replace an enabled operations unit: $unit"
        ;;
      *) die "Could not prove operations unit disabled: $unit" ;;
      esac
    fi
  done
}

verify_installed_assets() {
  [ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] && \
    [ "$(/usr/bin/stat -c %u:%g:%a:%h "$MANIFEST")" = 0:0:444:1 ] || \
    die 'The operations asset manifest is missing or unsafe.'
  expected_count=$(operations_asset_paths | /usr/bin/wc -l)
  actual_count=$(/usr/bin/wc -l < "$MANIFEST")
  [ "$actual_count" -eq "$expected_count" ] || die 'The operations asset manifest has an unexpected entry count.'
  /usr/bin/sha256sum --strict --check "$MANIFEST" >/dev/null || die 'Installed operations asset checksums did not verify.'
  for asset in \
    "$ASSET_ROOT/install-skyjo-operations.sh" \
    "$ASSET_ROOT/validate-operations-readiness.mjs" \
    "$ASSET_ROOT/skyjo-ops-launch" \
    "$LIB_ROOT/skyjo-ops-launch"; do
    safe_installed_asset "$asset" 555
  done
  for asset in \
    "$ASSET_ROOT/skyjo-online-operations.tmpfiles" \
    "$TMPFILES_CONFIG" \
    "$ASSET_ROOT/skyjo-backup-daily.service" "$ASSET_ROOT/skyjo-backup-daily.timer" \
    "$ASSET_ROOT/skyjo-backup-monthly.service" "$ASSET_ROOT/skyjo-backup-monthly.timer" \
    "$ASSET_ROOT/skyjo-readiness-monitor.service" "$ASSET_ROOT/skyjo-readiness-monitor.timer" \
    "$UNIT_ROOT/skyjo-backup-daily.service" "$UNIT_ROOT/skyjo-backup-daily.timer" \
    "$UNIT_ROOT/skyjo-backup-monthly.service" "$UNIT_ROOT/skyjo-backup-monthly.timer" \
    "$UNIT_ROOT/skyjo-readiness-monitor.service" "$UNIT_ROOT/skyjo-readiness-monitor.timer"; do
    safe_installed_asset "$asset" 444
  done
  operations_asset_paths | while IFS= read -r asset; do
    expected_line=$(/usr/bin/sha256sum "$asset")
    /usr/bin/grep -Fqx -- "$expected_line" "$MANIFEST" || die "Operations manifest does not bind the expected asset: $asset"
  done
  [ -f "$RELEASE_LOCK" ] && [ ! -L "$RELEASE_LOCK" ] && \
    [ "$(/usr/bin/stat -c %u:%g:%a:%h "$RELEASE_LOCK")" = 0:0:600:1 ] || \
    die 'The shared release lock is missing or unsafe.'
}

prepare_release_lock() {
  safe_file_target "$RELEASE_LOCK"
  if [ ! -e "$RELEASE_LOCK" ]; then
    /usr/bin/install -o root -g root -m 0600 /dev/null "$RELEASE_LOCK"
  else
    /usr/bin/chown root:root "$RELEASE_LOCK"
    /usr/bin/chmod 0600 "$RELEASE_LOCK"
  fi
  release_lock_identity=$(/usr/bin/stat -c %d:%i "$RELEASE_LOCK")
  exec 8>"$RELEASE_LOCK"
  /usr/bin/flock --exclusive --wait 300 8 || die 'Timed out waiting for the shared release lock.'
}

validate_monitor_user() {
  if /usr/bin/id skyjo-monitor >/dev/null 2>&1; then
    entry=$(/usr/bin/getent passwd skyjo-monitor)
    [ -n "$entry" ] || die 'Existing skyjo-monitor account is invalid.'
    home=$(printf '%s' "$entry" | /usr/bin/cut -d: -f6)
    shell=$(printf '%s' "$entry" | /usr/bin/cut -d: -f7)
    [ "$home" = /var/lib/skyjo-monitor ] && [ "$shell" = /usr/sbin/nologin ] || die 'Existing skyjo-monitor account does not match the operations contract.'
  else
    /usr/sbin/useradd --system --user-group --home-dir /var/lib/skyjo-monitor --shell /usr/sbin/nologin skyjo-monitor
  fi
  [ "$(/usr/bin/id -gn skyjo-monitor)" = skyjo-monitor ] && [ "$(/usr/bin/id -Gn skyjo-monitor)" = skyjo-monitor ] || \
    die 'skyjo-monitor must have one dedicated group and no supplemental groups.'
  if /usr/bin/id skyjo >/dev/null 2>&1; then
    [ "$(/usr/bin/id -u skyjo-monitor)" != "$(/usr/bin/id -u skyjo)" ] && [ "$(/usr/bin/id -g skyjo-monitor)" != "$(/usr/bin/id -g skyjo)" ] || \
      die 'skyjo-monitor identity must be distinct from the application identity.'
  fi
}

install_assets() {
  [ -d "$SCRIPT_DIR" ] && [ ! -L "$SCRIPT_DIR" ] && [ "$(/usr/bin/stat -c %u "$SCRIPT_DIR")" -eq 0 ] || \
    die 'Operations assets must be staged in a root-owned real directory.'
  source_permissions=$(/usr/bin/stat -c %A "$SCRIPT_DIR")
  case "$source_permissions" in ?????w*|????????w*) die 'Operations asset directory is writable outside root.' ;; esac
  assert_install_inactive
  for asset in \
    install-skyjo-operations.sh \
    validate-operations-readiness.mjs \
    skyjo-ops-launch \
    skyjo-online-operations.tmpfiles \
    skyjo-backup-daily.service skyjo-backup-daily.timer \
    skyjo-backup-monthly.service skyjo-backup-monthly.timer \
    skyjo-readiness-monitor.service skyjo-readiness-monitor.timer; do
    safe_asset "$SCRIPT_DIR/$asset"
  done
  prepare_release_lock
  validate_monitor_user
  for directory in "$LIB_ROOT" /usr/local/share/skyjo-online "$ASSET_ROOT"; do
    reject_link "$directory"
  done
  /usr/bin/install -d -o root -g root -m 0755 "$LIB_ROOT" /usr/local/share/skyjo-online "$ASSET_ROOT"
  if [ "$SCRIPT_DIR" != "$ASSET_ROOT" ]; then
    for target in \
      "$ASSET_ROOT/install-skyjo-operations.sh" "$ASSET_ROOT/skyjo-ops-launch" \
      "$ASSET_ROOT/validate-operations-readiness.mjs" \
      "$ASSET_ROOT/skyjo-online-operations.tmpfiles" \
      "$ASSET_ROOT/skyjo-backup-daily.service" "$ASSET_ROOT/skyjo-backup-daily.timer" \
      "$ASSET_ROOT/skyjo-backup-monthly.service" "$ASSET_ROOT/skyjo-backup-monthly.timer" \
      "$ASSET_ROOT/skyjo-readiness-monitor.service" "$ASSET_ROOT/skyjo-readiness-monitor.timer"; do
      safe_file_target "$target"
    done
    /usr/bin/install -o root -g root -m 0555 "$SCRIPT_DIR/install-skyjo-operations.sh" "$ASSET_ROOT/install-skyjo-operations.sh"
    /usr/bin/install -o root -g root -m 0555 "$SCRIPT_DIR/validate-operations-readiness.mjs" "$ASSET_ROOT/validate-operations-readiness.mjs"
    /usr/bin/install -o root -g root -m 0555 "$SCRIPT_DIR/skyjo-ops-launch" "$ASSET_ROOT/skyjo-ops-launch"
    /usr/bin/install -o root -g root -m 0444 "$SCRIPT_DIR/skyjo-online-operations.tmpfiles" "$ASSET_ROOT/skyjo-online-operations.tmpfiles"
    for asset in \
      skyjo-backup-daily.service skyjo-backup-daily.timer \
      skyjo-backup-monthly.service skyjo-backup-monthly.timer \
      skyjo-readiness-monitor.service skyjo-readiness-monitor.timer; do
      /usr/bin/install -o root -g root -m 0444 "$SCRIPT_DIR/$asset" "$ASSET_ROOT/$asset"
    done
  fi
  for directory in \
    /var/lib/skyjo-monitor \
    /var/backups/skyjo-online \
    /var/backups/skyjo-online/scheduled \
    /var/backups/skyjo-online/scheduled/daily \
    /var/backups/skyjo-online/scheduled/monthly \
    /var/backups/skyjo-online/scheduled/drills \
    /var/tmp/skyjo-restore-drills; do
    reject_link "$directory"
  done
  /usr/bin/install -d -o skyjo-monitor -g skyjo-monitor -m 0700 /var/lib/skyjo-monitor
  /usr/bin/install -d -o root -g root -m 0700 \
    /var/backups/skyjo-online \
    /var/backups/skyjo-online/scheduled \
    /var/backups/skyjo-online/scheduled/daily \
    /var/backups/skyjo-online/scheduled/monthly \
    /var/backups/skyjo-online/scheduled/drills \
    /var/tmp/skyjo-restore-drills
  safe_file_target "$TMPFILES_CONFIG"
  /usr/bin/install -o root -g root -m 0444 "$ASSET_ROOT/skyjo-online-operations.tmpfiles" "$TMPFILES_CONFIG"
  /usr/bin/systemd-tmpfiles --create "$TMPFILES_CONFIG"
  [ "$(/usr/bin/stat -c %u:%g:%a:%h "$RELEASE_LOCK")" = 0:0:600:1 ] || die 'The shared release lock was not recreated safely.'
  [ "$(/usr/bin/stat -c %d:%i "$RELEASE_LOCK")" = "$release_lock_identity" ] || die 'The shared release lock identity changed during installation.'
  safe_file_target "$LIB_ROOT/skyjo-ops-launch"
  /usr/bin/install -o root -g root -m 0555 "$ASSET_ROOT/skyjo-ops-launch" "$LIB_ROOT/skyjo-ops-launch"
  for asset in \
    skyjo-backup-daily.service skyjo-backup-daily.timer \
    skyjo-backup-monthly.service skyjo-backup-monthly.timer \
      skyjo-readiness-monitor.service skyjo-readiness-monitor.timer; do
    safe_file_target "$UNIT_ROOT/$asset"
    /usr/bin/install -o root -g root -m 0444 "$ASSET_ROOT/$asset" "$UNIT_ROOT/$asset"
  done
  /usr/bin/systemd-analyze verify \
    "$UNIT_ROOT/skyjo-backup-daily.service" "$UNIT_ROOT/skyjo-backup-daily.timer" \
    "$UNIT_ROOT/skyjo-backup-monthly.service" "$UNIT_ROOT/skyjo-backup-monthly.timer" \
    "$UNIT_ROOT/skyjo-readiness-monitor.service" "$UNIT_ROOT/skyjo-readiness-monitor.timer" >/dev/null
  safe_file_target "$MANIFEST"
  /usr/bin/rm -f "$MANIFEST"
  /usr/bin/install -o root -g root -m 0600 /dev/null "$MANIFEST"
  for asset in \
    "$ASSET_ROOT/install-skyjo-operations.sh" \
    "$ASSET_ROOT/validate-operations-readiness.mjs" \
    "$ASSET_ROOT/skyjo-ops-launch" \
    "$ASSET_ROOT/skyjo-online-operations.tmpfiles" \
    "$ASSET_ROOT/skyjo-backup-daily.service" "$ASSET_ROOT/skyjo-backup-daily.timer" \
    "$ASSET_ROOT/skyjo-backup-monthly.service" "$ASSET_ROOT/skyjo-backup-monthly.timer" \
    "$ASSET_ROOT/skyjo-readiness-monitor.service" "$ASSET_ROOT/skyjo-readiness-monitor.timer" \
    "$LIB_ROOT/skyjo-ops-launch" \
    "$TMPFILES_CONFIG" \
    "$UNIT_ROOT/skyjo-backup-daily.service" "$UNIT_ROOT/skyjo-backup-daily.timer" \
    "$UNIT_ROOT/skyjo-backup-monthly.service" "$UNIT_ROOT/skyjo-backup-monthly.timer" \
    "$UNIT_ROOT/skyjo-readiness-monitor.service" "$UNIT_ROOT/skyjo-readiness-monitor.timer"; do
    /usr/bin/sha256sum "$asset" >> "$MANIFEST"
  done
  /usr/bin/chown root:root "$MANIFEST"
  /usr/bin/chmod 0444 "$MANIFEST"
  verify_installed_assets
  /usr/bin/systemctl daemon-reload
  printf '%s\n' 'Installed staged Skyjo operations assets; no timer or monitor was enabled.'
}

disable_timers() {
  /usr/bin/systemctl disable --now \
    skyjo-readiness-monitor.timer skyjo-backup-daily.timer skyjo-backup-monthly.timer >/dev/null
}

fail_activation() {
  reason=$1
  /usr/bin/rm -f "$MARKER"
  if ! disable_timers; then
    die "$reason The activation marker was removed, but one or more timers could not be disabled."
  fi
  die "$reason Operations remain disabled."
}

activate() {
  assert_install_inactive
  [ -x "$LIB_ROOT/skyjo-ops-launch" ] || die 'Install operations assets before activation.'
  verify_installed_assets
  /usr/bin/systemctl daemon-reload
  [ -L /srv/skyjo-online/current ] || die 'The active release link is missing or unsafe.'
  release=$(/usr/bin/readlink -f /srv/skyjo-online/current)
  case "$release" in /srv/skyjo-online/releases/*) ;; *) die 'The active release is outside the immutable release store.' ;; esac
  [ "$(/usr/bin/dirname "$release")" = /srv/skyjo-online/releases ] || die 'The active release is not a direct release-store child.'
  release_sha=${release##*/}
  printf '%s' "$release_sha" | /usr/bin/grep -Eq '^[a-f0-9]{40}$' || die 'The active release directory is not a full SHA.'
  [ -d "$release" ] && [ ! -L "$release" ] && [ "$(/usr/bin/stat -c %u "$release")" -eq 0 ] || \
    die 'The active release directory is unsafe.'
  release_permissions=$(/usr/bin/stat -c %A "$release")
  case "$release_permissions" in ?????w*|????????w*) die 'The active release directory is writable outside root.' ;; esac
  [ -f "$release/scripts/monitor-readiness.mjs" ] && [ ! -L "$release/scripts/monitor-readiness.mjs" ] || \
    die 'The active release does not contain the readiness monitor.'
  [ -f "$release/scripts/run-scheduled-backup.mjs" ] && [ ! -L "$release/scripts/run-scheduled-backup.mjs" ] || \
    die 'The active release does not contain scheduled backup tooling.'
  if [ -e "$MARKER" ] || [ -L "$MARKER" ]; then
    [ -f "$MARKER" ] && [ ! -L "$MARKER" ] && [ "$(/usr/bin/stat -c %u:%g:%a:%h "$MARKER")" = 0:0:444:1 ] || \
      die 'The operations activation marker is unsafe.'
  else
    /usr/bin/install -o root -g root -m 0444 /dev/null "$MARKER"
  fi
  if ! /usr/bin/systemctl start skyjo-readiness-monitor.service; then
    fail_activation 'Local readiness did not pass.'
  fi
  if ! /opt/skyjo-online/node/bin/node "$ASSET_ROOT/validate-operations-readiness.mjs" \
    "$release_sha" "$(/usr/bin/id -u skyjo-monitor)"; then
    fail_activation 'Local readiness did not identify the active immutable release.'
  fi
  if ! /usr/bin/systemctl start skyjo-backup-daily.service; then
    fail_activation 'The first verified daily backup failed.'
  fi
  if ! /usr/bin/systemctl start skyjo-backup-monthly.service; then
    fail_activation 'The first monthly backup and isolated restore drill failed.'
  fi
  [ "$(/usr/bin/readlink -f /srv/skyjo-online/current)" = "$release" ] || \
    fail_activation 'The active release changed during operations certification.'
  if ! /usr/bin/systemctl start skyjo-readiness-monitor.service; then
    fail_activation 'Final local readiness did not pass after backup certification.'
  fi
  if ! /opt/skyjo-online/node/bin/node "$ASSET_ROOT/validate-operations-readiness.mjs" \
    "$release_sha" "$(/usr/bin/id -u skyjo-monitor)"; then
    fail_activation 'Final local readiness no longer identifies the certified release.'
  fi
  if ! /usr/bin/systemctl enable --now \
    skyjo-readiness-monitor.timer skyjo-backup-daily.timer skyjo-backup-monthly.timer >/dev/null; then
    fail_activation 'Timer activation failed.'
  fi
  printf '%s\n' 'Activated local readiness, daily backup, and monthly restore-drill timers.'
}

deactivate() {
  /usr/bin/rm -f "$MARKER"
  disable_timers || die 'The activation marker was removed, but one or more timers could not be disabled.'
  printf '%s\n' 'Disabled Skyjo operations timers without deleting backups or evidence.'
}

require_root
case "${1:-}" in
  install) [ "$#" -eq 1 ] || die 'install takes no arguments'; install_assets ;;
  activate) [ "$#" -eq 1 ] || die 'activate takes no arguments'; activate ;;
  deactivate) [ "$#" -eq 1 ] || die 'deactivate takes no arguments'; deactivate ;;
  *) die 'Usage: install-skyjo-operations.sh {install|activate|deactivate}' ;;
esac
