#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/roomhacker/apps/vpn-panel
RECEIPT_ID=smart-edge-go-20260803-r5
RECEIPT=/var/backups/vpn-panel/smart-edge/$RECEIPT_ID
CANDIDATE=$ROOT/trash/logs/smart-edge-go-20260803/smart-edge
UNIT=$ROOT/infra/smart-edge/smart-edge.service
EXPECTED_SHA=1e7ddf3328fbaab11e2c7b3a694eb4ac00fafa33fb5c5d9824e3434cb5b9e5c0
EXPECTED_UNIT_SHA=1922ab6f0ea17b9b6c264a40efffe1308cc1691615955b2efe7af0ba7884561b
MAX_CPU_MEAN=25
CONTROLLED_LOAD_REQUESTS=100
CONTROLLED_LOAD_CONCURRENCY=20

ssh_args() {
  case "$1" in
    vpn2) printf '%s\n' -o BatchMode=yes root@vpn2.bezrabotnyi.com ;;
    vusa) printf '%s\n' -o BatchMode=yes -i /home/roomhacker/.ssh/id_rsa root@185.240.120.152 ;;
    *) return 2 ;;
  esac
}

scp_args() {
  case "$1" in
    vpn2) printf '%s\n' -q -o BatchMode=yes ;;
    vusa) printf '%s\n' -q -o BatchMode=yes -i /home/roomhacker/.ssh/id_rsa ;;
    *) return 2 ;;
  esac
}

remote_target() {
  case "$1" in
    vpn2) printf '%s\n' root@vpn2.bezrabotnyi.com ;;
    vusa) printf '%s\n' root@185.240.120.152 ;;
    *) return 2 ;;
  esac
}

remote() {
  local id=$1 command=$2
  mapfile -t args < <(ssh_args "$id")
  ssh "${args[@]}" "$command"
}

copy_candidate() {
  local id=$1 target
  target=$(remote_target "$id")
  mapfile -t args < <(scp_args "$id")
  scp "${args[@]}" "$CANDIDATE" "$target:/tmp/$RECEIPT_ID.bin"
  scp "${args[@]}" "$UNIT" "$target:/tmp/$RECEIPT_ID.service"
}

preview_one() {
  local id=$1
  remote "$id" "set -eu
test ! -e '$RECEIPT'
test \"\$(uname -m)\" = x86_64
systemctl is-active --quiet smart-edge.service
test \"\$(systemctl show -p MainPID --value smart-edge.service)\" -gt 0
ss -Hln sport = :9443 | grep -q .
printf 'target=$id runtime='
readlink -f /proc/\$(systemctl show -p MainPID --value smart-edge.service)/exe
printf 'unit_sha='
sha256sum /etc/systemd/system/smart-edge.service | cut -d' ' -f1
printf 'python_sha='
sha256sum /opt/smart-edge/smart-edge.py | cut -d' ' -f1"
}

