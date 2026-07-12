#!/bin/sh

skyjo_parse_bootstrap_legacy_unit_snapshot() {
  skyjo_snapshot=$1
  [ "${#skyjo_snapshot}" -ge 1 ] && [ "${#skyjo_snapshot}" -le 4096 ] || return 1
  skyjo_probe_Id= skyjo_probe_LoadState= skyjo_probe_ActiveState= skyjo_probe_SubState=
  skyjo_probe_Result= skyjo_probe_MainPID= skyjo_probe_ControlPID= skyjo_probe_Job=
  skyjo_probe_FragmentPath= skyjo_probe_DropInPaths= skyjo_probe_CollectMode=
  skyjo_seen_Id=0 skyjo_seen_LoadState=0 skyjo_seen_ActiveState=0 skyjo_seen_SubState=0
  skyjo_seen_Result=0 skyjo_seen_MainPID=0 skyjo_seen_ControlPID=0 skyjo_seen_Job=0
  skyjo_seen_FragmentPath=0 skyjo_seen_DropInPaths=0 skyjo_seen_CollectMode=0
  skyjo_line_count=0
  while IFS= read -r skyjo_line || [ -n "$skyjo_line" ]; do
    skyjo_line_count=$((skyjo_line_count + 1))
    [ "$skyjo_line_count" -le 11 ] && [ "${#skyjo_line}" -le 1024 ] || return 1
    case "$skyjo_line" in *[![:print:]]*) return 1 ;; esac
    skyjo_key=${skyjo_line%%=*}
    [ "$skyjo_key" != "$skyjo_line" ] || return 1
    skyjo_value=${skyjo_line#*=}
    case "$skyjo_key" in
      Id) [ "$skyjo_seen_Id" -eq 0 ] || return 1; skyjo_seen_Id=1; skyjo_probe_Id=$skyjo_value ;;
      LoadState) [ "$skyjo_seen_LoadState" -eq 0 ] || return 1; skyjo_seen_LoadState=1; skyjo_probe_LoadState=$skyjo_value ;;
      ActiveState) [ "$skyjo_seen_ActiveState" -eq 0 ] || return 1; skyjo_seen_ActiveState=1; skyjo_probe_ActiveState=$skyjo_value ;;
      SubState) [ "$skyjo_seen_SubState" -eq 0 ] || return 1; skyjo_seen_SubState=1; skyjo_probe_SubState=$skyjo_value ;;
      Result) [ "$skyjo_seen_Result" -eq 0 ] || return 1; skyjo_seen_Result=1; skyjo_probe_Result=$skyjo_value ;;
      MainPID) [ "$skyjo_seen_MainPID" -eq 0 ] || return 1; skyjo_seen_MainPID=1; skyjo_probe_MainPID=$skyjo_value ;;
      ControlPID) [ "$skyjo_seen_ControlPID" -eq 0 ] || return 1; skyjo_seen_ControlPID=1; skyjo_probe_ControlPID=$skyjo_value ;;
      Job) [ "$skyjo_seen_Job" -eq 0 ] || return 1; skyjo_seen_Job=1; skyjo_probe_Job=$skyjo_value ;;
      FragmentPath) [ "$skyjo_seen_FragmentPath" -eq 0 ] || return 1; skyjo_seen_FragmentPath=1; skyjo_probe_FragmentPath=$skyjo_value ;;
      DropInPaths) [ "$skyjo_seen_DropInPaths" -eq 0 ] || return 1; skyjo_seen_DropInPaths=1; skyjo_probe_DropInPaths=$skyjo_value ;;
      CollectMode) [ "$skyjo_seen_CollectMode" -eq 0 ] || return 1; skyjo_seen_CollectMode=1; skyjo_probe_CollectMode=$skyjo_value ;;
      *) return 1 ;;
    esac
  done <<EOF
$skyjo_snapshot
EOF
  [ "$skyjo_line_count" -eq 11 ] && [ "$skyjo_seen_Id" -eq 1 ] && [ "$skyjo_seen_LoadState" -eq 1 ] &&
    [ "$skyjo_seen_ActiveState" -eq 1 ] && [ "$skyjo_seen_SubState" -eq 1 ] && [ "$skyjo_seen_Result" -eq 1 ] &&
    [ "$skyjo_seen_MainPID" -eq 1 ] && [ "$skyjo_seen_ControlPID" -eq 1 ] && [ "$skyjo_seen_Job" -eq 1 ] &&
    [ "$skyjo_seen_FragmentPath" -eq 1 ] && [ "$skyjo_seen_DropInPaths" -eq 1 ] && [ "$skyjo_seen_CollectMode" -eq 1 ]
}

