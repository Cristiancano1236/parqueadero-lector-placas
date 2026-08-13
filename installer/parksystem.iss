; ParkSystem - instalador Windows (Inno Setup 6)
; Compilar: ISCC.exe installer\parksystem.iss
; Requiere haber ejecutado antes npm run build (carpeta dist\ lista)

#define MyAppName "ParkSystem"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "ParkSystem"
#define MyAppExeName "parqueadero.exe"
#define MyAppRoot ".."

[Setup]
AppId={{A8F3C2D1-9E47-4B6A-8C1F-2D5E7A9B0C3D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir={#MyAppRoot}\dist-installer
OutputBaseFilename=ParkSystem-Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
SetupLogging=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
InfoAfterFile={#MyAppRoot}\installer\despues-instalar.txt

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "Crear icono en el escritorio"; GroupDescription: "Accesos directos:"

[Files]
Source: "{#MyAppRoot}\dist\parqueadero.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MyAppRoot}\dist\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#MyAppRoot}\dist\tools\*"; DestDir: "{app}\tools"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#MyAppRoot}\dist\scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#MyAppRoot}\dist\schema.sql"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MyAppRoot}\dist\.env.example"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MyAppRoot}\dist\LEEME.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MyAppRoot}\dist\Preparar-HTTPS.bat"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Preparar HTTPS"; Filename: "{app}\Preparar-HTTPS.bat"
Name: "{group}\Desinstalar {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; Genera certificados e instala la CA en Windows
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\setup-https.ps1"" -AppRoot ""{app}"""; \
  StatusMsg: "Preparando HTTPS para la cámara del celular..."; \
  Flags: runhidden waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "Iniciar ParkSystem"; Flags: nowait postinstall skipifsilent
Filename: "{app}\setup-movil-hint.url"; Description: "Abrir guía Conectar celular (después de iniciar)"; Flags: shellexec postinstall skipifsilent unchecked

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  UrlFile: string;
begin
  if CurStep = ssPostInstall then
  begin
    UrlFile := ExpandConstant('{app}\setup-movil-hint.url');
    SaveStringToFile(UrlFile,
      '[InternetShortcut]' + #13#10 +
      'URL=http://localhost:3080/' + #13#10,
      False);
  end;
end;
