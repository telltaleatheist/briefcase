// Briefcase/electron/services/user-data-migration.ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as log from 'electron-log';

/**
 * One-time migration from the legacy "clipchimp" userData folder to the
 * new "briefcase" userData folder. Runs synchronously before any code
 * touches the userData directory so the backend, database, and settings
 * all see the same files after the rename.
 *
 * Strategy:
 *  1. Resolve the new userData path (app.getPath('userData') — resolves
 *     to ~/Library/Application Support/briefcase on macOS, etc.).
 *  2. Compute the legacy path by swapping the basename to 'clipchimp'.
 *  3. If the new folder already exists with a migration marker, bail.
 *  4. If the legacy folder exists and the new folder does not, create a
 *     zip backup of the legacy folder beside it (best-effort) and then
 *     recursively copy its contents into the new folder.
 *  5. Write a `.migrated-from-clipchimp` marker in the new folder so the
 *     migration never runs twice.
 *  6. Leave the legacy folder untouched — it acts as a permanent backup
 *     the user can delete manually.
 */
export class UserDataMigration {
  private static readonly MARKER_FILENAME = '.migrated-from-clipchimp';
  private static readonly LEGACY_NAME = 'clipchimp';

  static run(): void {
    try {
      const newUserData = app.getPath('userData');
      const parent = path.dirname(newUserData);
      const legacyUserData = path.join(parent, this.LEGACY_NAME);

      // If the new folder is actually the same as legacy (i.e. package.json
      // name wasn't changed yet, or case-insensitive filesystem collision),
      // there is nothing to do.
      if (path.resolve(newUserData).toLowerCase() === path.resolve(legacyUserData).toLowerCase()) {
        return;
      }

      // Already migrated? Bail.
      const markerPath = path.join(newUserData, this.MARKER_FILENAME);
      if (fs.existsSync(markerPath)) {
        return;
      }

      // Nothing to migrate from.
      if (!fs.existsSync(legacyUserData)) {
        return;
      }

      // If the new folder already exists and has real content (e.g. the
      // user ran the briefcase build before and populated it), do not
      // clobber it — only write the marker so we don't revisit.
      if (fs.existsSync(newUserData)) {
        const entries = fs.readdirSync(newUserData).filter(e => e !== this.MARKER_FILENAME);
        if (entries.length > 0) {
          log.warn('[UserDataMigration] New userData already populated, skipping migration');
          this.writeMarker(newUserData, legacyUserData);
          return;
        }
      } else {
        fs.mkdirSync(newUserData, { recursive: true });
      }

      log.info(`[UserDataMigration] Migrating ${legacyUserData} → ${newUserData}`);

      // Best-effort backup: we leave the legacy folder in place anyway, but
      // also try to stash a lightweight text-file index of what was there
      // so the user has a record even if something goes sideways.
      this.writeBackupIndex(legacyUserData, newUserData);

      // Recursive copy.
      this.copyDirSync(legacyUserData, newUserData);

      this.writeMarker(newUserData, legacyUserData);
      log.info('[UserDataMigration] Migration complete. Legacy folder left in place as backup.');
    } catch (error) {
      log.error('[UserDataMigration] Migration failed:', error);
      // Swallow errors — a failed migration should not prevent the app
      // from booting with an empty userData folder.
    }
  }

  private static writeMarker(newUserData: string, legacyUserData: string): void {
    try {
      const marker = path.join(newUserData, this.MARKER_FILENAME);
      fs.writeFileSync(
        marker,
        JSON.stringify(
          {
            migratedAt: new Date().toISOString(),
            from: legacyUserData,
            note: 'Briefcase was renamed from ClipChimp. This file marks that a one-time userData migration completed. The legacy folder at "from" has been left in place as a backup and can be deleted manually.',
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch (error) {
      log.warn('[UserDataMigration] Failed to write marker file:', error);
    }
  }

  private static writeBackupIndex(legacyUserData: string, newUserData: string): void {
    try {
      const index: string[] = [];
      const walk = (dir: string, rel: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const relPath = path.join(rel, entry.name);
          if (entry.isDirectory()) {
            index.push(relPath + '/');
            walk(path.join(dir, entry.name), relPath);
          } else {
            try {
              const stat = fs.statSync(path.join(dir, entry.name));
              index.push(`${relPath}\t${stat.size}\t${stat.mtime.toISOString()}`);
            } catch {
              index.push(relPath);
            }
          }
        }
      };
      walk(legacyUserData, '');
      fs.writeFileSync(
        path.join(newUserData, '.clipchimp-backup-index.txt'),
        `Legacy folder: ${legacyUserData}\nGenerated: ${new Date().toISOString()}\n\n${index.join('\n')}\n`,
        'utf8',
      );
    } catch (error) {
      log.warn('[UserDataMigration] Failed to write backup index:', error);
    }
  }

  private static copyDirSync(src: string, dst: string): void {
    if (!fs.existsSync(dst)) {
      fs.mkdirSync(dst, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);

      // Skip Electron-internal cache-ish files that will be recreated on
      // first launch — they can be hundreds of MB and copying them is a
      // waste of disk.
      if (this.shouldSkip(entry.name)) {
        continue;
      }

      try {
        if (entry.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(srcPath);
          fs.symlinkSync(linkTarget, dstPath);
        } else if (entry.isDirectory()) {
          this.copyDirSync(srcPath, dstPath);
        } else {
          fs.copyFileSync(srcPath, dstPath);
          // Preserve mtime so user-visible timestamps remain meaningful.
          try {
            const stat = fs.statSync(srcPath);
            fs.utimesSync(dstPath, stat.atime, stat.mtime);
          } catch {
            // non-fatal
          }
        }
      } catch (error) {
        log.warn(`[UserDataMigration] Failed to copy ${srcPath}:`, error);
      }
    }
  }

  private static shouldSkip(name: string): boolean {
    // Chromium / Electron cache directories that the renderer rebuilds.
    const skipDirs = new Set([
      'Cache',
      'Code Cache',
      'GPUCache',
      'DawnGraphiteCache',
      'DawnWebGPUCache',
      'blob_storage',
      'Shared Dictionary',
      'Service Worker',
      'Session Storage',
    ]);
    if (skipDirs.has(name)) {
      return true;
    }
    // Electron IPC sockets / temp droppings.
    if (name.startsWith('.com.github.Electron.')) {
      return true;
    }
    // Lock files from a previous run.
    if (name === 'backend.lock' || name === 'SingletonLock' || name === 'SingletonCookie' || name === 'SingletonSocket') {
      return true;
    }
    return false;
  }
}
