#!/bin/sh

skyjo_run_activation_transaction() {
  recovery_step=$1
  shift
  for activation_step in "$@"; do
    if ! "$activation_step"; then
      "$recovery_step" || return 125
      return 1
    fi
  done
  return 0
}
