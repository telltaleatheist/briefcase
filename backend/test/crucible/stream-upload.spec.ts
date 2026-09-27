/**
 * The streamed upload (stream-upload.ts): the file goes to `POST /v1/uploads`
 * from disk in pieces, byte-exact, named, counted as it goes, and refused or
 * unreachable as the SDK's own error types. (Why not the SDK's upload: a
 * 6.9 GB video stalled at 2.63 GB in fetch; see the file's header.)
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CrucibleAuthError, CrucibleUnreachable } from '@crucible/client';
import { streamUpload } from '../../src/crucible/stream-upload';
import { startFakeCrucible, unusedLoopbackUrl, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { tempDir } from './helpers';

let fake: FakeCrucible | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

function bigFile(bytes: number): string {
  const file = path.join(tempDir('stream-upload-'), 'show.mp4');
  const piece = Buffer.alloc(1 << 20);
  for (let i = 0; i < piece.length; i++) piece[i] = (i * 31) % 251;
  const fd = fs.openSync(file, 'w');
  for (let left = bytes; left > 0; left -= piece.length) fs.writeSync(fd, piece, 0, Math.min(left, piece.length));
  fs.closeSync(fd);
  return file;
}

describe('streamUpload', () => {
  it('sends the file byte-exact under its name, counting every byte as it goes', async () => {
    fake = await startFakeCrucible();
    const file = bigFile(24 * (1 << 20) + 123);
    let counted = 0;
    const result = await streamUpload({
      url: fake.url, token: fake.token, clientName: 'briefcase', file, filename: 'Show (2026).mp4',
      onBytes: (n) => { counted += n; },
    });
    const size = fs.statSync(file).size;
    expect(counted).toBe(size);
    expect(fake.uploads).toEqual([{
      blobId: result.blobId,
      filename: 'Show (2026).mp4',
      bytes: size,
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    }]);
    expect(result).toMatchObject({ bytes: size, sha256: fake.uploads[0].sha256 });
    const sent = fake.requestsTo('/v1/uploads', 'POST')[0];
    expect(sent.headers['x-crucible-client']).toBe('briefcase');
    expect(sent.headers['x-crucible-api']).toBe('1');
  });

  it('a wrong token is the SDK\'s CrucibleAuthError, and a dead address is CrucibleUnreachable', async () => {
    fake = await startFakeCrucible();
    const file = bigFile(1024);
    await expect(streamUpload({ url: fake.url, token: 'wrong', clientName: 'briefcase', file, filename: 'a.mp4' }))
      .rejects.toBeInstanceOf(CrucibleAuthError);
    await expect(streamUpload({ url: await unusedLoopbackUrl(), token: 't', clientName: 'briefcase', file, filename: 'a.mp4' }))
      .rejects.toBeInstanceOf(CrucibleUnreachable);
  });

  it('an abort stops the upload with the signal\'s reason', async () => {
    fake = await startFakeCrucible();
    const file = bigFile(1024);
    const controller = new AbortController();
    controller.abort(new Error('cancelled by the user'));
    await expect(streamUpload({ url: fake.url, token: fake.token, clientName: 'briefcase', file, filename: 'a.mp4', signal: controller.signal }))
      .rejects.toThrow('cancelled by the user');
    expect(fake.uploads).toHaveLength(0);
  });
});
