; Custom NSIS installer script for ClipChimp
; Provides detailed progress information during installation

!macro customHeader
  ; Add custom includes
  !include "LogicLib.nsh"
  !include "FileFunc.nsh"
!macroend

!macro customInstall
  ; Show initial message
  DetailPrint "Starting ClipChimp installation..."
  DetailPrint ""
  DetailPrint "This may take 3-5 minutes due to large components:"
  DetailPrint "  • Python 3.11.9 runtime (~20 MB)"
  DetailPrint "  • PyTorch libraries (~200 MB)"
  DetailPrint "  • Whisper AI model (~150 MB)"
  DetailPrint "  • FFmpeg/FFprobe binaries (~100 MB)"
  DetailPrint ""
  DetailPrint "Please wait while files are extracted..."
  DetailPrint ""

  ; The installer will continue with normal extraction
  ; DetailPrint messages will show in the install log
!macroend

!macro customInstallMode
  ; Force detailed install mode so user sees progress
  SetDetailsPrint both
!macroend

!macro customUnInstall
  ; Enhanced uninstaller
  DetailPrint "Uninstalling ClipChimp..."
  DetailPrint ""

  ; Remove application directory
  DetailPrint "Removing application files..."
  RMDir /r "$INSTDIR"

  ; Remove user data (optional - ask user first via registry)
  ReadRegStr $0 HKCU "Software\${PRODUCT_NAME}" "KeepUserData"
  ${If} $0 != "1"
    DetailPrint "Removing user data..."
    RMDir /r "$APPDATA\${PRODUCT_NAME}"
    RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}"
  ${Else}
    DetailPrint "Keeping user data (as requested)"
  ${EndIf}

  ; Remove registry keys
  DetailPrint "Cleaning up registry..."
  DeleteRegKey HKCU "Software\${PRODUCT_NAME}"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

  ; Remove shortcuts
  DetailPrint "Removing shortcuts..."
  Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"

  DetailPrint ""
  DetailPrint "Uninstallation complete!"
!macroend

!macro customRemoveFiles
  ; This is called before the main uninstall
  ; Force the app to close if running
  !include "FileFunc.nsh"

  ; Try to close ClipChimp gracefully
  DetailPrint "Checking if ClipChimp is running..."
  nsExec::ExecToStack 'taskkill /IM "ClipChimp.exe" /F'
  Pop $0
  ${If} $0 == 0
    DetailPrint "Closed running ClipChimp instance"
    Sleep 2000
  ${EndIf}
!macroend
