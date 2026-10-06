import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canQueryMediaAccess,
  chromeWindowExtras,
  clampHud,
  defaultAudioSource,
  isWaylandSession,
  loopbackAudio,
  screenCaptureMode,
  shouldRelaunchUnderXWayland,
  systemAudioSupported,
  loopbackDeniedCopy,
  mediaIsBlocked,
  overlayWindowExtras,
  permissionIntro,
  preferenceUrls,
} from "./compat";
import {
  DEFAULT_SHORTCUTS,
  eventToAccelerator,
  formatAccelerator,
  mergeSettings,
  shortcutConflict,
} from "./settings";

test("Mac overlay uses a panel; Windows and Linux do not", () => {
  const mac = overlayWindowExtras("darwin");
  assert.equal(mac.type, "panel");
  assert.equal(mac.hiddenInMissionControl, true);
  assert.deepEqual(overlayWindowExtras("win32"), {});
  assert.deepEqual(overlayWindowExtras("linux"), {});
});

test("Settings chrome leaves space for traffic lights only on Mac", () => {
  const mac = chromeWindowExtras("darwin");
  assert.equal(mac.titleBarStyle, "hiddenInset");
  assert.deepEqual(mac.trafficLightPosition, { x: 14, y: 16 });
  assert.equal(chromeWindowExtras("win32").autoHideMenuBar, true);
  assert.equal(chromeWindowExtras("linux").autoHideMenuBar, true);
  assert.equal("trafficLightPosition" in chromeWindowExtras("win32"), false);
});

test("preference URLs match the host OS", () => {
  assert.match(preferenceUrls("darwin", "mic")[0], /x-apple\.systempreferences/);
  assert.match(preferenceUrls("darwin", "screen")[0], /ScreenCapture/);
  assert.equal(preferenceUrls("win32", "mic")[0], "ms-settings:privacy-microphone");
  assert.ok(preferenceUrls("win32", "screen").some((url) => url.includes("graphicscapture")));
  assert.deepEqual(preferenceUrls("linux", "mic"), []);
  assert.deepEqual(preferenceUrls("linux", "screen"), []);
});

test("media access is only queried where the OS API exists", () => {
  assert.equal(canQueryMediaAccess("darwin", "microphone"), true);
  assert.equal(canQueryMediaAccess("darwin", "screen"), true);
  assert.equal(canQueryMediaAccess("win32", "microphone"), true);
  assert.equal(canQueryMediaAccess("win32", "screen"), false);
  assert.equal(canQueryMediaAccess("linux", "microphone"), false);
  assert.equal(canQueryMediaAccess("linux", "screen"), false);
  assert.equal(mediaIsBlocked("denied"), true);
  assert.equal(mediaIsBlocked("restricted"), true);
  assert.equal(mediaIsBlocked("unknown"), false);
  assert.equal(mediaIsBlocked("granted"), false);
});

test("loopback audio is skipped on Linux", () => {
  assert.equal(loopbackAudio("darwin"), "loopback");
  assert.equal(loopbackAudio("win32"), "loopback");
  assert.equal(loopbackAudio("linux"), undefined);
});

test("HUD stays inside work areas, including negative Windows coords", () => {
  const left = clampHud(-3000, 40, { width: 380, height: 72 }, {
    x: -1920,
    y: 0,
    width: 1920,
    height: 1080,
  });
  assert.equal(left.x, -1920);
  assert.equal(left.y, 40);

  const right = clampHud(4000, 4000, { width: 380, height: 72 }, {
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
  });
  assert.equal(right.x, 1440 - 380);
  assert.equal(right.y, 900 - 72);

  const tiny = clampHud(0, 0, { width: 380, height: 460 }, {
    x: 0,
    y: 0,
    width: 320,
    height: 200,
  });
  assert.equal(tiny.x, 0);
  assert.equal(tiny.y, 0);
});

test("onboarding copy is not macOS-only", () => {
  assert.match(permissionIntro("darwin"), /macOS/);
  assert.match(permissionIntro("win32"), /Windows/);
  assert.match(permissionIntro("linux"), /Linux/);
  assert.match(loopbackDeniedCopy("linux"), /microphone/i);
});

test("shortcut labels use ⌘ on Mac and Ctrl elsewhere", () => {
  const chord = "CommandOrControl+Shift+H";
  assert.equal(formatAccelerator(chord, "darwin"), "⌘⇧H");
  assert.equal(formatAccelerator(chord, "win32"), "Ctrl+Shift+H");
  assert.equal(formatAccelerator(chord, "linux"), "Ctrl+Shift+H");
  assert.equal(formatAccelerator("CommandOrControl+Enter", "win32"), "Ctrl+Enter");
  assert.equal(formatAccelerator("CommandOrControl+\\", "linux"), "Ctrl+\\");
});

