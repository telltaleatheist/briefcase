import { TestBed } from '@angular/core/testing';
import { ErrorSurface } from '../core/error-surface.service';
import { FileImportService } from './file-import.service';
import { NotificationService } from './notification.service';

describe('FileImportService import status', () => {
  let service: FileImportService;
  let notifications: jasmine.SpyObj<NotificationService>;
  let errorSurface: jasmine.SpyObj<ErrorSurface>;
  let resolvers: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }>;
  let originalElectron: unknown;

  const ok = (...paths: string[]) => ({
    success: true,
    results: paths.map(filePath => ({ filePath, success: true })),
  });

  beforeEach(() => {
    resolvers = [];
    originalElectron = (window as any).electron;
    (window as any).electron = {
      importFiles: () => new Promise((resolve, reject) => resolvers.push({ resolve, reject })),
    };
    notifications = jasmine.createSpyObj<NotificationService>('NotificationService', ['toastOnly', 'error', 'warning']);
    errorSurface = jasmine.createSpyObj<ErrorSurface>('ErrorSurface', ['surfaceError']);
    TestBed.configureTestingModule({
      providers: [
        { provide: NotificationService, useValue: notifications },
        { provide: ErrorSurface, useValue: errorSurface },
      ],
    });
    service = TestBed.inject(FileImportService);
  });

  afterEach(() => {
    (window as any).electron = originalElectron;
  });

  it('is idle until an import starts', () => {
    expect(service.importStatus()).toBeNull();
  });

  it('names a single file while it imports, clears on success and confirms', async () => {
    const done = service.importFilesByPath(['/a/b/Show.mp4']);
    expect(service.importStatus()).toBe('Importing Show.mp4…');

    resolvers[0].resolve(ok('/a/b/Show.mp4'));
    await done;

    expect(service.importStatus()).toBeNull();
    expect(notifications.toastOnly).toHaveBeenCalledOnceWith('success', 'Import complete', 'Show.mp4');
  });

  it('counts several files', async () => {
    const done = service.importFilesByPath(['/a/1.mp4', '/a/2.mp4']);
    expect(service.importStatus()).toBe('Importing 2 files…');

    resolvers[0].resolve(ok('/a/1.mp4', '/a/2.mp4'));
    await done;

    expect(notifications.toastOnly).toHaveBeenCalledOnceWith('success', 'Import complete', '2 files');
  });

  it('clears when the import rejects, and surfaces the error', async () => {
    const done = service.importFilesByPath(['/a/1.mp4']);

    resolvers[0].reject(new Error('ipc gone'));
    await done;

    expect(service.importStatus()).toBeNull();
    expect(errorSurface.surfaceError).toHaveBeenCalled();
    expect(notifications.toastOnly).not.toHaveBeenCalled();
  });

  it('clears on a reported failure without confirming success', async () => {
    const done = service.importFilesByPath(['/a/1.mp4']);

    resolvers[0].resolve({ success: false, results: [{ filePath: '/a/1.mp4', success: false, error: 'nope' }] });
    await done;

    expect(service.importStatus()).toBeNull();
    expect(notifications.error).toHaveBeenCalled();
    expect(notifications.toastOnly).not.toHaveBeenCalled();
  });

  it('keeps showing an import when an overlapping one finishes first', async () => {
    const first = service.importFilesByPath(['/a/1.mp4']);
    const second = service.importFilesByPath(['/a/2.mp4']);
    expect(service.importStatus()).toBe('Importing 2 files…');

    resolvers[1].resolve(ok('/a/2.mp4'));
    await second;
    expect(service.importStatus()).toBe('Importing 1.mp4…');

    resolvers[0].resolve(ok('/a/1.mp4'));
    await first;
    expect(service.importStatus()).toBeNull();
  });
});
