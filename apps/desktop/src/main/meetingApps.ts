import { desktopCapturer } from "electron";

export type MeetingAppHit = {
  id: "zoom" | "teams" | "meet" | "webex" | "slack" | "none";
  name: string;
  windowName?: string;
  coach: string;
};

const RULES: {
  id: MeetingAppHit["id"];
  re: RegExp;
  name: string;
  coach: string;
}[] = [
  {
    id: "zoom",
    re: /\bzoom\b/i,
    name: "Zoom",
    coach:
      "Zoom is open. Share a window — not Screen 1. Advanced capture with window filtering hides this HUD more often.",
  },
  {
    id: "teams",
    re: /microsoft teams|\bteams\b/i,
    name: "Teams",
    coach:
      "Teams is open. Share a specific window or app, not the full desktop, so this HUD stays off the share.",
  },
  {
    id: "meet",
    re: /google meet|\bmeet -/i,
    name: "Google Meet",
    coach:
      "Meet is open. Share a Chrome tab or window — not the whole screen — so this HUD is not in the share.",
  },
  {
    id: "webex",
    re: /\bwebex\b/i,
    name: "Webex",
    coach:
      "Webex is open. Share an application window, not the display, so this HUD stays off the share.",
  },
  {
    id: "slack",
    re: /\bslack\b/i,
    name: "Slack",
    coach:
      "Slack is open. If you huddle-share, share a window, not the entire screen.",
  },
];

const DEFAULT_COACH =
  "If you share, share a window — not Screen 1. Full-display share can include this HUD.";

export async function detectMeetingApp(): Promise<MeetingAppHit> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 1, height: 1 },
    });
    for (const rule of RULES) {
      const hit = sources.find(
        (source) =>
          rule.re.test(source.name) &&
          !/meeting copilot|bana copilot|^electron$/i.test(source.name),
      );
      if (hit) {
        return {
          id: rule.id,
          name: rule.name,
          windowName: hit.name,
          coach: rule.coach,
        };
      }
    }
  } catch {
    /* Screen Recording may be off — keep the generic coach */
  }
  return { id: "none", name: "None", coach: DEFAULT_COACH };
}
