@echo off
rem `ccrc` tren Windows — vo mong, khong hon. Moi quyet dinh nam trong
rem term/bin/ccrc-win.js: quet don ho so mo coi, dung host, cho, giao terminal
rem cho client. File nay chi tim `node` va chuyen tham so.
rem
rem VI SAO TU DINH VI BANG %~dp0, khong phai mot cho trong {{CCRC_REPO}} nhu
rem deploy/ccrc: chua co lenh cai nao cho Windows de dien vao cho trong ay.
rem `%~dp0..\term\bin\ccrc-win.js` dung ngay khi nguoi dung them <repo>\deploy
rem vao PATH — khong can buoc cai nao ca. Doi lai: KHONG duoc chep rieng file
rem nay di noi khac, no phai o canh thu muc term\ cua repo.
rem
rem MOI CHU TRONG FILE NAY LA ASCII, co y: cmd.exe doc file .cmd theo code page
rem OEM cua may, nen chu Viet co dau se ra rac ngay tren man hinh nguoi dung.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo [ccrc] Khong tim thay lenh "node". Cai Node.js roi thu lai. 1>&2
  exit /b 127
)
node "%~dp0..\term\bin\ccrc-win.js" %*
exit /b %ERRORLEVEL%
