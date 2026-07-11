#!/bin/sh
set -eu

NODE_VERSION=24.18.0
NODE_SHA256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
NODE_ROOT=/opt/skyjo-online
APP_ROOT=/srv/skyjo-online
LIB_ROOT=/usr/local/lib/skyjo-online
STAGED_UNIT=/usr/local/share/skyjo-online/skyjo-online.service
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

die() { printf '%s\n' "$*" >&2; exit 1; }
require_root() { [ "$(id -u)" -eq 0 ] || die 'Run this bootstrap as root.'; }
valid_sha() { printf '%s' "$1" | grep -Eq '^[a-f0-9]{40}$'; }

install_node() {
  [ "$(uname -m)" = x86_64 ] || die 'The pinned runtime installer currently supports x86_64 only.'
  target="$NODE_ROOT/node-v$NODE_VERSION"
  if [ ! -x "$target/bin/node" ]; then
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT INT TERM
    archive="$tmp/node.tar.xz"
    /usr/bin/curl --fail --silent --show-error --location \
      "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" --output "$archive"
    printf '%s  %s\n' "$NODE_SHA256" "$archive" | /usr/bin/sha256sum --check --status || die 'Pinned Node archive checksum failed.'
    /usr/bin/mkdir -p "$NODE_ROOT"
    /usr/bin/tar --extract --xz --file "$archive" --directory "$NODE_ROOT"
    /usr/bin/chown -R root:root "$target"
    /usr/bin/chmod -R u=rwX,go=rX "$target"
    rm -rf "$tmp"
    trap - EXIT INT TERM
  fi
  [ "$($target/bin/node --version)" = "v$NODE_VERSION" ] || die 'Pinned Node runtime validation failed.'
  /usr/bin/ln -sfn "node-v$NODE_VERSION" "$NODE_ROOT/node.next"
  /usr/bin/mv -Tf "$NODE_ROOT/node.next" "$NODE_ROOT/node"
}

prepare() {
  public_key=${1:-}
  [ -n "$public_key" ] && [ -f "$public_key" ] || die 'Usage: bootstrap-skyjo-delivery.sh prepare <deploy-public-key-file>'
  key=$(sed -n '1p' "$public_key")
  printf '%s' "$key" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+([[:space:]].*)?$' || die 'Deploy key must be a single Ed25519 public key.'
  [ "$(wc -l < "$public_key")" -eq 1 ] || die 'Deploy public key file must contain exactly one line.'

  install_node
  id skyjo >/dev/null 2>&1 || /usr/sbin/useradd --system --home-dir /var/lib/skyjo-online --shell /usr/sbin/nologin skyjo
  id skyjo-deploy >/dev/null 2>&1 || /usr/sbin/useradd --system --create-home --home-dir /var/lib/skyjo-deploy --shell /bin/sh skyjo-deploy
  /usr/sbin/usermod --lock skyjo-deploy
  /usr/bin/install -d -o root -g root -m 0755 "$APP_ROOT" "$APP_ROOT/releases" "$LIB_ROOT" /usr/local/share/skyjo-online
  /usr/bin/install -d -o skyjo -g skyjo -m 0700 /var/lib/skyjo-online
  /usr/bin/install -d -o root -g root -m 0700 /var/backups/skyjo-online
  /usr/bin/install -d -o root -g skyjo-deploy -m 0730 /var/tmp/skyjo-deploy
  /usr/bin/install -d -o root -g skyjo -m 0750 /run/skyjo-online-canary

  for file in release-controller.mjs release-controller-lib.mjs skyjo-deploy-dispatch.mjs skyjo-canary-launch skyjo-smoke-launch; do
    /usr/bin/install -o root -g root -m 0755 "$SCRIPT_DIR/$file" "$LIB_ROOT/$file"
  done
  /usr/bin/install -o root -g root -m 0755 "$SCRIPT_DIR/skyjo-release-controller" /usr/local/sbin/skyjo-release-controller
  /usr/bin/install -o root -g root -m 0444 "$SCRIPT_DIR/skyjo-online.service" "$STAGED_UNIT"
  /usr/bin/install -o root -g root -m 0444 "$SCRIPT_DIR/skyjo-online-canary@.service" /etc/systemd/system/skyjo-online-canary@.service
  /usr/bin/install -o root -g root -m 0444 "$SCRIPT_DIR/skyjo-online-smoke@.service" /etc/systemd/system/skyjo-online-smoke@.service
  /usr/bin/install -o root -g root -m 0440 "$SCRIPT_DIR/skyjo-deploy.sudoers" /etc/sudoers.d/skyjo-deploy
  /usr/sbin/visudo -cf /etc/sudoers.d/skyjo-deploy >/dev/null

  deploy_home=/var/lib/skyjo-deploy
  /usr/bin/chown root:root "$deploy_home"
  /usr/bin/chmod 0755 "$deploy_home"
  /usr/bin/install -d -o root -g root -m 0755 "$deploy_home/.ssh"
  options='restrict,no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding,command="/opt/skyjo-online/node/bin/node /usr/local/lib/skyjo-online/skyjo-deploy-dispatch.mjs"'
  printf '%s %s\n' "$options" "$key" > "$deploy_home/.ssh/authorized_keys"
  /usr/bin/chown root:root "$deploy_home/.ssh/authorized_keys"
  /usr/bin/chmod 0644 "$deploy_home/.ssh/authorized_keys"

  if [ ! -e /etc/skyjo-online.env ]; then
    /usr/bin/install -o root -g root -m 0600 /dev/null /etc/skyjo-online.env
    printf '%s\n' 'Created empty /etc/skyjo-online.env; populate required secrets before verification.' >&2
  else
    /usr/bin/chown root:root /etc/skyjo-online.env
    /usr/bin/chmod 0600 /etc/skyjo-online.env
  fi
  /usr/bin/systemctl daemon-reload
  printf '%s\n' 'Prepared Skyjo delivery assets. The live production unit was not replaced or restarted.'
}

