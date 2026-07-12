#!/bin/sh
set -eu

NODE_VERSION=24.18.0
NODE_SHA256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
TRANSPORT_KEY_FINGERPRINT=SHA256:bhyqodJaNMmwhARLS0JOIZUm4Xh+u7mNT00mYfVdPaw
NODE_ROOT=/opt/skyjo-online
APP_ROOT=/srv/skyjo-online
LIB_ROOT=/usr/local/lib/skyjo-online
STAGED_UNIT=/usr/local/share/skyjo-online/skyjo-online.service
AUTH_ROOT=/etc/skyjo-deploy-auth
REPLAY_ROOT=/var/lib/skyjo-deploy-authorizations
ASSET_MANIFEST=/usr/local/share/skyjo-online/delivery-assets.sha256
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

die() { printf '%s\n' "$*" >&2; exit 1; }
require_root() { [ "$(id -u)" -eq 0 ] || die 'Run this bootstrap as root.'; }
valid_sha() { printf '%s' "$1" | grep -Eq '^[a-f0-9]{40}$'; }
[ -f "$SCRIPT_DIR/node-runtime-installer.sh" ] && [ ! -L "$SCRIPT_DIR/node-runtime-installer.sh" ] || die 'Node runtime installer library is missing or unsafe.'
. "$SCRIPT_DIR/node-runtime-installer.sh"

install_node() {
  [ "$(uname -m)" = x86_64 ] || die 'The pinned runtime installer currently supports x86_64 only.'
  target="$NODE_ROOT/node-v$NODE_VERSION"
  if [ -e "$target" ] || [ -L "$target" ]; then
    skyjo_node_target_valid "$target" "$NODE_VERSION" || die 'Existing pinned Node runtime is incomplete or invalid.'
  else
    tmp=$(mktemp -d)
    cleanup_node_download() {
      case "$tmp" in /tmp/tmp.*|/var/tmp/tmp.*) /usr/bin/rm -rf -- "$tmp" ;; *) die 'Refusing to clean an unexpected Node download path.' ;; esac
    }
    trap cleanup_node_download EXIT INT TERM
    archive="$tmp/node.tar.xz"
    /usr/bin/curl --fail --silent --show-error --location \
      "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" --output "$archive"
    /usr/bin/mkdir -p "$NODE_ROOT"
    skyjo_install_node_archive \
      "$archive" "$NODE_SHA256" "$NODE_ROOT" "$target" \
      "node-v$NODE_VERSION-linux-x64" "$NODE_VERSION" root:root || die 'Pinned Node runtime installation failed.'
    cleanup_node_download
    trap - EXIT INT TERM
  fi
  skyjo_node_target_valid "$target" "$NODE_VERSION" || die 'Pinned Node runtime validation failed.'
  /usr/bin/ln -sfn "node-v$NODE_VERSION" "$NODE_ROOT/node.next"
  /usr/bin/mv -Tf "$NODE_ROOT/node.next" "$NODE_ROOT/node"
}

