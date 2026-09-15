@echo off
echo ========================================================
echo Instalando dependencias do projeto...
echo (Isso pode levar alguns minutos na primeira vez)
echo ========================================================
call npm install

echo.
echo ========================================================
echo Iniciando o servidor em uma porta livre do computador...
echo Fique de olho na porta exibida abaixo!
echo ========================================================
set PORT=0
call npm start
pause
