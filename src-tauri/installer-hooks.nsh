; 在资源管理器的文件夹右键菜单中加入「Git 代码仓库」（仅当前用户，写入 HKCU，无需管理员权限）
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\PaperGit" "" "Git 代码仓库"
  WriteRegStr HKCU "Software\Classes\Directory\shell\PaperGit" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\PaperGit\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\PaperGit" "" "Git 代码仓库"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\PaperGit" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\PaperGit\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\PaperGit"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\PaperGit"
!macroend