prepare() {
  public_key=${1:-}
  canary_authorization_key=${2:-}
  production_authorization_key=${3:-}
  [ "$#" -eq 3 ] && [ -f "$public_key" ] && [ -f "$canary_authorization_key" ] && [ -f "$production_authorization_key" ] || \
    die 'Usage: bootstrap-skyjo-delivery.sh prepare <transport-public-key> <canary-authorization-public-pem> <production-authorization-public-pem>'
  key=$(sed -n '1p' "$public_key")
  printf '%s' "$key" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+([[:space:]].*)?$' || die 'Deploy key must be a single Ed25519 public key.'
  [ "$(wc -l < "$public_key")" -eq 1 ] || die 'Deploy public key file must contain exactly one line.'
  [ "$(/usr/bin/ssh-keygen -lf "$public_key" -E sha256 | /usr/bin/awk '{print $2}')" = "$TRANSPORT_KEY_FINGERPRINT" ] || \
    die 'Deploy transport key does not match the pinned GitHub environment key.'

  install_node
  /opt/skyjo-online/node/bin/node "$SCRIPT_DIR/validate-deployment-public-keys.mjs" \
    "$canary_authorization_key" "$production_authorization_key" >/dev/null
  id skyjo >/dev/null 2>&1 || /usr/sbin/useradd --system --home-dir /var/lib/skyjo-online --shell /usr/sbin/nologin skyjo
  id skyjo-canary >/dev/null 2>&1 || /usr/sbin/useradd --system --no-create-home --home-dir /var/empty/skyjo-canary --shell /usr/sbin/nologin skyjo-canary
  id skyjo-deploy >/dev/null 2>&1 || /usr/sbin/useradd --system --create-home --home-dir /var/lib/skyjo-deploy --shell /bin/sh skyjo-deploy
  /usr/sbin/usermod --lock skyjo-deploy
  /usr/bin/install -d -o root -g root -m 0755 "$APP_ROOT" "$APP_ROOT/releases" "$LIB_ROOT" /usr/local/share/skyjo-online
  if [ ! -e /var/lib/skyjo-online ]; then
    /usr/bin/install -d -o root -g root -m 0700 /var/lib/skyjo-online
  else
    [ -d /var/lib/skyjo-online ] && [ ! -L /var/lib/skyjo-online ] || die 'Existing production state directory is unsafe.'
  fi
  /usr/bin/install -d -o root -g root -m 0700 /var/backups/skyjo-online
  /usr/bin/install -d -o root -g skyjo-deploy -m 1731 /var/tmp/skyjo-deploy
  /usr/bin/install -d -o root -g root -m 0700 "$REPLAY_ROOT"
  /usr/bin/install -d -o root -g root -m 0700 "$AUTH_ROOT"
  /usr/bin/install -o root -g root -m 0600 "$canary_authorization_key" "$AUTH_ROOT/canary-public.pem"
  /usr/bin/install -o root -g root -m 0600 "$production_authorization_key" "$AUTH_ROOT/production-public.pem"
  /usr/bin/install -o root -g root -m 0444 "$SCRIPT_DIR/skyjo-online-tmpfiles.conf" /etc/tmpfiles.d/skyjo-online.conf
  /usr/bin/systemd-tmpfiles --create /etc/tmpfiles.d/skyjo-online.conf

  for file in release-controller.mjs release-controller-lib.mjs state-snapshot-lib.mjs deployment-authorization-lib.mjs skyjo-deploy-dispatch.mjs validate-deployment-public-keys.mjs; do
    /usr/bin/install -o root -g root -m 0555 "$SCRIPT_DIR/$file" "$LIB_ROOT/$file"
  done
  for file in skyjo-canary-launch skyjo-smoke-launch skyjo-state-proof-launch; do
    /usr/bin/install -o root -g root -m 0555 "$SCRIPT_DIR/$file" "$LIB_ROOT/$file"
  done
  /usr/bin/install -o root -g root -m 0555 "$SCRIPT_DIR/skyjo-release-controller" /usr/local/sbin/skyjo-release-controller
  /usr/bin/install -o root -g root -m 0444 "$SCRIPT_DIR/skyjo-online.service" "$STAGED_UNIT"
  /usr/bin/install -o root -g root -m 0444 "$SCRIPT_DIR/skyjo-online-canary@.service" /etc/systemd/system/skyjo-online-canary@.service
  /usr/bin/install -o root -g root -m 0444 "$SCRIPT_DIR/skyjo-online-canary-smoke@.service" /etc/systemd/system/skyjo-online-canary-smoke@.service
  /usr/bin/install -o root -g root -m 0444 "$SCRIPT_DIR/skyjo-online-smoke@.service" /etc/systemd/system/skyjo-online-smoke@.service
  /usr/bin/install -o root -g root -m 0444 "$SCRIPT_DIR/skyjo-online-state-proof@.service" /etc/systemd/system/skyjo-online-state-proof@.service
  /usr/bin/install -o root -g root -m 0440 "$SCRIPT_DIR/skyjo-deploy.sudoers" /etc/sudoers.d/skyjo-deploy
  /usr/sbin/visudo -cf /etc/sudoers.d/skyjo-deploy >/dev/null
  /usr/bin/systemd-analyze verify \
    /etc/systemd/system/skyjo-online-canary@.service \
    /etc/systemd/system/skyjo-online-canary-smoke@.service \
    /etc/systemd/system/skyjo-online-smoke@.service \
    /etc/systemd/system/skyjo-online-state-proof@.service \
    "$STAGED_UNIT" >/dev/null

  deploy_home=/var/lib/skyjo-deploy
  /usr/bin/chown root:root "$deploy_home"
  /usr/bin/chmod 0755 "$deploy_home"
  /usr/bin/install -d -o root -g root -m 0755 "$deploy_home/.ssh"
  options='restrict,no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding,command="/opt/skyjo-online/node/bin/node /usr/local/lib/skyjo-online/skyjo-deploy-dispatch.mjs"'
  printf '%s %s\n' "$options" "$key" > "$deploy_home/.ssh/authorized_keys"
  /usr/bin/chown root:root "$deploy_home/.ssh/authorized_keys"
  /usr/bin/chmod 0644 "$deploy_home/.ssh/authorized_keys"

  : > "$ASSET_MANIFEST"
  for asset in \
    "$LIB_ROOT/release-controller.mjs" \
    "$LIB_ROOT/release-controller-lib.mjs" \
    "$LIB_ROOT/state-snapshot-lib.mjs" \
    "$LIB_ROOT/deployment-authorization-lib.mjs" \
    "$LIB_ROOT/skyjo-deploy-dispatch.mjs" \
    "$LIB_ROOT/validate-deployment-public-keys.mjs" \
    "$LIB_ROOT/skyjo-canary-launch" \
    "$LIB_ROOT/skyjo-smoke-launch" \
    "$LIB_ROOT/skyjo-state-proof-launch" \
    /usr/local/sbin/skyjo-release-controller \
    "$STAGED_UNIT" \
    /etc/systemd/system/skyjo-online-canary@.service \
    /etc/systemd/system/skyjo-online-canary-smoke@.service \
    /etc/systemd/system/skyjo-online-smoke@.service \
    /etc/systemd/system/skyjo-online-state-proof@.service \
    /etc/tmpfiles.d/skyjo-online.conf \
    /etc/sudoers.d/skyjo-deploy \
    "$AUTH_ROOT/canary-public.pem" \
    "$AUTH_ROOT/production-public.pem"; do
    /usr/bin/sha256sum "$asset" >> "$ASSET_MANIFEST"
  done
  /usr/bin/chown root:root "$ASSET_MANIFEST"
  /usr/bin/chmod 0444 "$ASSET_MANIFEST"

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
  *) die 'Usage: bootstrap-skyjo-delivery.sh {prepare <transport-public-key> <canary-auth-public-pem> <production-auth-public-pem>|adopt-legacy <sha>|activate-production-unit}' ;;
esac