skyjo_probe_bootstrap_legacy_unit() {
  skyjo_probe_unit=$1
  skyjo_probe_systemctl=${2:-/usr/bin/systemctl}
  [ "$skyjo_probe_unit" = skyjo-online-legacy-proof@bootstrap-activation.service ] || return 1
  skyjo_snapshot=$("$skyjo_probe_systemctl" show --no-pager --all \
    --property=Id --property=LoadState --property=ActiveState --property=SubState \
    --property=Result --property=MainPID --property=ControlPID --property=Job \
    --property=FragmentPath --property=DropInPaths --property=CollectMode \
    "$skyjo_probe_unit") || return 1
  skyjo_parse_bootstrap_legacy_unit_snapshot "$skyjo_snapshot"
}

skyjo_bootstrap_legacy_probe_has_exact_identity() {
  [ "$skyjo_probe_Id" = skyjo-online-legacy-proof@bootstrap-activation.service ] &&
    [ "$skyjo_probe_LoadState" = loaded ] &&
    [ "$skyjo_probe_FragmentPath" = /etc/systemd/system/skyjo-online-legacy-proof@.service ] &&
    [ -z "$skyjo_probe_DropInPaths" ] &&
    [ "$skyjo_probe_CollectMode" = inactive ]
}

skyjo_bootstrap_legacy_probe_has_no_work() {
  [ "$skyjo_probe_MainPID" = 0 ] && [ "$skyjo_probe_ControlPID" = 0 ] && [ -z "$skyjo_probe_Job" ]
}

skyjo_bootstrap_legacy_probe_is_clean() {
  skyjo_bootstrap_legacy_probe_has_exact_identity && skyjo_bootstrap_legacy_probe_has_no_work &&
    [ "$skyjo_probe_ActiveState" = inactive ] && [ "$skyjo_probe_SubState" = dead ] &&
    [ "$skyjo_probe_Result" = success ]
}

skyjo_cleanup_bootstrap_legacy_unit() {
  skyjo_cleanup_unit=$1
  skyjo_cleanup_systemctl=${2:-/usr/bin/systemctl}
  skyjo_probe_bootstrap_legacy_unit "$skyjo_cleanup_unit" "$skyjo_cleanup_systemctl" || return 1
  skyjo_bootstrap_legacy_probe_is_clean && return 0
  skyjo_bootstrap_legacy_probe_has_exact_identity || return 1

  if [ "$skyjo_probe_ActiveState" = active ] || [ "$skyjo_probe_ActiveState" = activating ] ||
      [ "$skyjo_probe_ActiveState" = deactivating ] || ! skyjo_bootstrap_legacy_probe_has_no_work; then
    "$skyjo_cleanup_systemctl" stop "$skyjo_cleanup_unit" || return 1
    skyjo_probe_bootstrap_legacy_unit "$skyjo_cleanup_unit" "$skyjo_cleanup_systemctl" || return 1
    skyjo_bootstrap_legacy_probe_has_exact_identity || return 1
  fi
  if [ "$skyjo_probe_ActiveState" = failed ] && skyjo_bootstrap_legacy_probe_has_no_work; then
    "$skyjo_cleanup_systemctl" reset-failed "$skyjo_cleanup_unit" || return 1
    skyjo_probe_bootstrap_legacy_unit "$skyjo_cleanup_unit" "$skyjo_cleanup_systemctl" || return 1
  fi
  # An anomalous unit makes the proof fail even when remediation reaches the
  # exact clean state; callers can distinguish a normal first-pass success.
  skyjo_bootstrap_legacy_probe_is_clean || return 1
  return 1
}

skyjo_finalize_bootstrap_legacy_proof() {
  proof_status=$1
  unit=$2
  env_path=$3
  systemctl=$4
  remove_environment=$5
  proof_status_valid=1
  case "$proof_status" in
    ''|*[!0-9]*) proof_status_valid=0 ;;
    *) [ "$proof_status" -le 255 ] 2>/dev/null || proof_status_valid=0 ;;
  esac
  if skyjo_cleanup_bootstrap_legacy_unit "$unit" "$systemctl"; then unit_cleanup_status=0; else unit_cleanup_status=1; fi
  if "$remove_environment" "$env_path"; then environment_cleanup_status=0; else environment_cleanup_status=1; fi
  [ "$proof_status_valid" -eq 1 ] && [ "$proof_status" -eq 0 ] &&
    [ "$unit_cleanup_status" -eq 0 ] && [ "$environment_cleanup_status" -eq 0 ]
}
