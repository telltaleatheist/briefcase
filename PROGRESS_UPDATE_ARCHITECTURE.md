# Progress Update Architecture

## Overview
The video analysis feature now uses **REST polling** instead of WebSockets for progress updates. This is simpler, more reliable, and works better in Electron environments.

## Architecture

### Before (WebSocket - Complex & Unreliable)
```
Python → PythonBridge → AnalysisService → EventEmitter → 
AnalysisController → WebSocket → SocketService → Component
(6 hops, multiple failure points)
```

### After (REST Polling - Simple & Reliable)
```
Python → PythonBridge → AnalysisService → In-Memory Job Store
                                              ↑
Frontend polls every 500ms ───────────────────┘
(2 hops, minimal complexity)
```

## How It Works

### Backend
1. **Analysis Service** maintains jobs in memory (`Map<string, AnalysisJob>`)
2. **Python callbacks** update job progress via `updateJob()` method
3. **REST endpoint** `/api/api/analysis/job/:jobId` returns current job state

### Frontend
1. **Start analysis** → Receives `jobId`
2. **Poll every 500ms** → `GET /api/api/analysis/job/:jobId`
3. **Update UI** → Display progress, status, phase
4. **Stop when complete** → Job reaches `completed` or `failed` status

## Code Locations

### Backend
- Job storage: [backend/src/analysis/analysis.service.ts:39](backend/src/analysis/analysis.service.ts#L39)
- Update job: [backend/src/analysis/analysis.service.ts:368-379](backend/src/analysis/analysis.service.ts#L368-L379)
- REST endpoint: [backend/src/analysis/analysis.controller.ts:96-108](backend/src/analysis/analysis.controller.ts#L96-L108)

### Frontend
- Start polling: [frontend/src/app/components/video-analysis/video-analysis.component.ts:170-217](frontend/src/app/components/video-analysis/video-analysis.component.ts#L170-L217)
- Stop polling: [frontend/src/app/components/video-analysis/video-analysis.component.ts:222-228](frontend/src/app/components/video-analysis/video-analysis.component.ts#L222-L228)

## Benefits

✅ **Simple** - Just HTTP GET requests, no WebSocket handshakes  
✅ **Reliable** - Works in all environments (Electron, browsers, etc.)  
✅ **Debuggable** - Easy to inspect requests in Network tab  
✅ **Stateless** - No connection management or reconnection logic  
✅ **Scalable** - No open connections consuming server resources  

## Tradeoffs

⚠️ **Higher latency** - Updates every 500ms vs real-time  
⚠️ **More requests** - Polls even when no progress changes  
⚠️ **Bandwidth** - Sends full job object each time  

For video analysis (which takes minutes), these tradeoffs are acceptable.

## Alternative: Server-Sent Events (SSE)

If you need lower latency in the future, consider SSE:
- One-directional (server→client) like polling
- Real-time like WebSockets
- Simpler than WebSockets
- Works over HTTP/2

Example:
```typescript
@Sse('job/:jobId/progress')
streamProgress(@Param('jobId') jobId: string) {
  return interval(100).pipe(
    map(() => ({ data: this.getJob(jobId) }))
  );
}
```
