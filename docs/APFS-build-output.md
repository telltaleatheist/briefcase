# macOS build output must land on APFS (not exFAT)

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

Confirmed directly: writing an xattr to a file on exFAT creates a `._` companion;
on APFS it's stored inline with no companion.

## The fix

Only the packaged `.app`/DMG **assembly** needs native-FS fidelity — the source
can stay on Callisto. So the mac package/publish scripts redirect only
electron-builder's **output** to an APFS location under `$HOME`:

```
electron-builder --mac --arm64 ... -c.directories.output=$HOME/Projects/Briefcase-builds
```

`dist-electron/` stays a normal directory on Callisto and still holds the build
**inputs** (`electron/main.js`, `shared/`, `utilities/`, …) — electron-builder
reads those in place. Only the assembled app and DMGs land on APFS, where the
code signature stays intact through notarization.

> Note: an earlier attempt symlinked `dist-electron` itself to APFS. That breaks,
> because electron-builder's asar packer doesn't traverse the top-level symlink
> to collect the app's input files ("entry file main.js does not exist"). In this
> repo `dist-electron` holds both inputs and output, so only the *output* may be
> redirected — hence `-c.directories.output`, not a symlink.

Nothing else changes — same Developer ID cert, entitlements, and notarize step.

## Where artifacts land

```
~/Projects/Briefcase-builds/
  ├── mac-arm64/Briefcase.app
  ├── mac/Briefcase.app            (x64)
  └── Briefcase-<version>*.dmg
```

(Consistent with the sibling `~/Projects/BookForge-builds/`.)

## Build commands

```bash
npm run package:mac:signed     # Developer ID signed + Apple notarized
npm run package:mac            # unsigned / no notarization (fast local)
```

Both automatically point their output at APFS; no per-machine setup needed.
