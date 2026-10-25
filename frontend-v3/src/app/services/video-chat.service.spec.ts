import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { VideoChatService } from './video-chat.service';
import { getApiBase } from '../core/runtime-url';

describe('VideoChatService', () => {
  let service: VideoChatService;
  let http: HttpTestingController;
  const base = `${getApiBase()}/video-chat`;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(VideoChatService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists and creates a video\'s threads', () => {
    service.listThreads('v1').subscribe();
    expect(http.expectOne({ method: 'GET', url: `${base}/videos/v1/threads` })).toBeTruthy();

    service.createThread('v1', 'local:max-27b').subscribe();
    const create = http.expectOne({ method: 'POST', url: `${base}/videos/v1/threads` });
    expect(create.request.body).toEqual({ model: 'local:max-27b' });

    service.createThread('v1').subscribe();
    expect(http.expectOne({ method: 'POST', url: `${base}/videos/v1/threads` }).request.body).toEqual({});
  });

  it('reads, deletes and sends to a thread', () => {
    service.getThread('t1').subscribe();
    http.expectOne({ method: 'GET', url: `${base}/threads/t1` });
    service.deleteThread('t1').subscribe();
    http.expectOne({ method: 'DELETE', url: `${base}/threads/t1` });
    service.sendMessage('t1', 'Where does he mention the flood?', 'local:max-27b').subscribe();
    const send = http.expectOne({ method: 'POST', url: `${base}/threads/t1/messages` });
    expect(send.request.body).toEqual({ content: 'Where does he mention the flood?', model: 'local:max-27b' });
  });

  it('dismisses, restores and applies markers', () => {
    service.setMarkerStatus('m1', 'dismissed').subscribe();
    expect(http.expectOne({ method: 'PATCH', url: `${base}/markers/m1` }).request.body).toEqual({ status: 'dismissed' });
    service.setMarkerStatus('m1', 'proposed').subscribe();
    expect(http.expectOne({ method: 'PATCH', url: `${base}/markers/m1` }).request.body).toEqual({ status: 'proposed' });
    service.applyMarkers('t1', ['m1', 'm2'], 'Flood claims').subscribe();
    expect(http.expectOne({ method: 'POST', url: `${base}/threads/t1/apply` }).request.body)
      .toEqual({ markerIds: ['m1', 'm2'], setName: 'Flood claims' });
  });
});