adopt_legacy() {
  sha=${1:-}
  valid_sha "$sha" || die 'Usage: bootstrap-skyjo-delivery.sh adopt-legacy <40-char-current-sha>'
  [ ! -e "$APP_ROOT/current" ] || die 'Current release link already exists.'
  target="$APP_ROOT/releases/$sha"
  [ ! -e "$target" ] || die 'Legacy release target already exists.'
  [ -f "$APP_ROOT/server.mjs" ] && [ -d "$APP_ROOT/dist" ] && [ -d "$APP_ROOT/node_modules" ] || die 'Legacy runtime tree is incomplete.'
  if [ -d "$APP_ROOT/.git" ]; then
    actual=$(/usr/bin/git -C "$APP_ROOT" rev-parse HEAD)
    [ "$actual" = "$sha" ] || die 'Legacy checkout HEAD does not match requested SHA.'
  fi
  tmp="$APP_ROOT/releases/.legacy-$sha-$$"
  /usr/bin/mkdir -m 0700 "$tmp"
  for item in dist server-dist scripts package.json package-lock.json server.mjs server-account-store.mjs server-room-persistence.mjs server-persistence-health.mjs server-readiness.mjs server-release.mjs server-state-backup.mjs; do
    [ ! -e "$APP_ROOT/$item" ] || /usr/bin/cp -a "$APP_ROOT/$item" "$tmp/$item"
  done
  (cd "$tmp" && /opt/skyjo-online/node/bin/node /opt/skyjo-online/node/lib/node_modules/npm/bin/npm-cli.js ci --omit=dev --ignore-scripts --no-audit --no-fund)
  /usr/bin/rm -rf "$tmp/node_modules/.bin"
  if /usr/bin/find "$tmp" -type l -print -quit | /usr/bin/grep -q .; then
    /usr/bin/rm -rf "$tmp"
    die 'Legacy rollback snapshot contains a symbolic link.'
  fi
  /opt/skyjo-online/node/bin/node --check "$tmp/server.mjs"
  printf '%s\n' "$sha" > "$tmp/.skyjo-legacy"
  printf '{"releaseSha":"%s","legacy":true}\n' "$sha" > "$tmp/.skyjo-deployment.json"
  (cd "$tmp" && /usr/bin/find . -type f ! -name .skyjo-legacy-manifest.sha256 -print0 | LC_ALL=C /usr/bin/sort -z | /usr/bin/xargs -0 /usr/bin/sha256sum) > "$tmp/.skyjo-legacy-manifest.sha256"
  /usr/bin/chown -R root:root "$tmp"
  /usr/bin/chmod -R u=rwX,go=rX "$tmp"
  /usr/bin/mv "$tmp" "$target"
  /usr/bin/ln -s "releases/$sha" "$APP_ROOT/current.next"
  /usr/bin/mv -T "$APP_ROOT/current.next" "$APP_ROOT/current"
  /usr/bin/install -d -o root -g root -m 0700 /var/backups/skyjo-online/bootstrap
  if [ -f /etc/systemd/system/skyjo-online.service ]; then
    /usr/bin/cp -a /etc/systemd/system/skyjo-online.service /var/backups/skyjo-online/bootstrap/legacy-skyjo-online.service
    /usr/bin/sha256sum /var/backups/skyjo-online/bootstrap/legacy-skyjo-online.service > /var/backups/skyjo-online/bootstrap/legacy-skyjo-online.service.sha256
  fi
  printf '%s\n' "Adopted immutable legacy rollback anchor $sha without restarting production."
}

