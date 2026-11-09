import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { QueueService } from './queue.service';
import { WebsocketService } from './websocket.service';
import { LibraryService } from './library.service';
import { ErrorSurface } from '../core/error-surface.service';
import { createQueueTask } from '../models/queue-job.model';

const STORAGE_KEY = 'briefcase-queue-jobs';

class FakeWebsocket {
  connected = signal(false);
  connect(): void {}
  private on() {
    return () => () => {};
  }
  onTaskStarted = this.on();
  onTaskProgress = this.on();
  onTaskCompleted = this.on();
  onTaskFailed = this.on();
  onTaskParked = this.on();
  onTaskUnparked = this.on();
  onQueueLanes = this.on();
}

describe('QueueService download options and live recording', () => {
  let service: QueueService;
  let http: HttpTestingController;
  let surfaceError: jasmine.Spy;

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    surfaceError = jasmine.createSpy('surfaceError');
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: WebsocketService, useClass: FakeWebsocket },
        { provide: LibraryService, useValue: {} },
        { provide: ErrorSurface, useValue: { surfaceError } },
      ],
    });
    service = TestBed.inject(QueueService);
    http = TestBed.inject(HttpTestingController);
  });

  // The service loads the queue and lanes when it starts; those requests are
  // left unanswered, so only each test's own request is asserted.
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  const backendTasks = (options: Record<string, unknown>) =>
    (service as any).convertTasksToBackendFormat([createQueueTask('download-import', options)], true);

  it('gives the download task the quality cap and keep-recording option', () => {
    const download = backendTasks({ quality: '720', keepRecordingLive: true }).find((t: any) => t.type === 'download');
    expect(download.options).toEqual({ quality: '720', keepRecordingLive: true });
  });

  it('sends a plain download task when there are no options', () => {
    const download = backendTasks({}).find((t: any) => t.type === 'download');
    expect(download).toEqual({ type: 'download' });
  });

  it('keeps a recording flagged as progress arrives', () => {
    const job = service.addJob({ title: 'Live', url: 'https://rumble.com/live', tasks: [createQueueTask('download-import', {})] });
    service.updateTaskProgress(job.id, 'download-import', 0, undefined, 'Recording live — 00:00:05', true);
    service.updateTaskProgress(job.id, 'download-import', 0, undefined, 'Recording live — 00:00:06');

    const task = service.allJobs().find(j => j.id === job.id)!.tasks[0];
    expect(task.recording).toBeTrue();
    expect(task.taskLabel).toBe('Recording live — 00:00:06');
  });

  it("stops a submitted job's recording on the backend", () => {
    const job = service.addJob({ title: 'Live', url: 'https://rumble.com/live', tasks: [] });
    (service as any).frontendToBackendIdMap.set(job.id, 'backend-1');

    service.stopRecording(job.id);

    http.expectOne(req => req.method === 'POST' && req.url.endsWith('/queue/job/backend-1/stop-recording')).flush({ success: true });
    expect(surfaceError).not.toHaveBeenCalled();
  });

  it('says so when the job never reached the backend', () => {
    const job = service.addJob({ title: 'Live', url: 'https://rumble.com/live', tasks: [] });
    service.stopRecording(job.id);
    expect(surfaceError).toHaveBeenCalled();
  });
});
