import { signal } from '@angular/core';
import { TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { QueueService } from './queue.service';
import { WebsocketService } from './websocket.service';
import { LibraryService } from './library.service';
import { ErrorSurface } from '../core/error-surface.service';
import { LanesStatus } from '../models/queue-lanes.model';

const STORAGE_KEY = 'briefcase-queue-jobs';

/** Captures the handlers QueueService registers, so a test can fire socket events. */
class FakeWebsocket {
  connected = signal(false);
  handlers: Record<string, (event: any) => void> = {};
  connect(): void {}
  private on(name: string) {
    return (cb: (event: any) => void) => {
      this.handlers[name] = cb;
      return () => {};
    };
  }
  onTaskStarted = this.on('task.started');
  onTaskProgress = this.on('task.progress');
  onTaskCompleted = this.on('task.completed');
  onTaskFailed = this.on('task.failed');
  onTaskParked = this.on('task.parked');
  onTaskUnparked = this.on('task.unparked');
  onQueueLanes = this.on('queue.lanes');
}

const lanes = (mode: 'crucible' | 'direct'): LanesStatus => ({
  mode,
  timestamp: '2026-09-23T00:00:00Z',
  lanes: mode === 'direct' ? [] : [{
    id: 'gpu:mac', kind: 'gpu', label: 'GPU · mac', server: 'mac', state: 'ready', detail: null,
    residentModel: null, width: 1, running: [], waiting: 1,
  }],
});

describe('QueueService parked jobs and lanes', () => {
  let service: QueueService;
  let http: HttpTestingController;
  let ws: FakeWebsocket;

  beforeEach(fakeAsync(() => {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: WebsocketService, useClass: FakeWebsocket },
        { provide: LibraryService, useValue: {} },
        { provide: ErrorSurface, useValue: { surfaceError: () => {} } },
      ],
    });
    service = TestBed.inject(QueueService);
    http = TestBed.inject(HttpTestingController);
    ws = TestBed.inject(WebsocketService) as unknown as FakeWebsocket;

    http.expectOne(r => r.url.endsWith('/queue/jobs')).flush({
      success: true,
      jobs: [{
        id: 'b1', status: 'pending', displayName: 'Parked video', videoId: 'v1', currentTaskIndex: 0,
        tasks: [{ type: 'transcribe' }], createdAt: '2026-09-23T00:00:00Z',
        parkedReason: 'Waiting for mac: bookforge is using it.', lane: 'gpu:mac',
      }],
    });
    http.expectOne(r => r.url.endsWith('/queue/lanes')).flush({ success: true, ...lanes('crucible') });
    flushMicrotasks();
  }));

  afterEach(() => {
    http.verify();
    localStorage.removeItem(STORAGE_KEY);
  });

  const job = () => service.allJobs().find(j => j.backendJobId === 'b1')!;

  it('carries parkedReason and lane from GET /queue/jobs, and the job stays pending', () => {
    expect(job().parkedReason).toBe('Waiting for mac: bookforge is using it.');
    expect(job().lane).toBe('gpu:mac');
    expect(job().state).toBe('pending');
    expect(service.pendingJobs().length).toBe(1);
  });

  it('task.unparked clears the reason; task.parked sets it without failing the job', () => {
    ws.handlers['task.unparked']({ jobId: 'b1', timestamp: 'now' });
    expect(job().parkedReason).toBeUndefined();

    ws.handlers['task.parked']({ jobId: 'b1', reason: 'mac is paused.', server: 'mac', timestamp: 'now' });
    expect(job().parkedReason).toBe('mac is paused.');
    expect(job().state).toBe('pending');
    expect(job().errorMessage).toBeUndefined();
  });

  it('task.started clears the reason and records lane and venue', () => {
    ws.handlers['task.started']({ jobId: 'b1', taskId: 't', type: 'transcribe', pool: 'gpu', lane: 'gpu:mac', venue: 'mac' });
    expect(job().parkedReason).toBeUndefined();
    expect(job().venue).toBe('mac');
    expect(job().state).toBe('processing');
  });

  it('loads lanes, follows queue.lanes, and updates from the pause POST', () => {
    expect(service.lanes()?.mode).toBe('crucible');
    ws.handlers['queue.lanes'](lanes('direct'));
    expect(service.lanes()?.lanes.length).toBe(0);

    service.setServerPaused('mac mini', true).subscribe();
    const req = http.expectOne(r => r.url.endsWith('/queue/lanes/mac%20mini/paused'));
    expect(req.request.body).toEqual({ paused: true });
    req.flush({ success: true, ...lanes('crucible') });
    expect(service.lanes()?.lanes[0].server).toBe('mac');
  });
});
