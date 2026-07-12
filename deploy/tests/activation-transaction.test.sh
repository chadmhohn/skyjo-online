#!/usr/bin/env bash
set -Eeuo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$script_dir/activation-transaction-lib.sh"

steps=(stop state unit daemon start health proof)
for failed_index in "${!steps[@]}"; do
  log=''
  recovery() { log+=" recover"; }
  for index in "${!steps[@]}"; do
    eval "step_$index() { log+=' ${steps[$index]}'; [ $index -ne $failed_index ]; }"
  done
  callbacks=()
  for index in "${!steps[@]}"; do callbacks+=("step_$index"); done
  if skyjo_run_activation_transaction recovery "${callbacks[@]}"; then
    printf 'Activation transaction accepted failure at %s.\n' "${steps[$failed_index]}" >&2
    exit 1
  fi
  expected=''
  for ((index=0; index<=failed_index; index++)); do expected+=" ${steps[$index]}"; done
  expected+=' recover'
  [ "$log" = "$expected" ] || { printf 'Wrong recovery trace: %s != %s\n' "$log" "$expected" >&2; exit 1; }
done

log=''
recovery() { log+=' recover'; }
for index in "${!steps[@]}"; do eval "step_$index() { log+=' ${steps[$index]}'; }"; done
callbacks=()
for index in "${!steps[@]}"; do callbacks+=("step_$index"); done
skyjo_run_activation_transaction recovery "${callbacks[@]}"
[[ "$log" != *recover* ]]

recovery() { return 1; }
step_0() { return 1; }
set +e
skyjo_run_activation_transaction recovery step_0
status=$?
set -e
[ "$status" -eq 125 ]

log=''
persistent_stop_recovery() { log+=' recovery-stop-failed'; return 1; }
initial_stop_failure() { log+=' initial-stop-failed'; return 1; }
set +e
skyjo_run_activation_transaction persistent_stop_recovery initial_stop_failure
status=$?
set -e
[ "$status" -eq 125 ]
[ "$log" = ' initial-stop-failed recovery-stop-failed' ]

resume_steps=(stop state reload start health proof)
for failed_index in "${!resume_steps[@]}"; do
  log=''
  recovery() { log+=" recover"; }
  for index in "${!resume_steps[@]}"; do
    eval "resume_$index() { log+=' ${resume_steps[$index]}'; [ $index -ne $failed_index ]; }"
  done
  callbacks=()
  for index in "${!resume_steps[@]}"; do callbacks+=("resume_$index"); done
  if skyjo_run_activation_transaction recovery "${callbacks[@]}"; then
    printf 'Interrupted activation resume accepted failure at %s.\n' "${resume_steps[$failed_index]}" >&2
    exit 1
  fi
  [[ "$log" == *recover ]]
done
printf '%s\n' 'activation boundary failure matrix passed'
