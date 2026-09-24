import { signal } from '@angular/core';
import { TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import type { CrucibleReadinessView } from '@crucible-wire/readiness-wire';
import { CrucibleReadinessService, taskNeedsCrucible } from './crucible-readiness.service';
import { WebsocketService } from './websocket.service';
import { readinessView } from './crucible-readiness.testing';

class FakeWebsocket {
  connected = signal(true);
  readinessHandler: ((view: CrucibleReadinessView) => void) | null = null;
  onCrucibleReadiness(cb: (view: CrucibleReadinessView) => void): () => void {
    this.readinessHandler = cb;
    return () => {};
  }
}

describe('CrucibleReadinessService', () => {
  let service: CrucibleReadinessService;
  let http: HttpTestingController;
  let ws: FakeWebsocket;
  let router: jasmine.SpyObj<Router>;

  beforeEach(() => {
    router = jasmine.createSpyObj<Router>('Router', ['navigate']);
    router.navigate.and.resolveTo(true);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: WebsocketService, useClass: FakeWebsocket },
        { provide: Router, useValue: router },
      ],
    });
    service = TestBed.inject(CrucibleReadinessService);
    http = TestBed.inject(HttpTestingController);
    ws = TestBed.inject(WebsocketService) as unknown as FakeWebsocket;
  });

  afterEach(() => http.verify());

  const flushInitial = (view: CrucibleReadinessView) => {
    http.expectOne(r => r.method === 'GET' && r.url.endsWith('/crucible/readiness')).flush(view);
    flushMicrotasks();
  };

  it('reads the view on first use; not ready until it says ready', fakeAsync(() => {
    expect(service.view()).toBeNull();
    expect(service.ready()).toBeFalse();
    flushInitial(readinessView({ state: 'ready', action: null, server: 'mac', reason: 'Crucible is ready on mac.' }));
    expect(service.ready()).toBeTrue();
    expect(service.reason()).toBe('');
    expect(service.doorLabel()).toBeNull();
  }));

  it('follows crucible.readiness socket pushes', fakeAsync(() => {
    flushInitial(readinessView());
    expect(service.ready()).toBeFalse();
    expect(service.doorLabel()).toBe('Start Crucible');

    ws.readinessHandler!(readinessView({ state: 'starting', action: null, progress: 'Loading models' }));
    expect(service.starting()).toBeTrue();

    ws.readinessHandler!(readinessView({ state: 'ready', action: null, server: 'pc' }));
    expect(service.ready()).toBeTrue();
  }));

  it('prompts for waiting AI tasks, or once an AI action asks, but never once declined', fakeAsync(() => {
    flushInitial(readinessView());
    expect(service.prompt()).toBeFalse();

    expect(service.requireReady()).toBeFalse();
    expect(service.prompt()).toBeTrue();

    void service.decline();
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/crucible/readiness/decline'));
    req.flush(readinessView({ declined: true, aiWaiting: 3 }));
    flushMicrotasks();
    expect(service.declined()).toBeTrue();
    expect(service.prompt()).toBeFalse();
    service.requireReady();
    expect(service.prompt()).toBeFalse();
  }));

  it('prompts when AI tasks are parked waiting for Crucible', fakeAsync(() => {
    flushInitial(readinessView({ aiWaiting: 2 }));
    expect(service.prompt()).toBeTrue();
  }));

  it('recognises a crucible_required 409, takes its view, and raises the prompt', fakeAsync(() => {
    flushInitial(readinessView({ state: 'ready', action: null, server: 'mac' }));
    const refused = new HttpErrorResponse({
      status: 409,
      error: {
        code: 'crucible_required',
        message: 'Transcription needs Crucible, and it is not running.',
        readiness: readinessView({ state: 'unreachable', action: 'start' }),
      },
    });
    expect(CrucibleReadinessService.refusalOf(refused)?.code).toBe('crucible_required');
    expect(service.handleRefusal(refused)).toBe('Transcription needs Crucible, and it is not running.');
    expect(service.ready()).toBeFalse();
    expect(service.prompt()).toBeTrue();
    expect(service.refusalMessage()).toContain('Transcription needs Crucible');

    const other409 = new HttpErrorResponse({ status: 409, error: { code: 'duplicate', message: 'x' } });
    expect(CrucibleReadinessService.refusalOf(other409)).toBeNull();
    expect(service.handleRefusal(new HttpErrorResponse({ status: 500 }))).toBeNull();
  }));

  it('the door starts the local Crucible, or opens Settings › Crucible Servers', fakeAsync(() => {
    flushInitial(readinessView({ action: 'start' }));
    void service.openDoor();
    http.expectOne(r => r.method === 'POST' && r.url.endsWith('/crucible/readiness/start'))
      .flush(readinessView({ state: 'starting', action: null }));
    flushMicrotasks();
    expect(service.starting()).toBeTrue();

    ws.readinessHandler!(readinessView({ state: 'not-configured', action: 'connect' }));
    void service.openDoor();
    flushMicrotasks();
    expect(router.navigate).toHaveBeenCalledWith(['/settings/crucible']);
  }));

  it('knows which task types need Crucible', fakeAsync(() => {
    flushInitial(readinessView());
    expect(taskNeedsCrucible('transcribe')).toBeTrue();
    expect(taskNeedsCrucible('ai-analyze')).toBeTrue();
    expect(taskNeedsCrucible('analyze-webpage')).toBeTrue();
    expect(taskNeedsCrucible('download-import')).toBeFalse();
    expect(taskNeedsCrucible('normalize-audio')).toBeFalse();
  }));
});
