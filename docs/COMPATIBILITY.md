# Compatibility and validation

Worklog uses three different words deliberately:

- **Supported**: the code path exists and is intended to work on that platform.
- **Built**: CI produced an installable artifact on a native runner.
- **Validated**: a person completed the workflow in a real interactive desktop session.

A successful build is not the same as end-to-end validation.

## v0.4 preview status

| Area | macOS | Windows | Linux |
| --- | --- | --- | --- |
| TypeScript, 43 unit tests, server/API/UI smoke test | Passed | Passed | Passed |
| Native CI package build | Universal DMG passed | NSIS x64 passed | AppImage/deb x64 passed |
| Package structure and public artifact type | Verified | Verified as NSIS PE executable | Verified as AppImage/deb |
| Automated package install/start/uninstall | Universal DMG build passed | NSIS install/start/health/uninstall passed on native CI | AppImage start plus deb install/uninstall passed on native CI |
| Tray/menu actions | Exercised; v0.4 regression pending | Pending | Pending |
| Login/autostart recovery | macOS service path exercised | Pending | Pending across major desktops |
| Foreground application collection | Validated | Implementation and CI compile passed; interactive validation pending | X11/KDE implementation passed CI; desktop-session validation pending |
| Feishu CLI login and document creation | Validated | End-to-end validation pending | End-to-end validation pending |
| LLM credential persistence | Keychain validated; tests never mutate a developer Keychain | DPAPI round-trip included in native CI | Secret Service/fallback round-trip included in native CI |
| Teams application-audio capture | Validated | Not supported in v0.4 | Not supported in v0.4 |

## Linux desktop notes

- X11 foreground-window collection uses `xdotool`.
- KDE Wayland foreground-window collection uses `kdotool`.
- GNOME Wayland does not expose a general active-window API; Agent logs and reports still work, but foreground-window evidence may be unavailable.
- Tray and autostart behavior must be checked separately on GNOME, KDE, and at least one Debian/Ubuntu installation.

## Before calling v0.4 stable

- install, first-run, tray, autostart, upgrade, and uninstall on a real Windows 10/11 desktop;
- complete one Feishu login and daily-report publish from Windows;
- verify DPAPI survives restart and remains scoped to the current Windows user;
- install and run both AppImage and deb on real Linux desktops;
- verify Linux Secret Service and the documented headless fallback;
- exercise X11, KDE Wayland, and GNOME Wayland behavior;
- run a macOS v0.4 upgrade regression from the existing v0.3 installation.

Until those checks are complete, Windows and Linux releases should be labeled **Preview**, not stable.
