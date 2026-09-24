/**
 * REGRESSION: a web page in a browser on this computer must not drive the
 * Crucible doors. CORS reflects any origin on loopback and a form POST needs
 * no preflight, so before the guard a page could add its own "Crucible" and
 * then have Briefcase copy the user's API keys to it.
 */
import { Global, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { CrucibleModule } from '../../src/crucible/crucible.module';
import { CRUCIBLE_CLIPBOARD, CRUCIBLE_PAIRING_HOST, CRUCIBLE_STATE_DIR } from '../../src/crucible/crucible.constants';
import { CrucibleAutoConnectService } from '../../src/crucible/auto-connect.service';
import { WebSocketService } from '../../src/common/websocket.service';
import { originAllowed } from '../../src/crucible/loopback-origin.guard';
import { pairingHost, tempDir } from './helpers';

@Global()
@Module({
  providers: [{
    provide: WebSocketService,
    useValue: {
      emitCrucibleServersChanged: () => undefined,
      emitCrucibleCoordination: () => undefined,
      emitCrucibleInstallProgress: () => undefined,
      emitCrucibleInstallDoor: () => undefined,
      emitCrucibleReadiness: () => undefined,
    },
  }],
  exports: [WebSocketService],
})
class WebSocketStubModule {}

describe('the Crucible doors refuse cross-site writes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WebSocketStubModule, CrucibleModule] })
      .overrideProvider(CRUCIBLE_STATE_DIR).useValue(tempDir())
      .overrideProvider(CRUCIBLE_PAIRING_HOST).useValue(pairingHost(null))
      .overrideProvider(CRUCIBLE_CLIPBOARD).useValue(async () => undefined)
      .compile();
    moduleRef.get(CrucibleAutoConnectService).retryDelaysMs = [];
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  it('a form POST from another origin to add a server is 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/crucible/servers')
      .set('Origin', 'https://evil.example')
      .type('form')
      .send('connectCode=crucible%3A%2F%2Fevil%40attacker.example%3A443%2F%23x');
    expect(res.status).toBe(403);
  });

  it('every Crucible controller carries the guard (key copy, install, transcription, servers)', async () => {
    const { GUARDS_METADATA } = await import('@nestjs/common/constants');
    const { LoopbackOriginGuard } = await import('../../src/crucible/loopback-origin.guard');
    const controllers = [
      (await import('../../src/crucible/crucible.controller')).CrucibleController,
      (await import('../../src/crucible/crucible-setup.controller')).CrucibleSetupController,
      (await import('../../src/crucible/llm/crucible-ai.controller')).CrucibleAiController,
      (await import('../../src/crucible/asr/transcription.controller')).CrucibleTranscriptionController,
    ];
    for (const c of controllers) expect(Reflect.getMetadata(GUARDS_METADATA, c)).toContain(LoopbackOriginGuard);
  });

  it('Briefcase’s own renderer (loopback origin) and origin-less callers still get through', async () => {
    const own = await request(app.getHttpServer()).post('/crucible/servers').set('Origin', 'http://localhost:3000').send({});
    expect(own.status).toBe(400); // past the guard, refused for the empty body
    const none = await request(app.getHttpServer()).post('/crucible/servers').send({});
    expect(none.status).toBe(400);
    const read = await request(app.getHttpServer()).get('/crucible/servers').set('Origin', 'https://evil.example');
    expect(read.status).not.toBe(403);
  });

  it('the rule itself', () => {
    expect(originAllowed('POST', 'http://127.0.0.1:3000', null)).toBe(true);
    expect(originAllowed('POST', 'http://[::1]:3000', null)).toBe(true);
    expect(originAllowed('POST', 'null', null)).toBe(false);
    expect(originAllowed('DELETE', 'http://192.168.1.5:3000', null)).toBe(false);
    expect(originAllowed('DELETE', 'http://192.168.1.5:3000', { port: 3000 })).toBe(true);
    expect(originAllowed('DELETE', 'http://192.168.1.5:4000', { port: 3000 })).toBe(false);
    expect(originAllowed('GET', 'https://evil.example', null)).toBe(true);
  });
});
