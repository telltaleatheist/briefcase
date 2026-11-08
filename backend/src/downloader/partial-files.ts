import * as fs from 'fs';
import * as path from 'path';

/**
 * The files a cancelled yt-dlp run leaves next to its output, and only those.
 *
 * Everything here is keyed to one download's output stem, the file name without
 * its extension ("2026-11-04 Alex Jones Live"). A file belongs to that download
 * only if it is the stem, a dot, and one of yt-dlp's working-file shapes:
 *
 *   <stem>.mp4.part            the download in progress
 *   <stem>.mp4.part-Frag12     a fragment (HLS/DASH), and <stem>.mp4.part-Frag12.part
 *   <stem>.mp4.ytdl            the resume record
 *   <stem>.f137.mp4(.part)     one format of a video+audio pair before the merge
 *   <stem>.temp.mp4(.part)     the merger's or fixup's working file
 *
 * A finished "<stem>.mp4" is never matched, and neither is a different video
 * whose name merely starts the same ("<stem> (2).mp4.part", "<stem>.fun.mp4.part").
 */

const MEDIA_EXTENSIONS = 'mp4|m4a|m4v|webm|mkv|mov|mp3|aac|opus|ogg|oga|flac|wav|ts|flv|3gp';
// A yt-dlp format id always carries a digit (137, hls-2138, audio-192p), which
// keeps a title word after the dot ("Foo.fun") from passing as one.
const FORMAT_ID = 'f(?=[\\w-]*\\d)[\\w-]+';

const WORKING_FILE = new RegExp(
  `^(?:${FORMAT_ID}\\.)?(?:temp\\.)?(?:${MEDIA_EXTENSIONS})` +
  `(?:\\.part(?:-Frag\\d+(?:\\.part)?)?|\\.ytdl)$`,
  'i',
);
// A finished format of a pair, or the merger's output, before the final rename.
const INTERMEDIATE = new RegExp(`^(?:${FORMAT_ID}|(?:${FORMAT_ID}\\.)?temp)\\.(?:${MEDIA_EXTENSIONS})$`, 'i');

/** True when `fileName` is a working file of the download whose stem is `stem`. */
export function isPartialFileOf(fileName: string, stem: string): boolean {
  if (!stem || !fileName.startsWith(`${stem}.`)) return false;
  const tail = fileName.slice(stem.length + 1);
  return WORKING_FILE.test(tail) || INTERMEDIATE.test(tail);
}

/** "/dir/Title.f137.mp4" or "/dir/Title.mp4" → "/dir/Title". */
export function stemOfDestination(destination: string): string {
  const withoutExt = destination.replace(/\.[^./\\]+$/, '');
  return withoutExt.replace(new RegExp(`\\.${FORMAT_ID}$`, 'i'), '');
}

/** The output stems a yt-dlp run announced in its log (one per destination). */
export function stemsFromYtDlpOutput(output: string): string[] {
  const stems = new Set<string>();
  const patterns = [
    /^\[download\] Destination: (.+)$/gm,
    /^\[Merger\] Merging formats into "(.+)"$/gm,
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      stems.add(stemOfDestination(match[1].trim()));
    }
  }
  return [...stems];
}

/**
 * The stem of an output template that names its file outright
 * ("/dir/2026-11-04 Title.%(ext)s" → "/dir/2026-11-04 Title"); null when the
 * name is itself filled in by yt-dlp ("%(title)s"), which only its log can tell.
 */
export function stemOfOutputTemplate(template: string): string | null {
  const match = template.match(/^(.*)\.%\(ext\)s$/);
  if (!match || match[1].includes('%(')) return null;
  return match[1];
}

/**
 * Delete the working files of each stem (full paths, "/dir/Title"). Returns the
 * paths removed; a file that can't be removed is reported through `onError`
 * and skipped, never thrown.
 */
export async function removePartialFiles(
  stems: string[],
  onError: (filePath: string, error: unknown) => void,
): Promise<string[]> {
  const removed: string[] = [];
  const byDir = new Map<string, Set<string>>();
  for (const stemPath of stems) {
    const dir = path.dirname(stemPath);
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir)!.add(path.basename(stemPath));
  }

  for (const [dir, names] of byDir) {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      continue; // The folder is gone: nothing left behind in it.
    }
    for (const entry of entries) {
      if (![...names].some((stem) => isPartialFileOf(entry, stem))) continue;
      const filePath = path.join(dir, entry);
      try {
        await fs.promises.rm(filePath, { force: true });
        removed.push(filePath);
      } catch (error) {
        onError(filePath, error);
      }
    }
  }
  return removed;
}
