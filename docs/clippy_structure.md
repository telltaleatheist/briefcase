```
/Users/telltale/Projects/clippy/scripts/..
├── backend
│   ├── package-lock.json
│   ├── package.json
│   ├── src
│   │   ├── app.controller.spec.ts
│   │   ├── app.controller.ts
│   │   ├── app.module.ts
│   │   ├── app.service.ts
│   │   ├── common
│   │   │   ├── dto
│   │   │   │   └── download.dto.ts
│   │   │   └── interfaces
│   │   │       └── download.interface.ts
│   │   ├── config
│   │   │   ├── environment.ts
│   │   │   ├── environment.util.ts
│   │   │   ├── shared-config.module.ts
│   │   │   └── shared-config.service.ts
│   │   ├── downloader
│   │   │   ├── batch-downloader.service.ts
│   │   │   ├── downloader.controller.ts
│   │   │   ├── downloader.module.ts
│   │   │   ├── downloader.service.ts
│   │   │   └── yt-dlp-manager.ts
│   │   ├── ffmpeg
│   │   │   ├── ffmpeg.controller.ts
│   │   │   ├── ffmpeg.module.ts
│   │   │   └── ffmpeg.service.ts
│   │   ├── main.ts
│   │   ├── media
│   │   │   ├── media-event.service.ts
│   │   │   ├── media-processing.service.ts
│   │   │   └── media.module.ts
│   │   ├── path
│   │   │   ├── path.controller.ts
│   │   │   ├── path.module.ts
│   │   │   └── path.service.ts
│   │   └── types
│   │       └── node-ffmpeg-installer.d.ts
│   ├── test
│   │   ├── app.e2e-spec.d.ts
│   │   ├── app.e2e-spec.js
│   │   ├── app.e2e-spec.ts
│   │   └── jest-e2e.json
│   ├── tsconfig.build.json
│   ├── tsconfig.build.tsbuildinfo
│   ├── tsconfig.json
│   └── tsconfig.tsbuildinfo
├── config
│   ├── ConfigManager.ts
│   └── index.ts
├── docs
│   ├── backend-refactoring.md
│   ├── clippy_structure.md
│   ├── config-integration-guide.md
│   ├── full_structure.md
│   └── packaged_structure.md
├── downloads
│   └── history.json
├── electron
│   ├── config
│   │   ├── app-config.ts
│   │   └── server-config.ts
│   ├── environment.util.ts
│   ├── index.ts
│   ├── ipc
│   │   └── ipc-handlers.ts
│   ├── main.ts
│   ├── preload.ts
│   ├── services
│   │   ├── backend-service.ts
│   │   ├── download-service.ts
│   │   ├── update-service.ts
│   │   └── window-service.ts
│   ├── tsconfig.electron.json
│   ├── tsconfig.preload.json
│   ├── types
│   │   └── process.d.ts
│   └── utilities
│       ├── download.ts
│       ├── error-windows.ts
│       ├── executables.ts
│       └── log-util.ts
├── frontend
│   ├── angular.json
│   ├── package-lock.json
│   ├── package.json
│   ├── proxy.conf.json
│   ├── public
│   │   └── favicon.ico
│   ├── src
│   │   ├── app
│   │   │   ├── app-routing.module.ts
│   │   │   ├── app.component.html
│   │   │   ├── app.component.scss
│   │   │   ├── app.component.spec.ts
│   │   │   ├── app.component.ts
│   │   │   ├── app.config.server.ts
│   │   │   ├── app.config.ts
│   │   │   ├── app.module.ts
│   │   │   ├── app.routes.ts
│   │   │   ├── components
│   │   │   │   ├── batch-download
│   │   │   │   │   ├── batch-download.component.html
│   │   │   │   │   ├── batch-download.component.scss
│   │   │   │   │   └── batch-download.component.ts
│   │   │   │   ├── download-form
│   │   │   │   │   ├── download-form.component.html
│   │   │   │   │   ├── download-form.component.scss
│   │   │   │   │   ├── download-form.component.ts
│   │   │   │   │   └── download-form.constants.ts
│   │   │   │   ├── download-history
│   │   │   │   │   ├── download-history.component.html
│   │   │   │   │   ├── download-history.component.scss
│   │   │   │   │   └── download-history.component.ts
│   │   │   │   ├── download-progress
│   │   │   │   │   ├── download-progress.component.html
│   │   │   │   │   ├── download-progress.component.scss
│   │   │   │   │   └── download-progress.component.ts
│   │   │   │   ├── executable-error-handler
│   │   │   │   │   ├── executable-config-dialog.component.ts
│   │   │   │   │   └── executable-error-handler.component.ts
│   │   │   │   ├── settings
│   │   │   │   │   ├── settings.component.html
│   │   │   │   │   ├── settings.component.scss
│   │   │   │   │   └── settings.component.ts
│   │   │   │   └── theme-toggle
│   │   │   │       └── theme-toggle.component.ts
│   │   │   ├── core
│   │   │   │   └── logger.service.ts
│   │   │   ├── material.module.ts
│   │   │   ├── models
│   │   │   │   ├── download.model.ts
│   │   │   │   └── settings.model.ts
│   │   │   └── services
│   │   │       ├── api.service.ts
│   │   │       ├── batch-api.service.ts
│   │   │       ├── config.service.ts
│   │   │       ├── path.service.ts
│   │   │       ├── settings.service.ts
│   │   │       ├── socket.service.ts
│   │   │       └── theme.service.ts
│   │   ├── environment
│   │   │   └── environment.ts
│   │   ├── index.html
│   │   ├── main.ts
│   │   ├── material-theme.scss
│   │   ├── styles.scss
│   │   └── types
│   │       └── electron-api.d.ts
│   ├── tsconfig.app.json
│   ├── tsconfig.json
│   └── tsconfig.spec.json
├── index.html
├── package-lock.json
├── package.json
├── README.md
├── scripts
│   ├── refresh-app-tree.sh
│   ├── refresh-full-tree.sh
│   ├── refresh-packaged-app-tree.sh
│   └── refresh-tree.sh
└── utilities
    ├── configDialog.html
    ├── configDialog.ts
    ├── configPreload.ts
    ├── index.ts
    └── PathValidator.ts

41 directories, 128 files
```
