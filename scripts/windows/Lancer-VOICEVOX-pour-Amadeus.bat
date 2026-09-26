@echo off
setlocal EnableExtensions
title VOICEVOX pour Amadeus
rem Lance le moteur VOICEVOX en acceptant les connexions du telephone (Wi-Fi ou
rem Tailscale). L'application VOICEVOX, elle, n'ecoute que le PC lui-meme.
rem Garder cette fenetre ouverte pendant que Kurisu parle.

set "ENGINE="
if not "%~1"=="" if exist "%~1" set "ENGINE=%~1"
if not defined ENGINE if exist "%LOCALAPPDATA%\Programs\VOICEVOX\vv-engine\run.exe" set "ENGINE=%LOCALAPPDATA%\Programs\VOICEVOX\vv-engine\run.exe"
if not defined ENGINE if exist "%ProgramFiles%\VOICEVOX\vv-engine\run.exe" set "ENGINE=%ProgramFiles%\VOICEVOX\vv-engine\run.exe"
if not defined ENGINE (
  echo [!] Moteur VOICEVOX introuvable.
  echo     Glisse le fichier run.exe ^(dossier "vv-engine" de VOICEVOX^) sur ce script.
  pause
  exit /b 1
)

netstat -ano | findstr /r /c:":50021 .*LISTENING" >nul
if not errorlevel 1 (
  echo [!] Le port 50021 est deja utilise, sans doute par l'application VOICEVOX.
  echo     Ferme VOICEVOX ^(icone pres de l'horloge comprise^) puis relance ce script.
  pause
  exit /b 1
)

netsh advfirewall firewall show rule name="VOICEVOX Amadeus (Tailscale)" >nul 2>&1
if errorlevel 1 (
  net session >nul 2>&1
  if errorlevel 1 (
    echo [!] Il faut autoriser VOICEVOX dans le pare-feu Windows, une seule fois :
    echo     clic droit sur ce fichier, puis "Executer en tant qu'administrateur".
    pause
    exit /b 1
  )
  netsh advfirewall firewall add rule name="VOICEVOX Amadeus (Tailscale)" dir=in action=allow protocol=TCP localport=50021 remoteip=100.64.0.0/10 >nul
  netsh advfirewall firewall add rule name="VOICEVOX Amadeus (Wi-Fi)" dir=in action=allow protocol=TCP localport=50021 remoteip=localsubnet profile=private >nul
  echo Pare-feu : port 50021 autorise pour Tailscale et le reseau prive.
)

echo.
echo Moteur : %ENGINE%
echo Adresses a mettre dans l'app ^(CONFIG ^> Voix^) si le champ vide ne marche pas :
where tailscale >nul 2>&1 && for /f %%i in ('tailscale ip -4 2^>nul') do echo   Tailscale : http://%%i:50021
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do echo   Reseau local :%%i ^(port 50021^)
echo.
echo Laisse cette fenetre ouverte. Ferme-la pour arreter VOICEVOX.
echo.
"%ENGINE%" --host 0.0.0.0 --port 50021
echo.
echo Le moteur VOICEVOX s'est arrete.
pause
