; SZ-AI NOC Wall — per-user Windows installer (no administrator rights needed). Built by build-win.sh with makensis.
Unicode true
!define NAME "SZ-AI NOC Wall"
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
Name "${NAME}"
OutFile "${OUTFILE}"
Icon "${ICON}"
UninstallIcon "${ICON}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\SZ-AI NOC Wall"
InstallDirRegKey HKCU "Software\SZ-AI NOC Wall" "InstallDir"
SetCompressor /SOLID lzma
Page components
Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "SZ-AI NOC Wall (required)" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  File "${STAGE}\SZ-AI-NOC-Wall.exe"
  File "${STAGE}\SZ-AI-NOC-Wall.ico"
  File "${STAGE}\README-Windows.txt"
  File "${STAGE}\NODE_LICENSE.txt"
  SetOutPath "$INSTDIR\app"
  File /r "${STAGE}\app\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\SZ-AI NOC Wall" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SZ-AI NOC Wall" "DisplayName" "${NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SZ-AI NOC Wall" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SZ-AI NOC Wall" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SZ-AI NOC Wall" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SZ-AI NOC Wall" "DisplayIcon" "$INSTDIR\SZ-AI-NOC-Wall.ico"
  CreateDirectory "$SMPROGRAMS\SZ-AI NOC Wall"
  CreateShortcut "$SMPROGRAMS\SZ-AI NOC Wall\SZ-AI NOC Wall.lnk" "$INSTDIR\SZ-AI-NOC-Wall.exe" "--open" "$INSTDIR\SZ-AI-NOC-Wall.ico" 0
  CreateShortcut "$SMPROGRAMS\SZ-AI NOC Wall\Uninstall SZ-AI NOC Wall.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section /o "Start SZ-AI NOC Wall when I sign in" SecAuto
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SZ-AI NOC Wall" '"$INSTDIR\SZ-AI-NOC-Wall.exe"'
SectionEnd

Section "Uninstall"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SZ-AI NOC Wall"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SZ-AI NOC Wall"
  DeleteRegKey HKCU "Software\SZ-AI NOC Wall"
  Delete "$SMPROGRAMS\SZ-AI NOC Wall\*.lnk"
  RMDir "$SMPROGRAMS\SZ-AI NOC Wall"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\SZ-AI-NOC-Wall.exe"
  Delete "$INSTDIR\SZ-AI-NOC-Wall.ico"
  Delete "$INSTDIR\README-Windows.txt"
  Delete "$INSTDIR\NODE_LICENSE.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ; your settings, screens and history in %LOCALAPPDATA%\SZ-AI NOC Wall are kept
SectionEnd