activate_unit() {
  [ -L "$APP_ROOT/current" ] || die 'A validated current rollback anchor is required before activating the hardened unit.'
  target=$(/usr/bin/readlink -f "$APP_ROOT/current")
  case "$target" in "$APP_ROOT/releases/"*) ;; *) die 'Current link is outside the release store.';; esac
  [ -f "$target/.skyjo-legacy" ] || [ -f "$target/release.json" ] || die 'Current release anchor is not validated.'
  if [ -f "$target/.skyjo-legacy" ]; then
    (cd "$target" && /usr/bin/sha256sum --check --strict .skyjo-legacy-manifest.sha256 >/dev/null) || die 'Legacy rollback checksum manifest is invalid.'
  fi
  old_unit=/var/backups/skyjo-online/bootstrap/legacy-skyjo-online.service
  [ -f "$old_unit" ] || die 'The original production unit backup is missing.'
  state=/var/lib/skyjo-online
  [ -d "$state" ] && [ ! -L "$state" ] || die 'Production state directory is unsafe.'
  if /usr/bin/find "$state" -mindepth 1 \( -type l -o \( ! -type f ! -type d \) \) -print -quit | /usr/bin/grep -q .; then
    die 'Production state contains a symlink or special file.'
  fi
  for file in rooms.json skyjo.sqlite skyjo.sqlite-wal skyjo.sqlite-shm; do
    [ ! -e "$state/$file" ] || { [ -f "$state/$file" ] && [ ! -L "$state/$file" ]; } || die "Unsafe production state file: $file"
  done

  /usr/bin/systemctl stop skyjo-online.service
  activated=false
  if /usr/bin/chown -R skyjo:skyjo "$state" && /usr/bin/chmod 0700 "$state"; then
    for file in rooms.json skyjo.sqlite skyjo.sqlite-wal skyjo.sqlite-shm; do [ ! -e "$state/$file" ] || /usr/bin/chmod 0600 "$state/$file"; done
    /usr/bin/install -o root -g root -m 0444 "$STAGED_UNIT" /etc/systemd/system/skyjo-online.service
    /usr/bin/systemctl daemon-reload
    if /usr/bin/systemctl start skyjo-online.service; then
      count=0
      while [ "$count" -lt 60 ]; do
        if /usr/bin/curl --fail --silent --show-error http://127.0.0.1:4180/healthz | /usr/bin/grep -qx ok; then activated=true; break; fi
        count=$((count + 1)); /usr/bin/sleep 0.25
      done
    fi
  fi
  if [ "$activated" != true ]; then
    /usr/bin/systemctl stop skyjo-online.service >/dev/null 2>&1 || true
    /usr/bin/install -o root -g root -m 0644 "$old_unit" /etc/systemd/system/skyjo-online.service
    /usr/bin/systemctl daemon-reload
    /usr/bin/systemctl start skyjo-online.service
    /usr/bin/curl --fail --silent --show-error http://127.0.0.1:4180/healthz | /usr/bin/grep -qx ok || die 'Hardened unit cutover failed and legacy recovery did not become healthy.'
    die 'Hardened unit cutover failed; the original unit was restored and reverified.'
  fi
  printf '%s\n' 'Activated and health-verified the hardened unit against the immutable legacy rollback anchor.'
}

require_root
case "${1:-}" in
  prepare) shift; prepare "$@" ;;
  adopt-legacy) shift; adopt_legacy "$@" ;;
  activate-production-unit) shift; [ "$#" -eq 0 ] || die 'activate-production-unit takes no arguments'; activate_unit ;;
  *) die 'Usage: bootstrap-skyjo-delivery.sh {prepare <deploy-public-key-file>|adopt-legacy <sha>|activate-production-unit}' ;;
esac