apply_one() {
  local id=$1
  copy_candidate "$id"
  remote "$id" "set -euo pipefail
receipt='$RECEIPT'
pending=\"\$receipt.pending\"
test ! -e \"\$receipt\"
test ! -e \"\$pending\"
test \"\$(sha256sum /tmp/$RECEIPT_ID.bin | cut -d' ' -f1)\" = '$EXPECTED_SHA'
test \"\$(sha256sum /tmp/$RECEIPT_ID.service | cut -d' ' -f1)\" = '$EXPECTED_UNIT_SHA'
install -d -m 0700 \"\$pending\"
cp -a /etc/systemd/system/smart-edge.service \"\$pending/service.before\"
if test -e /usr/local/bin/smart-edge; then
  cp -a /usr/local/bin/smart-edge \"\$pending/binary.before\"
  printf 'yes\n' >\"\$pending/binary_existed\"
else
  printf 'no\n' >\"\$pending/binary_existed\"
fi
systemctl is-enabled smart-edge.service >\"\$pending/enabled.before\" 2>/dev/null || true
readlink -f /proc/\$(systemctl show -p MainPID --value smart-edge.service)/exe | sed 's/ (deleted)$//' >\"\$pending/runtime.before\"
printf 'prepared\n' >\"\$pending/state\"
sample_cpu() {
  sample_pid=\$1
  sample_out=\$2
  hz=\$(getconf CLK_TCK)
  set -- \$(cat /proc/\$sample_pid/stat)
  previous=\$((\${14}+\${15}))
  : >\"\$sample_out\"
  for sample_index in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    set -- \$(cat /proc/\$sample_pid/stat)
    current=\$((\${14}+\${15}))
    cpu_pct=\$(((current-previous)*100/hz))
    printf '%s\t%s\t%s\n' \"\$(date -Is)\" \"\$sample_pid\" \"\$cpu_pct\" >>\"\$sample_out\"
    previous=\$current
  done
}
mean_cpu() {
  awk '{sum += \$3} END {if (NR == 0) exit 1; printf \"%.1f\", sum / NR}' \"\$1\"
}
run_controlled_load() {
  controlled_output=\$1
  : >\"\$controlled_output\"
  for controlled_index in \$(seq 1 '$CONTROLLED_LOAD_REQUESTS'); do
    while test \"\$(jobs -pr | wc -l)\" -ge '$CONTROLLED_LOAD_CONCURRENCY'; do
      wait -n || true
    done
    (
      controlled_code=\$(curl --noproxy '*' -4 -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 12 --resolve example.com:443:127.0.0.1 https://example.com/) || controlled_code=000
      printf '%s\n' \"\$controlled_code\" >>\"\$controlled_output\"
    ) &
    if test \"\$((controlled_index % 10))\" = 0; then sleep 1; fi
  done
  wait
}
controlled_ok_count() {
  grep -c '^200$' \"\$1\" || true
}
rollback_pending() {
  set +e
  cp -a \"\$pending/service.before\" /etc/systemd/system/smart-edge.service
  if grep -qx yes \"\$pending/binary_existed\"; then
    cp -a \"\$pending/binary.before\" /usr/local/bin/smart-edge
  else
    rm -f /usr/local/bin/smart-edge
  fi
  systemctl daemon-reload
  systemctl restart smart-edge.service
}
fail_and_rollback() {
  failure_status=\$1
  failure_line=\$2
  failure_command=\$3
  trap - ERR HUP INT TERM
  printf 'status=%s\nline=%s\ncommand=%s\n' \"\$failure_status\" \"\$failure_line\" \"\$failure_command\" >\"\$pending/failure.status\"
  rollback_pending
  exit \"\$failure_status\"
}
trap 'fail_and_rollback \"\$?\" \"\$LINENO\" \"\$BASH_COMMAND\"' ERR
trap 'trap - ERR HUP INT TERM; rollback_pending; exit 130' HUP INT TERM
before_pid=\$(systemctl show -p MainPID --value smart-edge.service)
sample_cpu \"\$before_pid\" \"\$pending/cpu.before.tsv\"
before_mean=\$(mean_cpu \"\$pending/cpu.before.tsv\")
printf '%s\n' \"\$before_mean\" >\"\$pending/cpu.before.mean\"
journalctl -u smart-edge.service --since '60 seconds ago' -o cat --no-pager | grep -c ' connect ' >\"\$pending/connect.before.60s\" || true
controlled_before_ok=0
controlled_after_ok=0
if awk -v before=\"\$before_mean\" 'BEGIN { exit !(before <= 5) }'; then
  traffic_mode=low-load
  https_attempts=20
  https_required=20
  comparison_before_mean=\$before_mean
else
  traffic_mode=loaded
  https_attempts=3
  https_required=2
  run_controlled_load \"\$pending/controlled.before.codes\" &
  controlled_load_pid=\$!
  sample_cpu \"\$before_pid\" \"\$pending/cpu.controlled.before.tsv\"
  wait \"\$controlled_load_pid\"
  controlled_before_ok=\$(controlled_ok_count \"\$pending/controlled.before.codes\")
  printf '%s\n' \"\$controlled_before_ok\" >\"\$pending/controlled.before.ok\"
  test \"\$controlled_before_ok\" = '$CONTROLLED_LOAD_REQUESTS'
  comparison_before_mean=\$(mean_cpu \"\$pending/cpu.controlled.before.tsv\")
  printf '%s\n' \"\$comparison_before_mean\" >\"\$pending/cpu.controlled.before.mean\"
fi
install -m 0755 /tmp/$RECEIPT_ID.bin /usr/local/bin/smart-edge
install -m 0644 /tmp/$RECEIPT_ID.service /etc/systemd/system/smart-edge.service
test \"\$(sha256sum /usr/local/bin/smart-edge | cut -d' ' -f1)\" = '$EXPECTED_SHA'
test -x /usr/local/bin/smart-edge
systemctl daemon-reload
journal_cursor=\$(journalctl -u smart-edge.service -n 0 --show-cursor --no-pager | sed -n 's/^-- cursor: //p')
test -n \"\$journal_cursor\"
systemctl restart smart-edge.service
runtime_ready=0
pid=0
for runtime_wait_index in \$(seq 1 40); do
  if systemctl is-active --quiet smart-edge.service; then
    pid=\$(systemctl show -p MainPID --value smart-edge.service)
    if test \"\$pid\" -gt 0 && test \"\$(readlink -f /proc/\$pid/exe 2>/dev/null || true)\" = /usr/local/bin/smart-edge; then
      runtime_ready=1
      break
    fi
  fi
  sleep 0.25
done
test \"\$runtime_ready\" = 1
test \"\$(ps -o user= -p \$pid | xargs)\" = nobody
ss -Hln sport = :9443 | grep -q .
connect_before=\$(cat \"\$pending/connect.before.60s\")
test \"\$connect_before\" -ge 0
https_ok=0
for canary_index in \$(seq 1 \"\$https_attempts\"); do
  code=\$(curl --noproxy '*' -4 -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 12 --resolve example.com:443:127.0.0.1 https://example.com/) || code=000
  if test \"\$code\" = 200; then https_ok=\$((https_ok + 1)); fi
done
test \"\$https_ok\" -ge \"\$https_required\"
wait_for_stats_line() {
  previous_count=\$1
  for wait_index in \$(seq 1 70); do
    current_count=\$(journalctl -u smart-edge.service --after-cursor \"\$journal_cursor\" -o cat --no-pager | grep -c ' stats ' || true)
    if test \"\$current_count\" -gt \"\$previous_count\"; then
      journalctl -u smart-edge.service --after-cursor \"\$journal_cursor\" -o cat --no-pager | grep ' stats ' | tail -1
      return 0
    fi
    sleep 1
  done
  return 1
}
validate_stats_line() {
  stats_line=\$1
  output_path=\$2
  minimum_proxied=\$3
  printf '%s\n' \"\$stats_line\" >\"\$output_path\"
  accepted_value=\$(printf '%s\n' \"\$stats_line\" | sed -n 's/.*accepted=\([0-9][0-9]*\).*/\1/p')
  proxied_value=\$(printf '%s\n' \"\$stats_line\" | sed -n 's/.*proxied=\([0-9][0-9]*\).*/\1/p')
  rejected_value=\$(printf '%s\n' \"\$stats_line\" | sed -n 's/.*rejected=\([0-9][0-9]*\).*/\1/p')
  error_value=\$(printf '%s\n' \"\$stats_line\" | sed -n 's/.*errors=\([0-9][0-9]*\).*/\1/p')
  test -n \"\$accepted_value\"
  test -n \"\$proxied_value\"
  test -n \"\$rejected_value\"
  test -n \"\$error_value\"
  test \"\$accepted_value\" -gt 0
  test \"\$proxied_value\" -ge \"\$minimum_proxied\"
  test \"\$(((rejected_value + error_value) * 100))\" -le \"\$((accepted_value * 5))\"
}
if test \"\$traffic_mode\" = low-load; then
  low_load_stats=\$(wait_for_stats_line 0)
  validate_stats_line \"\$low_load_stats\" \"\$pending/stats.low-load\" \"\$https_required\"
  sample_cpu \"\$pid\" \"\$pending/cpu.after.tsv\"
  after_mean=\$(mean_cpu \"\$pending/cpu.after.tsv\")
  printf '%s\n' \"\$after_mean\" >\"\$pending/cpu.after.mean\"
  awk -v after=\"\$after_mean\" 'BEGIN { exit !(after <= 5) }'
  proxied=\$(printf '%s\n' \"\$low_load_stats\" | sed -n 's/.*proxied=\([0-9][0-9]*\).*/\1/p')
else
  run_controlled_load \"\$pending/controlled.after.codes\" &
  controlled_load_pid=\$!
  sample_cpu \"\$pid\" \"\$pending/cpu.after.tsv\"
  wait \"\$controlled_load_pid\"
  controlled_after_ok=\$(controlled_ok_count \"\$pending/controlled.after.codes\")
  printf '%s\n' \"\$controlled_after_ok\" >\"\$pending/controlled.after.ok\"
  test \"\$controlled_after_ok\" = '$CONTROLLED_LOAD_REQUESTS'
  after_mean=\$(mean_cpu \"\$pending/cpu.after.tsv\")
  printf '%s\n' \"\$after_mean\" >\"\$pending/cpu.after.mean\"
  controlled_stats=\$(wait_for_stats_line 0)
  validate_stats_line \"\$controlled_stats\" \"\$pending/stats.controlled\" \"\$controlled_after_ok\"
  proxied=\$(printf '%s\n' \"\$controlled_stats\" | sed -n 's/.*proxied=\([0-9][0-9]*\).*/\1/p')
  awk -v before=\"\$comparison_before_mean\" -v after=\"\$after_mean\" -v max='$MAX_CPU_MEAN' 'BEGIN { exit !(after <= max && after * 2 <= before) }'
fi
printf 'traffic_mode=%s\nhttps_ok=%s\nhttps_attempts=%s\nbefore_cpu_mean=%s\ncomparison_before_cpu_mean=%s\nafter_cpu_mean=%s\nconnect_before_60s=%s\ncontrolled_before_ok=%s\ncontrolled_after_ok=%s\nproxied_after_60s=%s\n' \"\$traffic_mode\" \"\$https_ok\" \"\$https_attempts\" \"\$before_mean\" \"\$comparison_before_mean\" \"\$after_mean\" \"\$connect_before\" \"\$controlled_before_ok\" \"\$controlled_after_ok\" \"\$proxied\" >\"\$pending/canary\"
printf 'applied\n' >\"\$pending/state\"
trap - ERR HUP INT TERM
mv \"\$pending\" \"\$receipt\"
printf 'target=$id cutover=ok mode=%s https_ok=%s/%s before_cpu=%s comparison_before_cpu=%s after_cpu=%s controlled_before=%s controlled_after=%s proxied_after=%s runtime=' \"\$traffic_mode\" \"\$https_ok\" \"\$https_attempts\" \"\$before_mean\" \"\$comparison_before_mean\" \"\$after_mean\" \"\$controlled_before_ok\" \"\$controlled_after_ok\" \"\$proxied\"
readlink -f /proc/\$pid/exe"
}

rollback_one() {
  local id=$1
  remote "$id" "set -euo pipefail
receipt='$RECEIPT'
if test -d \"\$receipt\"; then
  source_receipt=\"\$receipt\"
elif test -d \"\$receipt.pending\"; then
  source_receipt=\"\$receipt.pending\"
else
  exit 3
fi
cp -a \"\$source_receipt/service.before\" /etc/systemd/system/smart-edge.service
if grep -qx yes \"\$source_receipt/binary_existed\"; then
  cp -a \"\$source_receipt/binary.before\" /usr/local/bin/smart-edge
else
  rm -f /usr/local/bin/smart-edge
fi
systemctl daemon-reload
systemctl restart smart-edge.service
systemctl is-active --quiet smart-edge.service
pid=\$(systemctl show -p MainPID --value smart-edge.service)
test \"\$(readlink -f /proc/\$pid/exe | sed 's/ (deleted)$//')\" = \"\$(cat \"\$source_receipt/runtime.before\")\"
ss -Hln sport = :9443 | grep -q .
code=\$(curl --noproxy '*' -4 -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 12 --resolve example.com:443:127.0.0.1 https://example.com/)
test \"\$code\" = 200
printf 'rolled-back\n' >\"\$source_receipt/state\"
printf 'target=$id rollback=ok http=%s runtime=' \"\$code\"
readlink -f /proc/\$pid/exe"
}

receipt_probe() {
  local id=$1
  remote "$id" "if test -d '$RECEIPT' -o -d '$RECEIPT.pending'; then exit 0; else exit 3; fi"
}

rollback_if_exists() {
  local id=$1 probe_status
  if receipt_probe "$id"; then
    rollback_one "$id"
    return
  else
    probe_status=$?
  fi
  if test "$probe_status" = 3; then
    return 0
  fi
  return "$probe_status"
}

completed=1
rollback_all() {
  local aggregate_status=0 current_status
  rollback_if_exists vpn2 || aggregate_status=$?
  if rollback_if_exists vusa; then
    :
  else
    current_status=$?
    if test "$aggregate_status" = 0; then aggregate_status=$current_status; fi
  fi
  return "$aggregate_status"
}

rollback_partial_on_exit() {
  status=$?
  if test "$completed" = 0; then
    rollback_all || true
  fi
  return "$status"
}

case "${1:-}" in
  preview)
    test "$(sha256sum "$CANDIDATE" | cut -d' ' -f1)" = "$EXPECTED_SHA"
    test "$(sha256sum "$UNIT" | cut -d' ' -f1)" = "$EXPECTED_UNIT_SHA"
    grep -Fxq 'ExecStart=/usr/local/bin/smart-edge' "$UNIT"
    preview_one vusa
    preview_one vpn2
    ;;
  apply)
    completed=0
    trap rollback_partial_on_exit EXIT
    trap 'exit 130' INT TERM
    apply_one vusa
    apply_one vpn2
    completed=1
    trap - EXIT INT TERM
    ;;
  rollback)
    rollback_all
    ;;
  selftest)
    completed=0
    probe_order=''
    receipt_probe() { probe_order="${probe_order}${probe_order:+ }$1"; return 3; }
    rollback_partial_on_exit
    test "$probe_order" = 'vpn2 vusa'
    receipt_probe() { return 255; }
    if rollback_if_exists vpn2; then
      echo 'transport failure was incorrectly treated as receipt absence' >&2
      exit 1
    else
      test "$?" = 255
    fi
    receipt_probe() { return 3; }
    rollback_if_exists vpn2
    restored=''
    receipt_probe() { return 0; }
    rollback_one() { restored=$1; }
    rollback_if_exists vusa
    test "$restored" = vusa
    restored=''
    receipt_probe() { if test "$1" = vpn2; then return 255; else return 0; fi; }
    if rollback_all; then
      echo 'aggregate rollback masked vpn2 transport failure' >&2
      exit 1
    else
      test "$?" = 255
    fi
    test "$restored" = vusa
    controlled_ok=99
    if test "$controlled_ok" = "$CONTROLLED_LOAD_REQUESTS"; then
      echo 'controlled load accounting admitted 99/100' >&2
      exit 1
    fi
    controlled_ok=100
    test "$controlled_ok" = "$CONTROLLED_LOAD_REQUESTS"
    printf 'partial rollback self-test passed\n'
    printf 'controlled load accounting self-test passed\n'
    ;;
  *)
    echo "usage: $0 preview|apply|rollback" >&2
    exit 2
    ;;
esac
