import { contextBridge, ipcRenderer } from "electron";
import { screenCaptureMode } from "../compat";

const apiArg = process.argv.find((arg) => arg.startsWith("--copilot-api="));
const httpArg = process.argv.find((arg) => arg.startsWith("--copilot-http="));
const packagedArg = process.argv.find((arg) => arg.startsWith("--copilot-packaged="));
const apiUrl = apiArg?.slice("--copilot-api=".length) ?? "ws://127.0.0.1:8787/ws";
const httpUrl = httpArg?.slice("--copilot-http=".length) ?? "http://127.0.0.1:8787";
const packaged = packagedArg?.slice("--copilot-packaged=".length) === "1";

contextBridge.exposeInMainWorld("copilot", {
  apiUrl,
  httpUrl,
  packaged,
  platform: process.platform,
  osVersion: process.getSystemVersion(),
  screenMode: screenCaptureMode(process.platform, process.env),
  ensureAuth: () => ipcRenderer.invoke("auth:ensure"),
  listSessions: (token: string) => ipcRenderer.invoke("sessions:list", token),
  permissionInfo: () => ipcRenderer.invoke("permissions:info"),
  requestMic: () => ipcRenderer.invoke("permissions:mic"),
  probeScreen: () => ipcRenderer.invoke("permissions:screen"),
  openMicSettings: () => ipcRenderer.invoke("permissions:open-mic-settings"),
  openScreenSettings: () => ipcRenderer.invoke("permissions:open-screen-settings"),
  listDisplays: () => ipcRenderer.invoke("permissions:info"),
  listScreens: () => ipcRenderer.invoke("capture:list"),
  startScreen: () => ipcRenderer.invoke("capture:start"),
  stopScreen: () => ipcRenderer.invoke("capture:stop"),
  grabShot: () => ipcRenderer.invoke("capture:shot"),
  detectMeeting: () => ipcRenderer.invoke("meeting:detect"),
  cycleDisplay: () => ipcRenderer.invoke("hud:cycle-display"),
  setCollapsed: (collapsed: boolean) =>
    ipcRenderer.invoke("hud:set-collapsed", collapsed),
  setHudMenu: (open: boolean) => ipcRenderer.invoke("hud:set-menu", open),
  hideHud: () => ipcRenderer.invoke("hud:hide"),
  showHud: () => ipcRenderer.invoke("hud:show"),
  setFocusable: (on: boolean) => ipcRenderer.invoke("hud:set-focusable", on),
  moveHudBy: (dx: number, dy: number) => ipcRenderer.send("hud:move-by", dx, dy),
  toggleInteract: () => ipcRenderer.invoke("hud:toggle-interact"),
  openHome: (hash?: string) => ipcRenderer.invoke("home:open", hash),
  closeHome: () => ipcRenderer.invoke("home:close"),
  listDocuments: (token: string) => ipcRenderer.invoke("documents:list", token),
  saveDocument: (token: string, payload: unknown) =>
    ipcRenderer.invoke("documents:save", token, payload),
  listModes: (token: string) => ipcRenderer.invoke("modes:list", token),
  createMode: (token: string, body: unknown) =>
    ipcRenderer.invoke("modes:create", token, body),
  updateMode: (token: string, id: string, body: unknown) =>
    ipcRenderer.invoke("modes:update", token, id, body),
  deleteMode: (token: string, id: string) =>
    ipcRenderer.invoke("modes:delete", token, id),
  selectMode: (token: string, id: string) =>
    ipcRenderer.invoke("modes:select", token, id),
  addModeDocument: (token: string, id: string, body: unknown) =>
    ipcRenderer.invoke("modes:add-doc", token, id, body),
  getModeDocument: (token: string, id: string, docId: string) =>
    ipcRenderer.invoke("modes:get-doc", token, id, docId),
  getResume: (token: string) => ipcRenderer.invoke("resume:get", token),
  deleteModeDocument: (token: string, id: string, docId: string) =>
    ipcRenderer.invoke("modes:delete-doc", token, id, docId),
  getAccount: (token: string) => ipcRenderer.invoke("account:get", token),
  billingCheckout: (token: string, planId: string) =>
    ipcRenderer.invoke("billing:checkout", token, planId),
  billingActivate: (token: string, planId: string) =>
    ipcRenderer.invoke("billing:activate", token, planId),
  billingSaveKey: (token: string, body: unknown) =>
    ipcRenderer.invoke("billing:key", token, body),
  billingClearKey: (token: string) => ipcRenderer.invoke("billing:key-clear", token),
  openExternal: (url: string) => ipcRenderer.invoke("billing:open-url", url),
  getProfile: (token: string) => ipcRenderer.invoke("profile:get", token),
  saveProfile: (token: string, body: unknown) =>
    ipcRenderer.invoke("profile:save", token, body),
  saveResume: (
    token: string,
    payload: { text?: string; pdfBase64?: string; title?: string },
  ) => ipcRenderer.invoke("resume:save", token, payload),
  listStories: (token: string) => ipcRenderer.invoke("stories:list", token),
  saveStory: (token: string, body: unknown) =>
    ipcRenderer.invoke("stories:save", token, body),
  deleteStory: (token: string, id: string) =>
    ipcRenderer.invoke("stories:delete", token, id),
  rebuildStories: (token: string) =>
    ipcRenderer.invoke("stories:rebuild", token),
  practicePlan: (token: string) => ipcRenderer.invoke("practice:plan", token),
  practiceTurn: (token: string, body: unknown) =>
    ipcRenderer.invoke("practice:turn", token, body),
  getApiUrl: () => ipcRenderer.invoke("api:get"),
  setApiUrl: (http: string) => ipcRenderer.invoke("api:set", http),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch: unknown) => ipcRenderer.invoke("settings:set", patch),
  resetShortcuts: () => ipcRenderer.invoke("settings:reset-shortcuts"),
  setSessionActive: (active: boolean) =>
    ipcRenderer.invoke("settings:session-active", active),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  finishOnboard: () => ipcRenderer.invoke("onboard:finish"),
  onboardStatus: () => ipcRenderer.invoke("onboard:status"),
  onScreenFrame: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("capture:frame", listener);
    return () => ipcRenderer.removeListener("capture:frame", listener);
  },
  onCollapsed: (cb: (collapsed: boolean) => void) => {
    const listener = (_e: unknown, payload: boolean) => cb(payload);
    ipcRenderer.on("hud:collapsed", listener);
    return () => ipcRenderer.removeListener("hud:collapsed", listener);
  },
  onClosePops: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("hud:close-pops", listener);
    return () => ipcRenderer.removeListener("hud:close-pops", listener);
  },
  onPassThrough: (cb: (on: boolean) => void) => {
    const listener = (_e: unknown, payload: boolean) => cb(payload);
    ipcRenderer.on("hud:pass-through", listener);
    return () => ipcRenderer.removeListener("hud:pass-through", listener);
  },
  onToast: (cb: (text: string) => void) => {
    const listener = (_e: unknown, payload: string) => cb(payload);
    ipcRenderer.on("hud:toast", listener);
    return () => ipcRenderer.removeListener("hud:toast", listener);
  },
  onListenToggle: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("listen:toggle", listener);
    return () => ipcRenderer.removeListener("listen:toggle", listener);
  },
  onAssist: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("assist:trigger", listener);
    return () => ipcRenderer.removeListener("assist:trigger", listener);
  },
  onAssistScreen: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("assist:screen", listener);
    return () => ipcRenderer.removeListener("assist:screen", listener);
  },
  onShareToggle: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("hud:share", listener);
    return () => ipcRenderer.removeListener("hud:share", listener);
  },
  onAssistAction: (cb: (action: string) => void) => {
    const listener = (_e: unknown, action: string) => cb(action);
    ipcRenderer.on("assist:action", listener);
    return () => ipcRenderer.removeListener("assist:action", listener);
  },
  onContextClear: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("context:clear", listener);
    return () => ipcRenderer.removeListener("context:clear", listener);
  },
  onProfileChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("profile:changed", listener);
    return () => ipcRenderer.removeListener("profile:changed", listener);
  },
  onSettingsChanged: (cb: (settings: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("settings:changed", listener);
    return () => ipcRenderer.removeListener("settings:changed", listener);
  },
});
