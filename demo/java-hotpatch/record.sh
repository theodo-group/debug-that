#!/bin/bash
# Demo: Java hotpatch on a Spring Boot app — fix a bug without restarting
#
# Prerequisites:
#   1. cd demo/java-hotpatch && mvn -q compile
#   2. Start Spring Boot in a separate terminal:
#      mvn spring-boot:run -Dspring-boot.run.jvmArguments="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005"
#   3. Record:
#      asciinema rec recording.cast --cols 100 --rows 35 --command "bash record.sh"
#   4. Generate GIF:
#      agg recording.cast ../../docs/java-hotpatch.gif --theme monokai --font-size 14

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="src/main/java/com/example/PricingController.java"
SRC_FIXED="src/main/java/com/example/PricingController.java.fixed"
BUGGY_LINE='subtotal - discount + (discount * VAT_RATE)'
FIXED_LINE='(subtotal - discount) * (1 + VAT_RATE)'

type_cmd() {
  local cmd="$1"
  local delay="${2:-0.02}"
  printf "\033[1;32m❯\033[0m "
  for (( i=0; i<${#cmd}; i++ )); do
    printf "%s" "${cmd:$i:1}"
    sleep "$delay"
  done
  sleep 0.3
  printf "\n"
}

run() {
  local cmd="$1"
  local pause_before="${2:-1}"
  local pause_after="${3:-2}"
  sleep "$pause_before"
  type_cmd "$cmd"
  eval "$cmd"
  sleep "$pause_after"
}

comment() {
  sleep "${2:-0.8}"
  printf "\033[1;33m# %s\033[0m\n" "$1"
  sleep "${3:-1}"
}

show_diff() {
  local old="$1" new="$2"
  diff -u "$old" "$new" | tail -n +3 | while IFS= read -r line; do
    case "$line" in
      @@*) ;;
      -*) printf "\033[1;31m  - %s\033[0m\n" "${line:1}" ;;
      +*) printf "\033[1;32m  + %s\033[0m\n" "${line:1}" ;;
       *) printf "\033[90m    %s\033[0m\n" "$line" ;;
    esac
  done
}

# ── Setup ──
cd "$SCRIPT_DIR"

# Ensure buggy source is active
sed -i '' "s|$FIXED_LINE|$BUGGY_LINE|" "$SRC" 2>/dev/null || true
sed -i '' 's|// VAT applied to net amount (subtotal - discount)|// BUG: VAT applied to discount instead of net amount|' "$SRC" 2>/dev/null || true

dbg stop 2>/dev/null
export FORCE_COLOR=1

# Verify Spring Boot is running
if ! curl -m 2 -s localhost:8080/price > /dev/null 2>&1; then
  echo "Error: Spring Boot is not running on port 8080."
  echo "Start it first: mvn spring-boot:run -Dspring-boot.run.jvmArguments=\"-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005\""
  exit 1
fi

# ── Demo starts ──

comment "Spring Boot pricing API has a VAT bug. Let's hotpatch it live." 0.2 1.5

# 1. Show the bug
run "curl -s localhost:8080/price | python3 -m json.tool" 0.5 2
comment "Total is 133.97 — expected (149.97 - 20) * 1.20 = 155.96" 0.3 1.5

# 2. Attach debugger
run "dbg attach 5005 --runtime java" 0.5 1.5

# 3. Set breakpoint on the buggy line
run "dbg break $SRC:21" 0.3 1

# 4. Trigger a request (blocks at breakpoint)
comment "Trigger a request to hit the breakpoint:" 0.3 0.8
curl -s localhost:8080/price > /dev/null &
sleep 3

# 5. Show source with colors (paused at the bug)
run "dbg source --lines 20" 0.3 2.5

# 6. Eval to understand the bug
run 'dbg eval "subtotal - discount + (discount * 0.20)"' 0.5 1.5
comment "133.97 — VAT is on the discount, not the net amount" 0.3 1.5

# 7. Test the correct formula
run 'dbg eval "(subtotal - discount) * (1 + 0.20)"' 0.5 1.5
comment "155.96 — correct! Apply the fix:" 0.3 1.5

# 8. Show the diff and apply the fix
sleep 0.5
printf "\033[1;32m❯\033[0m "
type_cmd "# Applying fix..."
show_diff "$SRC" "$SRC_FIXED"
sleep 2
cp "$SRC_FIXED" "$SRC"

# 9. Hotpatch the running JVM
run "dbg hotpatch $SRC" 0.5 2.5

# 10. Remove breakpoint and continue
run "dbg break-rm BP#1" 0.3 0.3
run "dbg continue" 0.3 1.5

# 11. Verify — curl returns the fixed value
comment "Service is still running. Verify:" 0.5 0.8
run "curl -s localhost:8080/price | python3 -m json.tool" 0.5 3

comment "155.96 — fixed without restarting the JVM!" 0.3 2

# ── Cleanup ──
# Restore buggy source for next demo run
sed -i '' "s|$FIXED_LINE|$BUGGY_LINE|" "$SRC" 2>/dev/null || true
sed -i '' 's|// VAT applied to net amount (subtotal - discount)|// BUG: VAT applied to discount instead of net amount|' "$SRC" 2>/dev/null || true
