#!/usr/bin/env bash
set -euo pipefail

appimage="$(find release/desktop -maxdepth 1 -name 'Worklog-*-Linux-x86_64.AppImage' -print -quit)"
deb="$(find release/desktop -maxdepth 1 -name 'Worklog-*-Linux-amd64.deb' -print -quit)"
[[ -n "$appimage" && -n "$deb" ]]

chmod +x "$appimage"
work="${RUNNER_TEMP:-/tmp}/worklog-appimage-smoke"
mkdir -p "$work"
(cd "$work" && "$OLDPWD/$appimage" --appimage-extract >/dev/null)

export WORKLOG_PORT=4429
export WORKLOG_DATA_DIR="$work/data"
export WORKLOG_DISABLE_BACKGROUND=1
xvfb-run -a "$work/squashfs-root/worklog" --hidden >"$work/app.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
ready=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:4429/api/status" | grep -q '"platform":"linux"'; then ready=1; break; fi
  sleep 0.5
done
[[ "$ready" == 1 ]] || { cat "$work/app.log"; exit 1; }
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
trap - EXIT
echo "✓ Linux AppImage extracted and started under Xvfb"

dpkg-deb --info "$deb" >/dev/null
sudo apt-get install -y "$PWD/$deb"
test -x /opt/Worklog/worklog
sudo apt-get remove -y worklog
echo "✓ Linux deb install/uninstall acceptance"
