#!/bin/bash
# Show a colored inline diff between two files, with line numbers
# Usage: show-diff.sh <old-file> <new-file>

OLD="$1"
NEW="$2"

RED='\033[1;31m'
GREEN='\033[1;32m'
GRAY='\033[90m'
RESET='\033[0m'

# Get unified diff, skip header lines, show context
diff -u "$OLD" "$NEW" | tail -n +3 | while IFS= read -r line; do
  case "$line" in
    @@*)
      # Extract line number from hunk header
      ;;
    -*)
      printf "${RED}  - %s${RESET}\n" "${line:1}"
      ;;
    +*)
      printf "${GREEN}  + %s${RESET}\n" "${line:1}"
      ;;
    *)
      printf "${GRAY}    %s${RESET}\n" "$line"
      ;;
  esac
done
