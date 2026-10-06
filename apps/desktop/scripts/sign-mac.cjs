/**
 * Signs the Mac app with our own certificate so macOS keeps Screen Recording, Microphone,
 * and System Audio permissions across updates. Ad-hoc builds get a new identity each release.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function signMac(context) {
  if (context.electronPlatformName !== "darwin") return;
  const identity = process.env.BANA_MAC_SIGN_IDENTITY;
  if (!identity) {
    console.warn("[sign-mac] BANA_MAC_SIGN_IDENTITY is not set; leaving the app ad-hoc signed.");
    return;
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const keychain = process.env.BANA_MAC_KEYCHAIN ? ["--keychain", process.env.BANA_MAC_KEYCHAIN] : [];
  execFileSync("codesign", ["--force", "--deep", "--sign", identity, ...keychain, app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
