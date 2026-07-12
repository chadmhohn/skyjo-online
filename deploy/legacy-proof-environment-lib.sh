#!/bin/sh

skyjo_publish_legacy_proof_environment() {
  destination=$1
  owner=$2
  group=$3
  content=$4
  expected_parent_uid=${5:-0}
  expected_parent_gid=${6:-0}
  skyjo_atomic_write_text "$destination" "$owner" "$group" 0640 "$content" false "$expected_parent_uid" "$expected_parent_gid" || return 1
}

skyjo_remove_legacy_proof_environment() {
  /usr/bin/rm -f -- "$1" || return 1
}
