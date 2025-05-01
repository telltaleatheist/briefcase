```
/Users/telltale/Documents/software/clippy/scripts/..
├── backend
│   ├── dist
│   │   ├── app.controller.d.ts
│   │   ├── app.controller.js
│   │   ├── app.controller.js.map
│   │   ├── app.module.d.ts
│   │   ├── app.module.js
│   │   ├── app.module.js.map
│   │   ├── app.service.d.ts
│   │   ├── app.service.js
│   │   ├── app.service.js.map
│   │   ├── common
│   │   │   ├── dto
│   │   │   │   ├── download.dto.d.ts
│   │   │   │   ├── download.dto.js
│   │   │   │   └── download.dto.js.map
│   │   │   └── interfaces
│   │   │       ├── download.interface.d.ts
│   │   │       ├── download.interface.js
│   │   │       └── download.interface.js.map
│   │   ├── config
│   │   │   ├── environment.d.ts
│   │   │   ├── environment.js
│   │   │   ├── environment.js.map
│   │   │   ├── environment.util.d.ts
│   │   │   ├── environment.util.js
│   │   │   └── environment.util.js.map
│   │   ├── downloader
│   │   │   ├── batch-downloader.service.d.ts
│   │   │   ├── batch-downloader.service.js
│   │   │   ├── batch-downloader.service.js.map
│   │   │   ├── downloader.controller.d.ts
│   │   │   ├── downloader.controller.js
│   │   │   ├── downloader.controller.js.map
│   │   │   ├── downloader.module.d.ts
│   │   │   ├── downloader.module.js
│   │   │   ├── downloader.module.js.map
│   │   │   ├── downloader.service.d.ts
│   │   │   ├── downloader.service.js
│   │   │   ├── downloader.service.js.map
│   │   │   ├── yt-dlp-manager.d.ts
│   │   │   ├── yt-dlp-manager.js
│   │   │   └── yt-dlp-manager.js.map
│   │   ├── ffmpeg
│   │   │   ├── ffmpeg.controller.d.ts
│   │   │   ├── ffmpeg.controller.js
│   │   │   ├── ffmpeg.controller.js.map
│   │   │   ├── ffmpeg.module.d.ts
│   │   │   ├── ffmpeg.module.js
│   │   │   ├── ffmpeg.module.js.map
│   │   │   ├── ffmpeg.service.d.ts
│   │   │   ├── ffmpeg.service.js
│   │   │   └── ffmpeg.service.js.map
│   │   ├── main.d.ts
│   │   ├── main.js
│   │   ├── main.js.map
│   │   └── path
│   │       ├── path.controller.d.ts
│   │       ├── path.controller.js
│   │       ├── path.controller.js.map
│   │       ├── path.module.d.ts
│   │       ├── path.module.js
│   │       ├── path.module.js.map
│   │       ├── path.service.d.ts
│   │       ├── path.service.js
│   │       └── path.service.js.map
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
│   │   │   └── environment.util.ts
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
├── dist-electron
│   ├── builder-debug.yml
│   ├── builder-effective-config.yaml
│   ├── Clippy-1.0.0-arm64.dmg
│   ├── Clippy-1.0.0-arm64.dmg.blockmap
│   ├── latest-mac.yml
│   ├── mac-arm64
│   │   └── Clippy.app
│   │       └── Contents
│   │           ├── Frameworks
│   │           │   ├── Clippy Helper (GPU).app
│   │           │   │   └── Contents
│   │           │   │       ├── Info.plist
│   │           │   │       ├── MacOS
│   │           │   │       │   └── Clippy Helper (GPU)
│   │           │   │       └── PkgInfo
│   │           │   ├── Clippy Helper (Plugin).app
│   │           │   │   └── Contents
│   │           │   │       ├── Info.plist
│   │           │   │       ├── MacOS
│   │           │   │       │   └── Clippy Helper (Plugin)
│   │           │   │       └── PkgInfo
│   │           │   ├── Clippy Helper (Renderer).app
│   │           │   │   └── Contents
│   │           │   │       ├── Info.plist
│   │           │   │       ├── MacOS
│   │           │   │       │   └── Clippy Helper (Renderer)
│   │           │   │       └── PkgInfo
│   │           │   ├── Clippy Helper.app
│   │           │   │   └── Contents
│   │           │   │       ├── Info.plist
│   │           │   │       ├── MacOS
│   │           │   │       │   └── Clippy Helper
│   │           │   │       └── PkgInfo
│   │           │   ├── Electron Framework.framework
│   │           │   │   ├── Electron Framework -> Versions/Current/Electron Framework
│   │           │   │   ├── Helpers -> Versions/Current/Helpers
│   │           │   │   ├── Libraries -> Versions/Current/Libraries
│   │           │   │   ├── Resources -> Versions/Current/Resources
│   │           │   │   └── Versions
│   │           │   │       ├── A
│   │           │   │       │   ├── Electron Framework
│   │           │   │       │   ├── Helpers
│   │           │   │       │   │   └── chrome_crashpad_handler
│   │           │   │       │   ├── Libraries
│   │           │   │       │   │   ├── libEGL.dylib
│   │           │   │       │   │   ├── libffmpeg.dylib
│   │           │   │       │   │   ├── libGLESv2.dylib
│   │           │   │       │   │   ├── libvk_swiftshader.dylib
│   │           │   │       │   │   └── vk_swiftshader_icd.json
│   │           │   │       │   └── Resources
│   │           │   │       │       ├── af.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── am.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── ar.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── bg.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── bn.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── ca.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── chrome_100_percent.pak
│   │           │   │       │       ├── chrome_200_percent.pak
│   │           │   │       │       ├── cs.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── da.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── de.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── el.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── en_GB.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── en.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── es_419.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── es.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── et.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── fa.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── fi.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── fil.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── fr.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── gu.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── he.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── hi.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── hr.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── hu.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── icudtl.dat
│   │           │   │       │       ├── id.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── Info.plist
│   │           │   │       │       ├── it.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── ja.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── kn.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── ko.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── lt.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── lv.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── MainMenu.nib
│   │           │   │       │       ├── ml.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── mr.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── ms.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── nb.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── nl.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── pl.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── pt_BR.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── pt_PT.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── resources.pak
│   │           │   │       │       ├── ro.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── ru.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── sk.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── sl.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── sr.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── sv.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── sw.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── ta.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── te.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── th.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── tr.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── uk.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── ur.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── v8_context_snapshot.arm64.bin
│   │           │   │       │       ├── vi.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       ├── zh_CN.lproj
│   │           │   │       │       │   └── locale.pak
│   │           │   │       │       └── zh_TW.lproj
│   │           │   │       │           └── locale.pak
│   │           │   │       └── Current -> A
│   │           │   ├── Mantle.framework
│   │           │   │   ├── Mantle -> Versions/Current/Mantle
│   │           │   │   ├── Resources -> Versions/Current/Resources
│   │           │   │   └── Versions
│   │           │   │       ├── A
│   │           │   │       │   ├── Mantle
│   │           │   │       │   └── Resources
│   │           │   │       │       └── Info.plist
│   │           │   │       └── Current -> A
│   │           │   ├── ReactiveObjC.framework
│   │           │   │   ├── ReactiveObjC -> Versions/Current/ReactiveObjC
│   │           │   │   ├── Resources -> Versions/Current/Resources
│   │           │   │   └── Versions
│   │           │   │       ├── A
│   │           │   │       │   ├── ReactiveObjC
│   │           │   │       │   └── Resources
│   │           │   │       │       └── Info.plist
│   │           │   │       └── Current -> A
│   │           │   └── Squirrel.framework
│   │           │       ├── Resources -> Versions/Current/Resources
│   │           │       ├── Squirrel -> Versions/Current/Squirrel
│   │           │       └── Versions
│   │           │           ├── A
│   │           │           │   ├── Resources
│   │           │           │   │   ├── Info.plist
│   │           │           │   │   └── ShipIt
│   │           │           │   └── Squirrel
│   │           │           └── Current -> A
│   │           ├── Info.plist
│   │           ├── MacOS
│   │           │   └── Clippy
│   │           ├── PkgInfo
│   │           └── Resources
│   │               ├── af.lproj
│   │               ├── am.lproj
│   │               ├── app-update.yml
│   │               ├── app.asar
│   │               ├── app.asar.unpacked
│   │               │   └── backend
│   │               ├── ar.lproj
│   │               ├── bg.lproj
│   │               ├── bn.lproj
│   │               ├── ca.lproj
│   │               ├── cs.lproj
│   │               ├── da.lproj
│   │               ├── de.lproj
│   │               ├── el.lproj
│   │               ├── electron.icns
│   │               ├── en_GB.lproj
│   │               ├── en.lproj
│   │               ├── es_419.lproj
│   │               ├── es.lproj
│   │               ├── et.lproj
│   │               ├── fa.lproj
│   │               ├── fi.lproj
│   │               ├── fil.lproj
│   │               ├── fr.lproj
│   │               ├── gu.lproj
│   │               ├── he.lproj
│   │               ├── hi.lproj
│   │               ├── hr.lproj
│   │               ├── hu.lproj
│   │               ├── id.lproj
│   │               ├── it.lproj
│   │               ├── ja.lproj
│   │               ├── kn.lproj
│   │               ├── ko.lproj
│   │               ├── lt.lproj
│   │               ├── lv.lproj
│   │               ├── ml.lproj
│   │               ├── mr.lproj
│   │               ├── ms.lproj
│   │               ├── nb.lproj
│   │               ├── nl.lproj
│   │               ├── pl.lproj
│   │               ├── pt_BR.lproj
│   │               ├── pt_PT.lproj
│   │               ├── ro.lproj
│   │               ├── ru.lproj
│   │               ├── sk.lproj
│   │               ├── sl.lproj
│   │               ├── sr.lproj
│   │               ├── sv.lproj
│   │               ├── sw.lproj
│   │               ├── ta.lproj
│   │               ├── te.lproj
│   │               ├── th.lproj
│   │               ├── tr.lproj
│   │               ├── uk.lproj
│   │               ├── ur.lproj
│   │               ├── vi.lproj
│   │               ├── zh_CN.lproj
│   │               └── zh_TW.lproj
│   ├── main
│   │   ├── config
│   │   │   ├── ConfigManager.js
│   │   │   ├── ConfigManager.js.map
│   │   │   ├── index.js
│   │   │   └── index.js.map
│   │   ├── electron
│   │   │   ├── environment.util.js
│   │   │   ├── environment.util.js.map
│   │   │   ├── index.js
│   │   │   ├── index.js.map
│   │   │   ├── main.js
│   │   │   ├── main.js.map
│   │   │   ├── preload.js
│   │   │   ├── preload.js.map
│   │   │   └── utilities
│   │   │       ├── download.js
│   │   │       └── download.js.map
│   │   └── utilities
│   │       ├── configDialog.js
│   │       ├── configDialog.js.map
│   │       ├── configPreload.js
│   │       ├── configPreload.js.map
│   │       ├── index.js
│   │       ├── index.js.map
│   │       ├── PathValidator.js
│   │       └── PathValidator.js.map
│   └── preload
│       ├── config
│       │   ├── ConfigManager.js
│       │   └── ConfigManager.js.map
│       ├── electron
│       │   ├── environment.util.js
│       │   ├── environment.util.js.map
│       │   ├── index.js
│       │   ├── index.js.map
│       │   ├── main.js
│       │   ├── main.js.map
│       │   ├── preload.js
│       │   ├── preload.js.map
│       │   └── utilities
│       │       ├── download.js
│       │       └── download.js.map
│       └── utilities
│           ├── configDialog.js
│           ├── configDialog.js.map
│           ├── PathValidator.js
│           └── PathValidator.js.map
├── docs
│   ├── clippy_structure.md
│   ├── completed_app_structure.md
│   ├── config-integration-guide.md
│   ├── development.md
│   ├── full_structure.md
│   ├── packaged_structure.md
│   └── testUrls.md
├── downloads
│   └── history.json
├── electron
│   ├── environment.util.ts
│   ├── index.ts
│   ├── main.ts
│   ├── preload.ts
│   ├── tsconfig.electron.json
│   ├── tsconfig.preload.json
│   ├── types
│   │   └── process.d.ts
│   └── utilities
│       └── download.ts
├── frontend
│   ├── angular.json
│   ├── dist
│   │   ├── clippy-frontend
│   │   │   ├── 3rdpartylicenses.txt
│   │   │   ├── browser
│   │   │   │   ├── chunk-6KOQWOIZ.js
│   │   │   │   ├── chunk-ENXQB46L.js
│   │   │   │   ├── chunk-EXQFMX5D.js
│   │   │   │   ├── chunk-LJFZY62H.js
│   │   │   │   ├── chunk-NO6WRW6C.js
│   │   │   │   ├── chunk-ON3PFF7T.js
│   │   │   │   ├── chunk-TK2FGPT3.js
│   │   │   │   ├── chunk-VUD6VB6S.js
│   │   │   │   ├── favicon.ico
│   │   │   │   ├── index.html
│   │   │   │   ├── main-6MUDFVRO.js
│   │   │   │   ├── polyfills-FFHMD2TL.js
│   │   │   │   └── styles-FBVOPZU6.css
│   │   │   └── prerendered-routes.json
│   │   ├── clippy-frontend 2
│   │   └── out-tsc
│   │       ├── app
│   │       │   ├── app-routing.module.js
│   │       │   ├── app-routing.module.js.map
│   │       │   ├── app.component.js
│   │       │   ├── app.component.js.map
│   │       │   ├── app.config.js
│   │       │   ├── app.config.js.map
│   │       │   ├── app.config.server.js
│   │       │   ├── app.config.server.js.map
│   │       │   ├── app.module.js
│   │       │   ├── app.module.js.map
│   │       │   ├── app.routes.js
│   │       │   ├── app.routes.js.map
│   │       │   ├── components
│   │       │   │   ├── batch-download
│   │       │   │   │   ├── batch-download.component.js
│   │       │   │   │   └── batch-download.component.js.map
│   │       │   │   ├── download-form
│   │       │   │   │   ├── download-form.component.js
│   │       │   │   │   ├── download-form.component.js.map
│   │       │   │   │   ├── download-form.constants.js
│   │       │   │   │   └── download-form.constants.js.map
│   │       │   │   ├── download-history
│   │       │   │   │   ├── download-history.component.js
│   │       │   │   │   └── download-history.component.js.map
│   │       │   │   ├── download-progress
│   │       │   │   │   ├── download-progress.component.js
│   │       │   │   │   └── download-progress.component.js.map
│   │       │   │   ├── executable-error-handler
│   │       │   │   │   ├── executable-config-dialog.component.js
│   │       │   │   │   ├── executable-config-dialog.component.js.map
│   │       │   │   │   ├── executable-error-handler.component.js
│   │       │   │   │   └── executable-error-handler.component.js.map
│   │       │   │   ├── settings
│   │       │   │   │   ├── settings.component.js
│   │       │   │   │   └── settings.component.js.map
│   │       │   │   └── theme-toggle
│   │       │   │       ├── theme-toggle.component.js
│   │       │   │       └── theme-toggle.component.js.map
│   │       │   ├── core
│   │       │   │   ├── logger.service.js
│   │       │   │   └── logger.service.js.map
│   │       │   ├── material.module.js
│   │       │   ├── material.module.js.map
│   │       │   ├── models
│   │       │   │   ├── download.model.js
│   │       │   │   ├── download.model.js.map
│   │       │   │   ├── settings.model.js
│   │       │   │   └── settings.model.js.map
│   │       │   └── services
│   │       │       ├── api.service.js
│   │       │       ├── api.service.js.map
│   │       │       ├── batch-api.service.js
│   │       │       ├── batch-api.service.js.map
│   │       │       ├── config.service.js
│   │       │       ├── config.service.js.map
│   │       │       ├── path.service.js
│   │       │       ├── path.service.js.map
│   │       │       ├── settings.service.js
│   │       │       ├── settings.service.js.map
│   │       │       ├── socket.service.js
│   │       │       ├── socket.service.js.map
│   │       │       ├── theme.service.js
│   │       │       └── theme.service.js.map
│   │       ├── environment
│   │       │   ├── environment.js
│   │       │   └── environment.js.map
│   │       ├── main.js
│   │       └── main.js.map
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
├── scripts
│   ├── analyze-dependencies.js
│   ├── refresh-app-tree.sh
│   ├── refresh-full-tree.sh
│   ├── refresh-packaged-app-tree.sh
│   └── refresh-tree.sh
├── utilities
│   ├── configDialog.html
│   ├── configDialog.ts
│   ├── configPreload.ts
│   ├── index.ts
│   └── PathValidator.ts
└── yarn.lock

232 directories, 385 files
```
