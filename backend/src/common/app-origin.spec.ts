/**
 * Only the app's own origins may read the API, open the socket, or change
 * anything. Before this, loopback CORS reflected any Origin (with credentials),
 * so any page in a browser on the Mac could drive 127.0.0.1.
 */
import { Body, Controller, Get, INestApplication, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WebSocketGateway } from '@nestjs/websockets';
import * as http from 'http';
import { AddressInfo } from 'net';
import request = require('supertest');
import { OriginPolicy, isAppOrigin, writeAllowed } from './app-origin';
import { applyAppOriginPolicy } from './app-origin.setup';

@Controller('probe')
class ProbeController {
  public writes = 0;
  @Get()
  read() {
    return { ok: true };
  }
  @Post()
  write(@Body() _body: unknown) {
    this.writes += 1;
    return { ok: true };
  }
}

@WebSocketGateway()
class ProbeGateway {}

@Module({ controllers: [ProbeController], providers: [ProbeGateway] })
class ProbeModule {}

async function boot(policyFor: (port: string) => OriginPolicy, credentials: boolean) {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  // The policy needs the real port, so reserve one first.
  const port = await new Promise<number>((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  const policy = policyFor(String(port));
  applyAppOriginPolicy(app, { policy, credentials, socketPath: '/socket.io' });
  await app.listen(port, '127.0.0.1');
  return { app, port, controller: moduleRef.get(ProbeController) };
}

/** A raw WebSocket upgrade to Socket.IO; resolves with the HTTP status (101 = accepted). */
function wsUpgrade(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/socket.io/?EIO=4&transport=websocket',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('app origin rule', () => {
  const loopback: OriginPolicy = { port: '3000', lan: false, devServer: false };
  const dev: OriginPolicy = { port: '3000', lan: false, devServer: true };
  const lan: OriginPolicy = { port: '3000', lan: true, devServer: false };

  it('loopback: only the backend’s own origin (and the dev server outside production)', () => {
    for (const o of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(isAppOrigin(o, loopback)).toBe(true);
    }
    for (const o of [
      'https://evil.example',
      'http://localhost:8080',
      'http://localhost:4200',
      'null',
      'file://',
      'http://192.168.1.5:3000',
      'http://localhost.evil.example:3000',
      'chrome-extension://abc',
      'not a url',
    ]) {
      expect(isAppOrigin(o, loopback)).toBe(false);
    }
    expect(isAppOrigin('http://localhost:4200', dev)).toBe(true);
    expect(isAppOrigin('http://127.0.0.1:4200', dev)).toBe(true);
    // A rebinding page claims to be same-origin on loopback: still refused.
    expect(isAppOrigin('http://evil.example:3000', loopback, 'evil.example:3000')).toBe(false);
  });

  it('LAN: the rule that mode already had, plus same-origin for a phone on <mac>.local', () => {
    expect(isAppOrigin('http://192.168.1.5:3000', lan)).toBe(true);
    expect(isAppOrigin('http://10.0.0.7:3000', lan)).toBe(true);
    expect(isAppOrigin('http://172.16.0.2:3000', lan)).toBe(true);
    expect(isAppOrigin('http://localhost:3000', lan)).toBe(true);
    expect(isAppOrigin('http://192.168.1.5:4000', lan)).toBe(false);
    expect(isAppOrigin('http://8.8.8.8:3000', lan)).toBe(false);
    expect(isAppOrigin('https://evil.example', lan)).toBe(false);
    expect(isAppOrigin('http://owens-mac-studio.local:3000', lan)).toBe(false); // CORS never needs it
    expect(isAppOrigin('http://owens-mac-studio.local:3000', lan, 'owens-mac-studio.local:3000')).toBe(true);
    expect(isAppOrigin('https://evil.example', lan, 'owens-mac-studio.local:3000')).toBe(false);
  });

  it('writes: safe methods and origin-less callers pass; foreign pages do not', () => {
    expect(writeAllowed('GET', 'https://evil.example', loopback)).toBe(true);
    expect(writeAllowed('POST', undefined, loopback)).toBe(true);
    expect(writeAllowed('POST', 'http://127.0.0.1:3000', loopback)).toBe(true);
    expect(writeAllowed('POST', 'https://evil.example', loopback)).toBe(false);
    expect(writeAllowed('DELETE', 'null', loopback)).toBe(false);
    expect(writeAllowed('PATCH', ['https://evil.example'], loopback)).toBe(false);
  });
});

describe('app origin policy, wired as main.ts wires it', () => {
  describe('loopback (default)', () => {
    let app: INestApplication;
    let port: number;
    let controller: ProbeController;
    beforeAll(async () => {
      ({ app, port, controller } = await boot((p) => ({ port: p, lan: false, devServer: false }), true));
    });
    afterAll(async () => {
      await app?.close();
    });

    it('CORS answers the app’s own origin and never reflects a foreign one', async () => {
      const own = `http://127.0.0.1:${port}`;
      const ok = await request(app.getHttpServer()).get('/probe').set('Origin', own);
      expect(ok.headers['access-control-allow-origin']).toBe(own);
      expect(ok.headers['access-control-allow-credentials']).toBe('true');

      const evil = await request(app.getHttpServer()).get('/probe').set('Origin', 'https://evil.example');
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();

      const preflight = await request(app.getHttpServer())
        .options('/probe')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('a foreign page’s form POST is refused before it runs; the app and origin-less callers get through', async () => {
      const before = controller.writes;
      const evil = await request(app.getHttpServer())
        .post('/probe')
        .set('Origin', 'https://evil.example')
        .type('form')
        .send('url=https://example.com/x');
      expect(evil.status).toBe(403);
      expect(controller.writes).toBe(before);

      const own = await request(app.getHttpServer()).post('/probe').set('Origin', `http://localhost:${port}`).send({});
      expect(own.status).toBe(201);
      const none = await request(app.getHttpServer()).post('/probe').send({});
      expect(none.status).toBe(201);
      expect(controller.writes).toBe(before + 2);
    });

    it('the socket: a foreign page cannot open it (websocket or polling); the app can', async () => {
      expect(await wsUpgrade(port, { Origin: `http://127.0.0.1:${port}` })).toBe(101);
      expect(await wsUpgrade(port, {})).toBe(101);
      expect(await wsUpgrade(port, { Origin: 'https://evil.example' })).not.toBe(101);

      const pollEvil = await request(app.getHttpServer())
        .get('/socket.io/?EIO=4&transport=polling')
        .set('Origin', 'https://evil.example');
      expect(pollEvil.status).toBe(403);
      const pollOwn = await request(app.getHttpServer())
        .get('/socket.io/?EIO=4&transport=polling')
        .set('Origin', `http://localhost:${port}`);
      expect(pollOwn.status).toBe(200);
      expect(pollOwn.headers['access-control-allow-origin']).toBe(`http://localhost:${port}`);
    });
  });

  describe('LAN mode (BRIEFCASE_LAN=1), as the phone uses it', () => {
    let app: INestApplication;
    let port: number;
    beforeAll(async () => {
      ({ app, port } = await boot((p) => ({ port: p, lan: true, devServer: false }), false));
    });
    afterAll(async () => {
      await app?.close();
    });

    it('CORS: private-range hosts on our port, uncredentialed, exactly as before', async () => {
      const phone = `http://192.168.1.23:${port}`;
      const ok = await request(app.getHttpServer()).get('/probe').set('Origin', phone);
      expect(ok.headers['access-control-allow-origin']).toBe(phone);
      expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
      const other = await request(app.getHttpServer()).get('/probe').set('Origin', 'http://192.168.1.23:9999');
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('a phone that loaded the app from <mac>.local (same-origin) can write and open the socket', async () => {
      const host = `owens-mac-studio.local:${port}`;
      const write = await request(app.getHttpServer())
        .post('/probe')
        .set('Host', host)
        .set('Origin', `http://${host}`)
        .send({});
      expect(write.status).toBe(201);
      expect(await wsUpgrade(port, { Host: host, Origin: `http://${host}` })).toBe(101);
      expect(await wsUpgrade(port, { Origin: `http://192.168.1.23:${port}` })).toBe(101);
    });

    it('a foreign page still cannot write or open the socket', async () => {
      const host = `owens-mac-studio.local:${port}`;
      const write = await request(app.getHttpServer())
        .post('/probe')
        .set('Host', host)
        .set('Origin', 'https://evil.example')
        .type('form')
        .send('x=1');
      expect(write.status).toBe(403);
      expect(await wsUpgrade(port, { Host: host, Origin: 'https://evil.example' })).not.toBe(101);
    });
  });
});
