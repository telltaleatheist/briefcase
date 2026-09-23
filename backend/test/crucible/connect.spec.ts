import { startFakeCrucible, startNotCrucible, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { connectCodeFor, elideConnectCode } from '../../src/crucible/connect.service';
import { CrucibleConnectError } from '../../src/crucible/errors';
import { pairingHost, pairingLineFor } from './helpers';
import { harness } from './harness';

describe('device-code pairing against the fake', () => {
  let fake: FakeCrucible;
  afterEach(() => fake.close());

  it('open pairing: start shows a user code, the first poll approves, probes and registers', async () => {
    fake = await startFakeCrucible({ name: 'crucible@owens-pc' });
    const h = harness();
    const prompt = await h.connect.startPairing(fake.url);
    expect(prompt).toMatchObject({ name: 'crucible@owens-pc', url: fake.url, approvalRequired: false });
    expect(prompt.userCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    // The renderer gets no device code and no token.
    expect(JSON.stringify(prompt)).not.toContain(fake.token);
    expect(Object.keys(prompt).sort()).toEqual(['approvalRequired', 'expiresIn', 'interval', 'name', 'requestId', 'url', 'userCode']);
    expect(fake.pairings[0]!.clientName).toBe('Briefcase');

    const decision = await h.connect.pollPairing(prompt.requestId);
    expect(decision).toEqual({ status: 'approved', name: 'crucible@owens-pc' });
    expect(h.registry.getWithToken('crucible@owens-pc')).toEqual({ name: 'crucible@owens-pc', url: fake.url, token: fake.token });
    // Probed before it was written: ping and info crossed.
    expect(fake.requestsTo('/v1/info').length).toBeGreaterThan(0);
    // The request is spent.
    await expect(h.connect.pollPairing(prompt.requestId)).rejects.toMatchObject({ code: 'pairing_not_active' });
  });

  it('a bare address gets the standard port, and a name given at start files the server under it', async () => {
    fake = await startFakeCrucible();
    const h = harness();
    const port = new URL(fake.url).port;
    const prompt = await h.connect.startPairing(`127.0.0.1:${port}`, 'PC');
    await h.connect.pollPairing(prompt.requestId);
    expect(h.registry.names()).toEqual(['PC']);
  });

  it('approval pairing: pending until the operator decides; approved registers, denied does not', async () => {
    fake = await startFakeCrucible({ pairing: 'approval' });
    const h = harness();
    const first = await h.connect.startPairing(fake.url);
    expect(first.approvalRequired).toBe(true);
    expect(await h.connect.pollPairing(first.requestId)).toEqual({ status: 'pending' });
    fake.decidePairing(fake.pairings[0]!.id, false);
    expect(await h.connect.pollPairing(first.requestId)).toEqual({ status: 'denied' });
    expect(h.registry.exists()).toBe(false);

    const second = await h.connect.startPairing(fake.url);
    fake.decidePairing(fake.pairings[1]!.id, true);
    expect(await h.connect.pollPairing(second.requestId)).toMatchObject({ status: 'approved' });
    expect(h.registry.names()).toEqual(['crucible@fake']);
  });

  it('expired and cancelled requests end cleanly', async () => {
    fake = await startFakeCrucible({ pairing: 'approval' });
    const h = harness();
    const expiring = await h.connect.startPairing(fake.url);
    fake.expirePairings();
    expect(await h.connect.pollPairing(expiring.requestId)).toEqual({ status: 'expired' });
    const cancelled = await h.connect.startPairing(fake.url);
    h.connect.cancelPairing(cancelled.requestId);
    await expect(h.connect.pollPairing(cancelled.requestId)).rejects.toMatchObject({ code: 'pairing_not_active' });
  });

  it('refuses an address that is not a Crucible, by the SDK\'s code, and registers nothing', async () => {
    fake = await startFakeCrucible();
    const router = await startNotCrucible();
    try {
      const h = harness();
      // The SDK's pairing reader cannot parse an HTML page as JSON and calls it
      // `connection_unreachable`; what matters here is that it is refused by a code.
      await expect(h.connect.startPairing(router.url)).rejects.toMatchObject({ code: expect.stringMatching(/not_crucible|invalid_response|connection_unreachable/) });
      expect(h.registry.exists()).toBe(false);
      await expect(h.connect.startPairing('http://has a space')).rejects.toMatchObject({ code: 'invalid_address' });
    } finally {
      await router.close();
    }
  });
});

describe('connect codes', () => {
  let fake: FakeCrucible;
  beforeEach(async () => {
    fake = await startFakeCrucible({ name: 'crucible@owens-pc' });
  });
  afterEach(() => fake.close());

  it('builds and reads crucible://name@host:port/#token with the name percent-encoded', () => {
    const line = connectCodeFor('crucible@owens-pc', 'http://192.168.68.20:7100', 'tok/en+1234');
    expect(line).toBe('crucible://crucible%40owens-pc@192.168.68.20:7100/#tok%2Fen%2B1234');
    expect(elideConnectCode(line)).toBe('crucible://crucible%40owens-pc@192.168.68.20:7100/#****');
    const h = harness();
    expect(h.connect.readConnectCode(line)).toEqual({ ok: true, name: 'crucible@owens-pc', url: 'http://192.168.68.20:7100', tokenMasked: '****1234' });
    expect(h.connect.readConnectCode('https://example.com')).toMatchObject({ ok: false, code: 'invalid_pairing' });
  });

  it('adds a server from a pasted connect code after probing it', async () => {
    const h = harness();
    const row = await h.connect.addFromConnectCode(pairingLineFor('crucible@owens-pc', fake.url, fake.token));
    expect(row).toMatchObject({ name: 'crucible@owens-pc', url: fake.url });
    expect(JSON.stringify(row)).not.toContain(fake.token);
    const renamed = harness();
    await renamed.connect.addFromConnectCode(pairingLineFor('crucible@owens-pc', fake.url, fake.token), 'The PC');
    expect(renamed.registry.names()).toEqual(['The PC']);
  });

  it('writes nothing when the pasted code carries a token the server refuses', async () => {
    const h = harness();
    await expect(h.connect.addFromConnectCode(pairingLineFor('crucible@owens-pc', fake.url, 'stale-0000')))
      .rejects.toMatchObject({ code: 'probe_failed' });
    expect(h.registry.exists()).toBe(false);
  });

  it('refuses a line that is not a connect code, without echoing a token', async () => {
    const h = harness();
    const err = await h.connect.addFromConnectCode(`crucible://127.0.0.1:7100/#${fake.token}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrucibleConnectError);
    expect((err as CrucibleConnectError).code).toBe('invalid_pairing');
    expect((err as Error).message).not.toContain(fake.token);
  });

  it('adopts the discovered Crucible on this computer on request', async () => {
    const h = harness(pairingHost(pairingLineFor('crucible@owens-mac-studio', fake.url, fake.token)));
    expect((await h.connect.addDiscovered()).name).toBe('crucible@owens-mac-studio');
    await expect(harness(pairingHost(null)).connect.addDiscovered()).rejects.toMatchObject({ code: 'nothing_discovered' });
  });

  it('copies a registered server\'s connect code to the clipboard, and answers with the token elided', async () => {
    const h = harness(pairingHost(pairingLineFor('crucible@owens-mac-studio', fake.url, fake.token)));
    h.registry.add({ name: 'pc', url: fake.url, token: fake.token });
    const answer = await h.connect.copyConnectCode('pc');
    expect(h.clipboard).toEqual([connectCodeFor('pc', fake.url, fake.token)]);
    expect(answer.copied).toMatch(/^crucible:\/\/pc@127\.0\.0\.1:\d+\/#\*\*\*\*$/);
    expect(JSON.stringify(answer)).not.toContain(fake.token);
    const local = await h.connect.copyLocalConnectCode();
    expect(h.clipboard[1]).toContain('crucible%40owens-mac-studio@');
    expect(local.copied.endsWith('#****')).toBe(true);
  });
});
