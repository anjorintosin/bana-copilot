/** Pure helpers so HUD / Settings / pack behave the same on Intel Mac, Windows, and Linux. */

export type HostPlatform = NodeJS.Platform | string;
export type PrefKind = "mic" | "screen";
export type MediaKind = "microphone" | "screen";

export function overlayWindowExtras(platform: HostPlatform) {
  if (platform === "darwin") {
    return {
      hiddenInMissionControl: true,
      type: "panel" as const,
      titleBarStyle: "hidden" as const,
    };
  }
  return {};
}

export function chromeWindowExtras(platform: HostPlatform) {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 14, y: 16 },
    };
  }
  return { autoHideMenuBar: true as const };
}

export function preferenceUrls(platform: HostPlatform, kind: PrefKind): string[] {
  if (platform === "darwin") {
    return kind === "mic"
      ? [
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
          "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone",
        ]
      : [
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
          "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
        ];
  }
  if (platform === "win32") {
    return kind === "mic"
      ? ["ms-settings:privacy-microphone"]
      : ["ms-settings:privacy-graphicscapture", "ms-settings:privacy-webcam"];
  }
  return [];
}

export function canQueryMediaAccess(platform: HostPlatform, kind: MediaKind) {
  if (platform === "darwin") return true;
  if (platform === "win32" && kind === "microphone") return true;
  return false;
}

export function mediaIsBlocked(status: string) {
  return status === "denied" || status === "restricted";
}

/** Chromium loopback audio exists on macOS and Windows, not typical Linux. */
export function loopbackAudio(platform: HostPlatform): "loopback" | undefined {
  return platform === "linux" ? undefined : "loopback";
}

type Env = Record<string, string | undefined>;

export function isWaylandSession(platform: HostPlatform, env: Env) {
  return platform === "linux" && (env.XDG_SESSION_TYPE === "wayland" || Boolean(env.WAYLAND_DISPLAY));
}

/**
 * Native Wayland will not let a window place itself or stay above others, which an overlay
 * needs, so run under XWayland when it is there. Ozone is chosen before main.js runs, so
 * this has to be a relaunch flag. BANA_WAYLAND=native keeps native Wayland.
 */
export function shouldRelaunchUnderXWayland(platform: HostPlatform, env: Env, argv: string[]) {
  if (!isWaylandSession(platform, env)) return false;
  if (!env.DISPLAY || env.BANA_WAYLAND === "native") return false;
  return !argv.some((arg) => arg.startsWith("--ozone-platform"));
}

/** On Wayland every desktopCapturer call opens the portal picker, so keep one stream open instead. */
export function screenCaptureMode(platform: HostPlatform, env: Env): "poll" | "stream" {
  if (env.BANA_SCREEN_CAPTURE === "stream" || env.BANA_SCREEN_CAPTURE === "poll") return env.BANA_SCREEN_CAPTURE;
  return isWaylandSession(platform, env) ? "stream" : "poll";
}

function versionAtLeast(version: string, major: number, minor = 0) {
  const [maj = 0, min = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return maj > major || (maj === major && min >= minor);
}

/** System (loopback) audio: Windows, and macOS 13.2+. Linux and older macOS use the mic. */
export function systemAudioSupported(platform: HostPlatform, osVersion: string) {
  if (platform === "win32") return true;
  if (platform === "darwin") return versionAtLeast(osVersion, 13, 2);
  return false;
}

export function defaultAudioSource(platform: HostPlatform, osVersion: string): "system" | "mic" {
  return systemAudioSupported(platform, osVersion) ? "system" : "mic";
}

export function clampHud(
  x: number,
  y: number,
  size: { width: number; height: number },
  area: { x: number; y: number; width: number; height: number },
) {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const maxX = area.x + Math.max(0, area.width - width);
  const maxY = area.y + Math.max(0, area.height - height);
  return {
    x: Math.round(Math.min(Math.max(x, area.x), maxX)),
    y: Math.round(Math.min(Math.max(y, area.y), maxY)),
  };
}

export function permissionIntro(platform: HostPlatform) {
  if (platform === "darwin") {
    return "macOS will ask for everything Bana Copilot needs. Allow each prompt once — you should not see them again.";
  }
  if (platform === "win32") {
    return "Windows will ask for microphone and screen capture. Allow each prompt once. Meeting audio uses system loopback when available.";
  }
  return "Allow microphone and screen capture when prompted. On Linux, Listen uses your microphone, and on Wayland the system asks once per session which screen to share.";
}

export function loopbackDeniedCopy(platform: HostPlatform) {
  if (platform === "darwin") {
    return "Allow Screen Recording and System Audio Recording, then recheck.";
  }
  if (platform === "win32") {
    return "Allow screen capture and system audio, then recheck.";
  }
  return "System audio may be unavailable. You can still use your microphone.";
}

export function markHostPlatform(platform: string | undefined) {
  if (platform && typeof document !== "undefined") {
    document.documentElement.dataset.platform = platform;
  }
}
