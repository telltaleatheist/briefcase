/**
 * electron-builder afterSign hook — notarize the macOS .app with Apple, then
 * staple the ticket so Gatekeeper approves it offline.
 *
 * Runs after codesign and before the DMG is assembled. It is intentionally
 * fail-soft: it SKIPS (with a clear log line) when the build isn't macOS or when
 * no notarization credentials are present, so everyday local/dev builds still
 * succeed without Apple credentials. Only release builds need the env vars set.
 *
 * Signing identity: not pinned here — electron-builder auto-selects the
 * "Developer ID Application" certificate for distribution builds. If you ever
 * need to force a specific one, set CSC_NAME="Developer ID Application: ...".
 *
 * Credentials — set as environment variables, NEVER commit them. Provide ONE set:
 *
 *   App Store Connect API key (preferred — no 2FA, no expiring passwords):
 *     APPLE_API_KEY      absolute path to the AuthKey_XXXXXX.p8 file
 *     APPLE_API_KEY_ID   the Key ID (e.g. 2X9R4HXF34)
 *     APPLE_API_ISSUER   the Issuer ID (a UUID)
 *
 *   — or Apple ID:
 *     APPLE_ID                     your Apple ID email
 *     APPLE_APP_SPECIFIC_PASSWORD  app-specific password from appleid.apple.com
 *     APPLE_TEAM_ID                your Team ID (N7V7AT6CZ9)
 *
 * Escape hatch: set SKIP_NOTARIZE=1 to force-skip even when credentials exist.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { notarize } = require('@electron/notarize');

module.exports = async function notarizeHook(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  if (process.env.SKIP_NOTARIZE === '1' || process.env.SKIP_NOTARIZE === 'true') {
    console.log('[notarize] SKIP_NOTARIZE set — skipping notarization.');
    return;
  }

  const hasApiKey = Boolean(
    process.env.APPLE_API_KEY &&
    process.env.APPLE_API_KEY_ID &&
    process.env.APPLE_API_ISSUER
  );
  const hasAppleId = Boolean(
    process.env.APPLE_ID &&
    process.env.APPLE_APP_SPECIFIC_PASSWORD &&
    process.env.APPLE_TEAM_ID
  );

  if (!hasApiKey && !hasAppleId) {
    console.warn(
      '[notarize] No notarization credentials found — skipping.\n' +
      '           The build is signed but NOT notarized; other Macs will warn on first launch.\n' +
      '           To notarize, set either APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER,\n' +
      '           or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.'
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const credentials = hasApiKey
    ? {
        appleApiKey: process.env.APPLE_API_KEY,
        appleApiKeyId: process.env.APPLE_API_KEY_ID,
        appleApiIssuer: process.env.APPLE_API_ISSUER,
      }
    : {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      };

  console.log(
    `[notarize] Submitting ${appName}.app to Apple notary service ` +
    `(${hasApiKey ? 'API key' : 'Apple ID'}). This can take a few minutes...`
  );

  await notarize({ tool: 'notarytool', appPath, ...credentials });

  console.log('[notarize] Notarization accepted. Stapling ticket to the app...');
  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
  console.log('[notarize] Done — app is signed, notarized, and stapled.');
};
