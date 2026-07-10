# macOS build output must live on APFS (not exFAT)

## Why

This project's working copy lives on an exFAT volume (`/Volumes/Callisto`).
exFAT cannot store a file's extended attributes inline, so macOS writes them to
`._`-prefixed **AppleDouble** sidecar files. When electron-builder codesigns the
`.app`, the signature seals those xattrs. The signature then verifies fine
locally, but when `@electron/notarize` zips the app for Apple, the `._`
companions don't survive the round-trip — so Apple's notary service re-checks
the binaries, finds the sealed xattrs missing, and rejects the submission with:

```
"The signature of the binary is invalid."   (status: Invalid)
```

Confirmed directly: writing an xattr to a file on exFAT creates a `._companion`;
on APFS it's stored inline with no companion.

## The fix

Only the packaged `.app`/DMG assembly needs native-FS fidelity — the **source
can stay on Callisto**. We make electron-builder's output directory
(`dist-electron`) a **symlink to an APFS location** under `$HOME`. exFAT holds
symlinks fine, so every path/script/config is unchanged; the bytes just land on
APFS where the signature stays intact through notarization.

Nothing else changes — same Developer ID cert, same entitlements, same
`afterSign` notarize step.

## Setup (one-time per machine / fresh clone)

```bash
npm run setup:build-output
```

This creates `~/Projects/Briefcase-builds/dist-electron` (APFS) and points
`dist-electron` at it. It's idempotent and safe to re-run. `dist-electron` is
git-ignored (both as a directory and as a symlink), so this never gets committed.

After that, build normally:

```bash
npm run package:mac:signed     # Developer ID + Apple notarization
npm run package:mac            # unsigned / no notarization
```
