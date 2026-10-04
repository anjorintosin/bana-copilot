import type { BillingAccount, PracticeQuestion, Story } from "@meeting-copilot/types";
import type { CaptureSource } from "../audio/capture";
import type { AppSettings } from "../../settings";

export type StoryCard = Story;

export type ScreenFrame = {
  sourceId: string;
  name: string;
  changed: boolean;
  diffRatio: number;
  dataUrl?: string;
  jpegBase64?: string;
};

export type CopilotBridge = {
  apiUrl: string;
  httpUrl: string;
  packaged?: boolean;
  platform: string;
  ensureAuth: () => Promise<{ token: string; userId: string }>;
  listSessions: (token: string) => Promise<{
    sessions?: {
      id: string;
      status: string;
      started_at: string;
      transcript_count: number;
      screen_count: number;
      summary?: string | null;
      meeting_app?: string | null;
    }[];
  }>;
  permissionInfo: () => Promise<{
    status: string;
    listName: string;
    execPath: string;
    displays: { index: number; primary: boolean }[];
  }>;
  requestMic: () => Promise<{ status: string; listName: string }>;
  openMicSettings: () => Promise<{ ok: boolean }>;
  openScreenSettings: () => Promise<{ ok: boolean }>;
  listScreens: () => Promise<{ ok: boolean; error?: string; listName: string }>;
  startScreen: () => Promise<{ ok: boolean; error?: string; listName: string }>;
  stopScreen: () => Promise<{ ok: boolean }>;
  grabShot: () => Promise<{
    ok: boolean;
    error?: string;
    dataUrl?: string;
    jpegBase64?: string;
    name?: string;
  }>;
  detectMeeting: () => Promise<{
    id: string;
    name: string;
    windowName?: string;
    coach: string;
  }>;
  cycleDisplay: () => Promise<{ index: number; count: number; primary: boolean }>;
  setCollapsed: (collapsed: boolean) => Promise<{ collapsed: boolean }>;
  hideHud: () => Promise<{ ok: boolean }>;
  showHud: () => Promise<{ ok: boolean }>;
  setFocusable: (on: boolean) => Promise<{ ok: boolean }>;
  moveHudBy: (dx: number, dy: number) => void;
  toggleInteract: () => Promise<{ clickThrough: boolean; session: boolean }>;
  openHome: (hash?: string) => Promise<{ ok: boolean }>;
  listDocuments: (token: string) => Promise<{
    latest?: Record<string, { id: string; kind: string; title: string; text: string; excerpt: string; chars: number; createdAt: string }>;
    recent?: unknown[];
    error?: string;
  }>;
  saveDocument: (
    token: string,
    payload: { kind: string; title?: string; text?: string; pdfBase64?: string },
  ) => Promise<{
    latest?: Record<string, { id: string; kind: string; title: string; text: string; excerpt: string; chars: number; createdAt: string }>;
    error?: string;
  }>;
  getAccount: (token: string) => Promise<BillingAccount & { error?: string }>;
  billingCheckout: (token: string, planId: string) => Promise<{ url?: string; error?: string }>;
  billingActivate: (token: string, planId: string) => Promise<BillingAccount & { error?: string }>;
  billingSaveKey: (
    token: string,
    body: { provider?: string; apiKey?: string; baseUrl?: string },
  ) => Promise<BillingAccount & { error?: string }>;
  billingClearKey: (token: string) => Promise<BillingAccount & { error?: string }>;
  openExternal: (url: string) => Promise<{ ok: boolean }>;
  getProfile: (token: string) => Promise<{
    jobTitle?: string;
    company?: string;
    requirements?: string;
    defaultTrack?: string;
    plan?: string;
    resume?: { id: string; title: string; excerpt: string; chunkCount: number } | null;
    error?: string;
  }>;
  saveProfile: (
    token: string,
    body: { jobTitle?: string; company?: string; requirements?: string; defaultTrack?: string },
  ) => Promise<{ jobTitle?: string; defaultTrack?: string; error?: string }>;
  saveResume: (
    token: string,
    payload: { text?: string; pdfBase64?: string; title?: string },
  ) => Promise<{
    resume?: { chunkCount: number; title: string } | null;
    error?: string;
  }>;
  listStories: (token: string) => Promise<{
    stories?: StoryCard[];
    status?: string;
    count?: number;
    error?: string;
  }>;
  saveStory: (token: string, body: Partial<StoryCard>) => Promise<{
    stories?: StoryCard[];
    status?: string;
    error?: string;
  }>;
  deleteStory: (token: string, id: string) => Promise<{
    stories?: StoryCard[];
    error?: string;
  }>;
  rebuildStories: (token: string) => Promise<{
    stories?: StoryCard[];
    status?: string;
    error?: string;
  }>;
  practicePlan: (token: string) => Promise<{
    title?: string;
    company?: string;
    track?: string;
    questions?: PracticeQuestion[];
    storyCount?: number;
    rehearsedCount?: number;
    error?: string;
  }>;
  practiceTurn: (
    token: string,
    body: {
      question: string;
      storyId?: string;
      prior?: { question: string; kind: string; answer: string }[];
    },
  ) => Promise<{
    answer?: string;
    specialist?: string;
    story?: StoryCard | null;
    stories?: StoryCard[];
    rehearsedCount?: number;
    error?: string;
  }>;
  onScreenFrame: (cb: (event: ScreenFrame) => void) => () => void;
  onCollapsed: (cb: (collapsed: boolean) => void) => () => void;
  onPassThrough: (cb: (on: boolean) => void) => () => void;
  onToast: (cb: (text: string) => void) => () => void;
  onListenToggle: (cb: () => void) => () => void;
  onAssist: (cb: () => void) => () => void;
  onAssistScreen: (cb: () => void) => () => void;
  onContextClear: (cb: () => void) => () => void;
  onProfileChanged: (cb: () => void) => () => void;
  getApiUrl: () => Promise<{ http: string; ws: string }>;
  setApiUrl: (http: string) => Promise<{ ok: boolean; http: string; relaunch?: boolean; error?: string }>;
  getSettings: () => Promise<{ settings: AppSettings }>;
  saveSettings: (patch: {
    shortcuts?: Partial<AppSettings["shortcuts"]>;
    look?: Partial<AppSettings["look"]>;
  }) => Promise<{ ok: boolean; error?: string; settings: AppSettings }>;
  resetShortcuts: () => Promise<{ ok: boolean; error?: string; settings: AppSettings }>;
  setSessionActive: (active: boolean) => Promise<{ settings: AppSettings }>;
  onSettingsChanged: (cb: (settings: AppSettings) => void) => () => void;
};

declare global {
  interface Window {
    copilot: CopilotBridge;
  }
}

export type { CaptureSource };
