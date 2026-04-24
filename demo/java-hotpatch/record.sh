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

# ── Colors ──
BOLD=$'\033[1m'
RED=$'\033[1;31m'
GREEN=$'\033[1;32m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[1;36m'
DIM=$'\033[2m'
RESET=$'\033[0m'

type_cmd() {
  local cmd="$1"
  local delay="${2:-0.01}"
  printf "${GREEN}❯${RESET} "
  for (( i=0; i<${#cmd}; i++ )); do
    printf "%s" "${cmd:$i:1}"
    sleep "$delay"
  done
  sleep 0.15
  printf "\n"
}

run() {
  local cmd="$1"
  local pause_before="${2:-0.5}"
  local pause_after="${3:-1}"
  sleep "$pause_before"
  type_cmd "$cmd"
  eval "$cmd"
  sleep "$pause_after"
}

info() {
  sleep "${2:-0.2}"
  printf "%s\n" "${CYAN}  ▸ ${RESET}$1"
  sleep "${3:-0.6}"
}

show_diff() {
  local old="$1" new="$2"
  diff -u "$old" "$new" | tail -n +3 | while IFS= read -r line; do
    case "$line" in
      @@*) ;;
      -*) printf "${RED}  - %s${RESET}\n" "${line:1}" ;;
      +*) printf "${GREEN}  + %s${RESET}\n" "${line:1}" ;;
       *) printf "${DIM}    %s${RESET}\n" "$line" ;;
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

printf "\n${BOLD}  Spring Boot pricing API has a VAT bug.${RESET}\n"
printf "  ${DIM}Let's fix it live — without restarting the JVM.${RESET}\n\n"
sleep 1.2

# 1. Show the bug
run "curl -s localhost:8080/price | python3 -m json.tool" 0.3 1
printf "\n"
info "${RED}total: 133.97${RESET} ${DIM}— expected${RESET} ${GREEN}155.96${RESET} ${DIM}= (149.97 - 20) × 1.20${RESET}" 0.1 1.2

# 2. Attach debugger to the running JVM
printf "\n"
run "dbg attach 5005 --runtime java" 0.3 0.8

# 3. Set breakpoint on the buggy line
run "dbg break $SRC:21" 0.2 0.5

# 4. Trigger a request — show it's pending
printf "\n"
info "Sending a request to hit the breakpoint..." 0.1 0.1
printf "%s\n" "${DIM}  \$ curl -s localhost:8080/price${RESET}"
curl -s localhost:8080/price > /dev/null &
CURL_PID=$!

# Spinner while waiting for breakpoint
for i in 1 2 3 4; do
  printf "\r${DIM}  ⏳ Waiting for breakpoint...${RESET}"
  sleep 0.5
done
printf "\r${GREEN}  ⏸ Breakpoint hit!              ${RESET}\n"
sleep 0.5

# 5. Show source with colors (paused at the bug)
printf "\n"
run "dbg source --lines 20" 0.2 1.8

# 6. Eval to understand the bug
run 'dbg eval "subtotal - discount + (discount * 0.20)"' 0.3 0.8
info "${RED}133.97${RESET} ${DIM}— VAT is applied to the discount, not the net amount${RESET}" 0.1 1

# 7. Test the correct formula
run 'dbg eval "(subtotal - discount) * (1 + 0.20)"' 0.3 0.8
info "${GREEN}155.96${RESET} ${DIM}— correct! Let's apply the fix:${RESET}" 0.1 1

# 8. Show the diff and apply the fix
printf "\n"
sleep 0.3
printf "${GREEN}❯${RESET} "
type_cmd "# Apply fix to source..."
show_diff "$SRC" "$SRC_FIXED"
sleep 1.5
cp "$SRC_FIXED" "$SRC"

# 9. Hotpatch the running JVM — the magic moment
printf "\n"
run "dbg hotpatch $SRC" 0.3 1.5

# 10. Remove breakpoint and continue
run "dbg break-rm BP#1" 0.2 0.2
run "dbg continue" 0.2 0.8

# 11. Verify — curl returns the fixed value
printf "\n"
info "Service is still running. Verify with a new request:" 0.3 0.5
run "curl -s localhost:8080/price | python3 -m json.tool" 0.3 1.5

printf "\n"
printf "  ${GREEN}${BOLD}✓ total: 155.96 — fixed without restarting the JVM!${RESET}\n"
printf "  ${DIM}No recompile. No redeploy. No restart.${RESET}\n\n"
sleep 2.5

# ── Cleanup ──
# Restore buggy source for next demo run
sed -i '' "s|$FIXED_LINE|$BUGGY_LINE|" "$SRC" 2>/dev/null || true
sed -i '' 's|// VAT applied to net amount (subtotal - discount)|// BUG: VAT applied to discount instead of net amount|' "$SRC" 2>/dev/null || true
