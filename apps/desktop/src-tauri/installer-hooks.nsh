!macro NSIS_HOOK_PREUNINSTALL
  SetShellVarContext current
  IfSilent inkline_keep_data
  MessageBox MB_YESNO|MB_ICONQUESTION "是否删除 Inkline 的应用数据？$\r$\n$\r$\n包括环境变量、集合、请求、历史、审计日志与文档草稿。$\r$\n选择“否”将保留数据，重新安装后可继续使用。" IDNO inkline_keep_data
  RMDir /r "$APPDATA\com.inkline.desktop"
  RMDir /r "$LOCALAPPDATA\com.inkline.desktop"
  inkline_keep_data:
!macroend
