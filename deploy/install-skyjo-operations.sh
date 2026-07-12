#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

LIB_ROOT=/usr/local/lib/skyjo-online
UNIT_ROOT=/etc/systemd/system
MARKER=/etc/skyjo-online-operations.enabled
MANIFEST=/usr/local/share/skyjo-online/operations-assets.sha256
ASSET_ROOT=/usr/local/share/skyjo-online/operations
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

die() { printf '%s\n' "$*" >&2; exit 1; }
require_root() { [ "$(id -u)" -eq 0 ] || die 'Run the operations installer as root.'; }
safe_asset() { [ -f "$1" ] && [ ! -L "$1" ] || die "Missing or unsafe operations asset: $1"; }
reject_link() { [ ! -L "$1" ] || die "Refusing a linked operations target: $1"; }

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
  for asset in \
    install-skyjo-operations.sh \
    validate-operations-readiness.mjs \
    skyjo-ops-launch \
    skyjo-backup-daily.service skyjo-backup-daily.timer \
    skyjo-backup-monthly.service skyjo-backup-monthly.timer \
    skyjo-readiness-monitor.service skyjo-readiness-monitor.timer; do
    safe_asset "$SCRIPT_DIR/$asset"
  done
  validate_monitor_user
  for directory in "$LIB_ROOT" /usr/local/share/skyjo-online "$ASSET_ROOT"; do
    reject_link "$directory"
  done
  /usr/bin/install -d -o root -g root -m 0755 "$LIB_ROOT" /usr/local/share/skyjo-online "$ASSET_ROOT"
  if [ "$SCRIPT_DIR" != "$ASSET_ROOT" ]; then
    for target in \
      "$ASSET_ROOT/install-skyjo-operations.sh" "$ASSET_ROOT/skyjo-ops-launch" \
      "$ASSET_ROOT/validate-operations-readiness.mjs" \
      "$ASSET_ROOT/skyjo-backup-daily.service" "$ASSET_ROOT/skyjo-backup-daily.timer" \
      "$ASSET_ROOT/skyjo-backup-monthly.service" "$ASSET_ROOT/skyjo-backup-monthly.timer" \
      "$ASSET_ROOT/skyjo-readiness-monitor.service" "$ASSET_ROOT/skyjo-readiness-monitor.timer"; do
      reject_link "$target"
    done
    /usr/bin/install -o root -g root -m 0555 "$SCRIPT_DIR/install-skyjo-operations.sh" "$ASSET_ROOT/install-skyjo-operations.sh"
    /usr/bin/install -o root -g root -m 0555 "$SCRIPT_DIR/validate-operations-readiness.mjs" "$ASSET_ROOT/validate-operations-readiness.mjs"
    /usr/bin/install -o root -g root -m 0555 "$SCRIPT_DIR/skyjo-ops-launch" "$ASSET_ROOT/skyjo-ops-launch"
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
  reject_link "$LIB_ROOT/skyjo-ops-launch"
  /usr/bin/install -o root -g root -m 0555 "$ASSET_ROOT/skyjo-ops-launch" "$LIB_ROOT/skyjo-ops-launch"
  for asset in \
    skyjo-backup-daily.service skyjo-backup-daily.timer \
    skyjo-backup-monthly.service skyjo-backup-monthly.timer \
      skyjo-readiness-monitor.service skyjo-readiness-monitor.timer; do
    reject_link "$UNIT_ROOT/$asset"
    /usr/bin/install -o root -g root -m 0444 "$ASSET_ROOT/$asset" "$UNIT_ROOT/$asset"
  done
  /usr/bin/systemd-analyze verify \
    "$UNIT_ROOT/skyjo-backup-daily.service" "$UNIT_ROOT/skyjo-backup-daily.timer" \
    "$UNIT_ROOT/skyjo-backup-monthly.service" "$UNIT_ROOT/skyjo-backup-monthly.timer" \
    "$UNIT_ROOT/skyjo-readiness-monitor.service" "$UNIT_ROOT/skyjo-readiness-monitor.timer" >/dev/null
  reject_link "$MANIFEST"
  [ ! -e "$MANIFEST" ] || { [ -f "$MANIFEST" ] && [ "$(/usr/bin/stat -c %u:%h "$MANIFEST")" = 0:1 ]; } || \
    die 'Existing operations asset manifest is unsafe.'
  /usr/bin/rm -f "$MANIFEST"
  /usr/bin/install -o root -g root -m 0600 /dev/null "$MANIFEST"
  for asset in \
    "$ASSET_ROOT/install-skyjo-operations.sh" \
    "$ASSET_ROOT/validate-operations-readiness.mjs" \
    "$ASSET_ROOT/skyjo-ops-launch" \
    "$ASSET_ROOT/skyjo-backup-daily.service" "$ASSET_ROOT/skyjo-backup-daily.timer" \
    "$ASSET_ROOT/skyjo-backup-monthly.service" "$ASSET_ROOT/skyjo-backup-monthly.timer" \
    "$ASSET_ROOT/skyjo-readiness-monitor.service" "$ASSET_ROOT/skyjo-readiness-monitor.timer" \
    "$LIB_ROOT/skyjo-ops-launch" \
    "$UNIT_ROOT/skyjo-backup-daily.service" "$UNIT_ROOT/skyjo-backup-daily.timer" \
    "$UNIT_ROOT/skyjo-backup-monthly.service" "$UNIT_ROOT/skyjo-backup-monthly.timer" \
    "$UNIT_ROOT/skyjo-readiness-monitor.service" "$UNIT_ROOT/skyjo-readiness-monitor.timer"; do
    /usr/bin/sha256sum "$asset" >> "$MANIFEST"
  done
  /usr/bin/chown root:root "$MANIFEST"
  /usr/bin/chmod 0444 "$MANIFEST"
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
  [ -x "$LIB_ROOT/skyjo-ops-launch" ] || die 'Install operations assets before activation.'
  [ -L /srv/skyjo-online/current ] || die 'The active release link is missing or unsafe.'
  release=$(/usr/bin/readlink -f /srv/skyjo-online/current)
  case "$release" in /srv/skyjo-online/releases/*) ;; *) die 'The active release is outside the immutable release store.' ;; esac
  [ "$(/usr/bin/dirname "$release")" = /srv/skyjo-online/releases ] || die 'The active release is not a direct release-store child.'
  release_sha=${release##*/}
  printf '%s' "$release_sha" | /usr/bin/grep -Eq '^[a-f0-9]{40}$' || die 'The active release directory is not a full SHA.'
  [ -d "$release" ] && [ ! -L "$release" ] && [ "$(/usr/bin/stat -c %u "$release")" -eq 0 ] || \
    die 'The active release directory is unsafe.'
  [ -f "$release/scripts/monitor-readiness.mjs" ] && [ ! -L "$release/scripts/monitor-readiness.mjs" ] || \
    die 'The active release does not contain the readiness monitor.'
  [ -f "$release/scripts/run-scheduled-backup.mjs" ] && [ ! -L "$release/scripts/run-scheduled-backup.mjs" ] || \
    die 'The active release does not contain scheduled backup tooling.'
  if [ -e "$MARKER" ] || [ -L "$MARKER" ]; then
    [ -f "$MARKER" ] && [ ! -L "$MARKER" ] && [ "$(/usr/bin/stat -c %u:%g:%a "$MARKER")" = 0:0:444 ] || \
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
