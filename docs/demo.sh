#!/usr/bin/env bash
#
# Regenerates docs/demo.gif and docs/demo.cast.
#
# Everything in the recording is really executed against example/ — nothing is
# staged or faked. A tool about reproducibility should have a reproducible demo.
#
# Requires:
#   asciinema  (pip install asciinema)
#   agg        (https://github.com/asciinema/agg/releases)
#
# Usage:  bash docs/demo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

npm --prefix "$ROOT" run build >/dev/null

# Isolated copy, so the recording cannot dirty the repository.
cp -r "$ROOT/example" "$WORK/shop"
rm -rf "$WORK/shop/.repro/runs" "$WORK/shop/.repro/browser.yaml" "$WORK/shop/.repro/COMPILE.md"

mkdir -p "$WORK/bin"
printf '#!/bin/sh\nexec node %s/dist/cli.js "$@"\n' "$ROOT" > "$WORK/bin/repro"
chmod +x "$WORK/bin/repro"

cat > "$WORK/session.sh" <<'SESSION'
set -u
cd "$(dirname "$0")/shop"
export PATH="$(dirname "$0")/bin:$PATH"
export TERM=xterm-256color

prompt() {
  printf '\033[38;5;114m~/shop\033[0m \033[38;5;245m$\033[0m '
  sleep 0.35
  local text="$*"
  for ((i = 0; i < ${#text}; i++)); do
    printf '%s' "${text:$i:1}"
    sleep 0.028
  done
  printf '\n'
  sleep 0.35
}

note() {
  printf '\033[38;5;245m# %s\033[0m\n' "$*"
  sleep 1.1
}

note "a bug report, not a test case:"
note '"checkout returns 500 after changing the address and applying SAVE20"'
sleep 0.6
printf '\n'

prompt "repro run"
repro run
sleep 2.2
printf '\n'

note "how reliable is it?"
prompt "repro run --repeat 5"
repro run --repeat 5 --quiet
sleep 2.2
printf '\n'

note "12 steps came in. how many actually matter?"
prompt "repro minimize --write"
repro minimize --write --quiet
sleep 2.5
printf '\n'

note "now the agent fixes it"
prompt "\$EDITOR src/coupons.mjs"
sed -i 's/cart.snapshot.tax_region ?? null/cart.snapshot.tax_region ?? cart.tax_region/' src/coupons.mjs
printf '\033[38;5;245m   -   cart.tax_region = cart.snapshot.tax_region ?? null\033[0m\n'
printf '\033[38;5;114m   +   cart.tax_region = cart.snapshot.tax_region ?? cart.tax_region\033[0m\n'
sleep 1.8
printf '\n'

prompt "repro run --repeat 5"
repro run --repeat 5 --quiet
sleep 3.0
SESSION

asciinema rec \
  --cols 92 --rows 34 --overwrite --idle-time-limit 2 \
  --command "bash $WORK/session.sh" \
  "$ROOT/docs/demo.cast"

agg --quiet \
  --theme github-dark --font-size 15 --line-height 1.35 \
  --speed 1.4 --idle-time-limit 1 --last-frame-duration 4 --fps-cap 20 \
  "$ROOT/docs/demo.cast" "$ROOT/docs/demo.gif"

echo "wrote docs/demo.cast and docs/demo.gif"
