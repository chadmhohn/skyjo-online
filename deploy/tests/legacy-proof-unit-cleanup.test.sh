#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
. "$ROOT/deploy/legacy-proof-unit-cleanup-lib.sh"

TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
export FAKE_SYSTEMCTL_LOG=$TMP/systemctl.log
export FAKE_SYSTEMCTL_STATE=$TMP/state
export FAKE_SYSTEMCTL_SCENARIO=clean
FAKE_SYSTEMCTL=fake_systemctl
UNIT=skyjo-online-legacy-proof@bootstrap-activation.service

fake_systemctl() {
  printf '%s\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"
  command_name=${1:-}
  unit=${!#}
  case "$command_name" in
    show)
      [[ "$*" == *' --all '* ]] || return 91
      [[ "$FAKE_SYSTEMCTL_SCENARIO" != show-failure ]] || return 92
      for property in Id LoadState ActiveState SubState Result MainPID ControlPID Job FragmentPath DropInPaths CollectMode; do
        [[ " $* " == *" --property=$property "* ]] || return 93
      done
      state=$FAKE_SYSTEMCTL_SCENARIO
      [[ ! -f "$FAKE_SYSTEMCTL_STATE" ]] || state=$(<"$FAKE_SYSTEMCTL_STATE")
      fragment=/etc/systemd/system/skyjo-online-legacy-proof@.service
      drop_in=
      active_state=inactive
      sub_state=dead
      result=success
      main_pid=0
      [[ "$state" != foreign-fragment ]] || fragment=/tmp/foreign.service
      [[ "$state" != foreign-dropin ]] || drop_in=/etc/systemd/system/override.conf
      if [[ "$state" == failed || "$state" == reset-failure ]]; then
        active_state=failed; sub_state=failed; result=exit-code
      elif [[ "$state" == active || "$state" == stop-failure ]]; then
        active_state=active; sub_state=running; main_pid=42
      fi
      printf 'SubState=%s\nId=%s\nResult=%s\nLoadState=loaded\nActiveState=%s\n' \
        "$sub_state" "$unit" "$result" "$active_state"
      printf 'MainPID=%s\nControlPID=0\n' "$main_pid"
      [[ "$state" == missing-property ]] || printf 'Job=\n'
      printf 'FragmentPath=%s\nDropInPaths=%s\nCollectMode=inactive\n' "$fragment" "$drop_in"
      [[ "$state" != duplicate-property ]] || printf 'Result=%s\n' "$result"
      [[ "$state" != control-character ]] || printf 'Unexpected=bad\rvalue\n'
      ;;
    stop)
      [[ "$FAKE_SYSTEMCTL_SCENARIO" != stop-failure ]] || return 95
      printf '%s\n' clean > "$FAKE_SYSTEMCTL_STATE"
      ;;
    reset-failed)
      [[ "$FAKE_SYSTEMCTL_SCENARIO" != reset-failure ]] || return 96
      printf '%s\n' clean > "$FAKE_SYSTEMCTL_STATE"
      ;;
    *) return 97 ;;
  esac
}

reset_case() {
  FAKE_SYSTEMCTL_SCENARIO=$1
  export FAKE_SYSTEMCTL_SCENARIO
  : > "$FAKE_SYSTEMCTL_LOG"
  rm -f -- "$FAKE_SYSTEMCTL_STATE"
}

reset_case clean
skyjo_cleanup_bootstrap_legacy_unit "$UNIT" "$FAKE_SYSTEMCTL"
! grep -Eq '^(stop|reset-failed) ' "$FAKE_SYSTEMCTL_LOG"
[[ "$(grep -c '^show ' "$FAKE_SYSTEMCTL_LOG")" -eq 1 ]]

reset_case failed
if skyjo_cleanup_bootstrap_legacy_unit "$UNIT" "$FAKE_SYSTEMCTL"; then exit 1; fi
grep -Fx "reset-failed $UNIT" "$FAKE_SYSTEMCTL_LOG" >/dev/null
[[ "$(<"$FAKE_SYSTEMCTL_STATE")" == clean ]]
[[ "$(grep -c '^show ' "$FAKE_SYSTEMCTL_LOG")" -eq 2 ]]

reset_case active
if skyjo_cleanup_bootstrap_legacy_unit "$UNIT" "$FAKE_SYSTEMCTL"; then exit 1; fi
grep -Fx "stop $UNIT" "$FAKE_SYSTEMCTL_LOG" >/dev/null
[[ "$(<"$FAKE_SYSTEMCTL_STATE")" == clean ]]
[[ "$(grep -c '^show ' "$FAKE_SYSTEMCTL_LOG")" -eq 2 ]]

for scenario in foreign-fragment foreign-dropin reset-failure show-failure stop-failure missing-property duplicate-property control-character; do
  reset_case "$scenario"
  if skyjo_cleanup_bootstrap_legacy_unit "$UNIT" "$FAKE_SYSTEMCTL"; then exit 1; fi
done

reset_case clean
if skyjo_cleanup_bootstrap_legacy_unit skyjo-online-legacy-proof@123-1-production.service "$FAKE_SYSTEMCTL"; then exit 1; fi
[[ ! -s "$FAKE_SYSTEMCTL_LOG" ]]

REMOVAL_LOG=$TMP/removals.log
remove_environment() { printf '%s\n' "$1" >> "$REMOVAL_LOG"; }
reset_case stop-failure
if skyjo_finalize_bootstrap_legacy_proof 0 "$UNIT" /run/private-proof.env "$FAKE_SYSTEMCTL" remove_environment; then exit 1; fi
grep -Fx /run/private-proof.env "$REMOVAL_LOG" >/dev/null

reset_case clean
skyjo_finalize_bootstrap_legacy_proof 0 "$UNIT" /run/clean-proof.env "$FAKE_SYSTEMCTL" remove_environment
grep -Fx /run/clean-proof.env "$REMOVAL_LOG" >/dev/null

reset_case clean
if skyjo_finalize_bootstrap_legacy_proof 1 "$UNIT" /run/failed-proof.env "$FAKE_SYSTEMCTL" remove_environment; then exit 1; fi
grep -Fx /run/failed-proof.env "$REMOVAL_LOG" >/dev/null
grep -Eq '^show ' "$FAKE_SYSTEMCTL_LOG"

reset_case clean
if skyjo_finalize_bootstrap_legacy_proof invalid "$UNIT" /run/invalid-proof.env "$FAKE_SYSTEMCTL" remove_environment; then exit 1; fi
grep -Fx /run/invalid-proof.env "$REMOVAL_LOG" >/dev/null
grep -Eq '^show ' "$FAKE_SYSTEMCTL_LOG"

printf '%s\n' 'legacy proof unit cleanup tests passed'
