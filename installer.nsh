!macro customInstall
  ; Add "Convert with Diamond File Converter" to the context menu with icon
  WriteRegStr HKCR "*\shell\DiamondFileConverter" "" "Convert with Diamond File Converter"
  WriteRegStr HKCR "*\shell\DiamondFileConverter" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCR "*\shell\DiamondFileConverter\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; Add the same entry for directories, so a whole folder can be queued
  WriteRegStr HKCR "Directory\shell\DiamondFileConverter" "" "Convert with Diamond File Converter"
  WriteRegStr HKCR "Directory\shell\DiamondFileConverter" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCR "Directory\shell\DiamondFileConverter\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUninstall
  ; Clean up the registry keys on uninstall
  DeleteRegKey HKCR "*\shell\DiamondFileConverter"
  DeleteRegKey HKCR "Directory\shell\DiamondFileConverter"
!macroend