test("keyboard capture maps modifiers the same on each OS", () => {
  const mac = eventToAccelerator({
    key: "Enter",
    code: "Enter",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  } as KeyboardEvent);
  const win = eventToAccelerator({
    key: "Enter",
    code: "Enter",
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
  } as KeyboardEvent);
  assert.equal(mac, "CommandOrControl+Enter");
  assert.equal(win, "CommandOrControl+Enter");
});

test("mergeSettings remaps the old screen chord and keeps defaults", () => {
  const next = mergeSettings({
    shortcuts: { screen: "CommandOrControl+Shift+Enter" },
    look: { opacity: 40, shareVisible: true },
  });
  assert.equal(next.shortcuts.screen, DEFAULT_SHORTCUTS.screen);
  assert.equal(next.shortcuts.assist, DEFAULT_SHORTCUTS.assist);
  assert.equal(next.look.opacity, 40);
  assert.equal(next.look.shareVisible, true);
});

test("shortcut conflicts are detected", () => {
  assert.equal(
    shortcutConflict(DEFAULT_SHORTCUTS, "assist", DEFAULT_SHORTCUTS.hide),
    "hide",
  );
  assert.equal(shortcutConflict(DEFAULT_SHORTCUTS, "assist", DEFAULT_SHORTCUTS.assist), null);
});

test("pack targets cover Intel Mac, Apple silicon, Windows, and Linux", () => {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
  ) as {
    build: {
      mac: { target: { target: string; arch: string[] }[]; extendInfo: Record<string, string> };
      win: { target: { target: string; arch: string[] }[] };
      linux: { target: { target: string; arch: string[] }[] };
      toolsets?: { appimage?: string };
    };
    desktopName?: string;
  };
  const macArch = pkg.build.mac.target.flatMap((item) => item.arch);
  assert.ok(macArch.includes("x64"));
  assert.ok(macArch.includes("arm64"));
  assert.ok(pkg.build.mac.extendInfo.NSScreenCaptureUsageDescription);
  assert.ok(pkg.build.win.target.some((item) => item.target === "nsis" && item.arch.includes("x64")));
  for (const kind of ["AppImage", "deb", "tar.gz"]) {
    const target = pkg.build.linux.target.find((item) => item.target === kind);
    assert.deepEqual(target?.arch, ["x64", "arm64"], kind);
  }
  assert.equal(pkg.build.toolsets?.appimage, "1.0.2", "static AppImage runtime: no libfuse2, sandbox auto-detect");
  assert.equal(pkg.desktopName, "bana-copilot.desktop");
});

test("system audio only defaults on where Chromium can capture it", () => {
  assert.equal(defaultAudioSource("darwin", "15.3.1"), "system");
  assert.equal(defaultAudioSource("darwin", "13.2"), "system");
  assert.equal(defaultAudioSource("darwin", "13.1.1"), "mic");
  assert.equal(defaultAudioSource("darwin", "12.7.6"), "mic");
  assert.equal(defaultAudioSource("win32", "10.0.22631"), "system");
  assert.equal(defaultAudioSource("linux", "6.8.0"), "mic");
  assert.equal(systemAudioSupported("darwin", "26.0"), true);
});

test("Wayland runs under XWayland when available and uses one capture stream", () => {
  const wayland = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" };
  assert.equal(isWaylandSession("linux", wayland), true);
  assert.equal(isWaylandSession("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }), false);
  assert.equal(isWaylandSession("darwin", wayland), false);
  assert.equal(shouldRelaunchUnderXWayland("linux", wayland, ["bana-copilot"]), true);
  assert.equal(shouldRelaunchUnderXWayland("linux", wayland, ["bana-copilot", "--ozone-platform=x11"]), false);
  assert.equal(shouldRelaunchUnderXWayland("linux", { ...wayland, DISPLAY: undefined }, ["bana-copilot"]), false);
  assert.equal(shouldRelaunchUnderXWayland("linux", { ...wayland, BANA_WAYLAND: "native" }, ["bana-copilot"]), false);
  assert.equal(shouldRelaunchUnderXWayland("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, ["bana-copilot"]), false);
  assert.equal(screenCaptureMode("linux", wayland), "stream");
  assert.equal(screenCaptureMode("linux", { XDG_SESSION_TYPE: "x11" }), "poll");
  assert.equal(screenCaptureMode("darwin", {}), "poll");
});
