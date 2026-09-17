#!/usr/bin/env bash
# Start the dedicated C2C browser on WSL2: Windows Edge with an isolated
# profile and a CDP endpoint (issue #9). Idempotent: if the configured
# endpoint already answers, nothing is launched.
#
# Env overrides: C2C_CDP_PORT (default 9223), C2C_EDGE_PROFILE (default
# C:\Temp\omp-c2c-edge-profile), C2C_EDGE_EXE (default msedge.exe on PATH
# via cmd.exe).
set -euo pipefail

PORT="${C2C_CDP_PORT:-9223}"
PROFILE="${C2C_EDGE_PROFILE:-C:\\Temp\\omp-c2c-edge-profile}"
EDGE_EXE="${C2C_EDGE_EXE:-/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe}"

if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "CDP endpoint already answering on 127.0.0.1:${PORT}; not launching a second instance."
  exit 0
fi

if [ ! -x "$EDGE_EXE" ]; then
  echo "Edge not found at: $EDGE_EXE"
  echo "Set C2C_EDGE_EXE to a Windows Chromium-family browser (Edge/Chrome) path."
  exit 1
fi

# Resolve the Windows-side path of the exe for cmd.exe.
WIN_EXE="$(wslpath -w "$EDGE_EXE")"

echo "Launching dedicated C2C browser: profile=$PROFILE port=$PORT"
cmd.exe /c start "" "$WIN_EXE" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  about:blank >/dev/null 2>&1

for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "CDP endpoint ready: http://127.0.0.1:${PORT}"
    echo "Record it with: c2c browser set --backend cdp --cdp-url http://127.0.0.1:${PORT} --profile-dir \"$PROFILE\""
    exit 0
  fi
  sleep 1
done

echo "Browser launched but the CDP endpoint did not answer within 20s." >&2
exit 1
