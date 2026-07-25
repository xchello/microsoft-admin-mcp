# microsoft-admin-mcp

MCP server voor Microsoft **Azure**, **Entra ID**, **Intune** en **PowerShell**. Gebouwd voor IT-beheerders die met Claude (Desktop, Code of Cowork) hun Microsoft-omgevingen willen beheren, scripts willen genereren volgens de nieuwste standaarden, en rapportages willen exporteren naar CSV, XLSX, HTML, PDF en Word.

## Kenmerken

- **Multi-tenant**: definieer meerdere klanten/omgevingen en wissel met een enkele opdracht ("doe dit bij klant X, daarna bij klant Y").
- **Altijd actueel**: ingebouwde tools voor de PowerShell Gallery (nieuwste moduleversies) en Microsoft Learn (actuele documentatie), zodat gegenereerde scripts nooit op verouderde kennis leunen.
- **Veilig standaard**: leesacties draaien direct, elke schrijfactie vereist expliciete bevestiging (`confirm: true`). Destructieve Intune-acties (wipe, retire) vereisen daarnaast de exacte apparaatnaam. Optionele `READ_ONLY` modus blokkeert alle schrijfacties.
- **Rapportage**: exporteer data naar grafisch verzorgde rapporten in csv, xlsx (opgemaakt werkboek), html, pdf en docx.
- **Visualisaties**: genereer infographic-achtige overzichten (gekleurde panelen, icoonkaarten, flow-pijlen) en Mermaid-diagrammen als png, pdf of html.
- **Intune troubleshooting kennis**: de vier-tier forensische methodiek van [powerstacks-corp/intune-advanced-troubleshooting](https://github.com/powerstacks-corp/intune-advanced-troubleshooting) (in de stijl van Rudy Ooms / call4cloud.nl) is meegeleverd, inclusief collector-scripts.
- **PowerShell**: voer scripts lokaal uit (pwsh of Windows PowerShell) en genereer scripts volgens moderne standaarden via de ingebouwde `generate-powershell` prompt.
- **4 auth-modi**: Azure CLI sessie, interactieve browser login, device code en app registration (secret of certificaat).

## Installatie

Vereist Node.js 20 of hoger.

### Optie 1: rechtstreeks vanaf GitHub (aanbevolen, werkt op elk device)

Voeg toe aan je Claude Desktop configuratie (`%APPDATA%\Claude\claude_desktop_config.json` op Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` op macOS):

```json
{
  "mcpServers": {
    "microsoft-admin": {
      "command": "npx",
      "args": ["-y", "github:xchello/microsoft-admin-mcp"],
      "env": {
        "TENANT_ID": "jouw-tenant-id"
      }
    }
  }
}
```

Voor Claude Code:

```bash
claude mcp add microsoft-admin -e TENANT_ID=jouw-tenant-id -- npx -y github:xchello/microsoft-admin-mcp
```

### Optie 2: lokaal clonen

```bash
git clone https://github.com/xchello/microsoft-admin-mcp.git
cd microsoft-admin-mcp
npm install
```

Gebruik daarna `node /pad/naar/microsoft-admin-mcp/dist/index.js` als command in de MCP-configuratie.

## Authenticatie

Zonder verdere configuratie probeert de server eerst je bestaande `az login` sessie en valt terug op device code login (de code verschijnt in de MCP-logs). Instellen via omgevingsvariabelen:

| Variabele | Betekenis |
|---|---|
| `TENANT_ID` | Tenant id of domein. Standaard `common`. |
| `CLIENT_ID` | App registration client id. Standaard de publieke "Microsoft Graph Command Line Tools" app. |
| `CLIENT_SECRET` | Zet app-only auth aan (client credentials). |
| `CERTIFICATE_PATH` | Pad naar PEM-certificaat voor app-only auth (aanbevolen boven een secret). |
| `AUTH_MODE` | `auto`, `cli`, `interactive`, `devicecode` of `app`. |
| `READ_ONLY` | `true` blokkeert alle schrijfacties. |
| `GRAPH_VERSION` | Standaard Graph versie: `v1.0` (default) of `beta`. |
| `POWERSHELL_ENABLED` | `false` schakelt de PowerShell tool uit. |

### Benodigde Graph-permissies

Voor delegated auth (interactief/device code) bepalen je eigen rollen wat er kan. Voor een eigen app registration zijn dit de gangbare permissies:

Lezen: `User.Read.All`, `Group.Read.All`, `Directory.Read.All`, `DeviceManagementManagedDevices.Read.All`, `DeviceManagementApps.Read.All`, `DeviceManagementConfiguration.Read.All`, `AuditLog.Read.All`.

Schrijven (optioneel, alleen wat je nodig hebt, least privilege): `User.ReadWrite.All`, `Group.ReadWrite.All`, `DeviceManagementManagedDevices.ReadWrite.All`, `DeviceManagementManagedDevices.PrivilegedOperations.All` (voor wipe/retire), `DeviceManagementApps.ReadWrite.All`, `DeviceManagementConfiguration.ReadWrite.All`.

Voor Azure Resource Manager: geef de identiteit een passende Azure RBAC-rol (bijv. Reader voor rapportages).

## Meerdere klanten (multi-tenant)

Maak `~/.microsoft-admin-mcp/environments.json` (of zet `ENVIRONMENTS_FILE`):

```json
[
  {
    "name": "klant-x",
    "tenantId": "00000000-0000-0000-0000-000000000001",
    "clientId": "app-id-van-klant-x",
    "clientSecret": "env:KLANTX_SECRET",
    "authMode": "app",
    "description": "Klant X productie"
  },
  {
    "name": "klant-y",
    "tenantId": "klanty.onmicrosoft.com",
    "authMode": "devicecode",
    "description": "Klant Y, delegated login"
  }
]
```

Secrets kun je met `env:NAAM` uit omgevingsvariabelen laten lezen zodat ze niet in het bestand staan. Wissel in het gesprek met "schakel naar klant-y" (tool `environment_use`). Een rapport over meerdere klanten: de assistent bevraagt beide omgevingen en combineert de data in een export.

## Tools

| Tool | Doel |
|---|---|
| `environment_list` / `environment_use` | Klantomgevingen tonen en wisselen |
| `auth_status` | Serverversie, auth-modus, identiteit, tokenstatus |
| `graph_request` | Elke Microsoft Graph call (paging, throttling-retry, v1.0/beta) |
| `azure_request` | Elke Azure Resource Manager call |
| `entra_list_users`, `entra_get_user`, `entra_list_groups`, `entra_group_members` | Entra ID beheer |
| `entra_signin_logs`, `entra_audit_logs` | Sign-in en audit logs |
| `intune_list_devices`, `intune_get_device`, `intune_device_action` | Intune apparaatbeheer |
| `intune_compliance_overview`, `intune_list_apps`, `intune_list_policies` | Intune rapportage en beleid |
| `powershell_run` | PowerShell lokaal uitvoeren (pwsh, fallback Windows PowerShell) |
| `psgallery_module_info` | Nieuwste moduleversie op de PowerShell Gallery |
| `mslearn_search` / `mslearn_fetch` | Actuele Microsoft Learn documentatie zoeken en lezen |
| `export_report` | Rapport exporteren naar csv, xlsx, html, pdf of docx |
| `export_visualization` | Grafisch aantrekkelijke infographics (panelen, icoonkaarten, flow-pijlen) en Mermaid-diagrammen naar html, png of pdf |
| `intune_troubleshooting_guide` | Meegeleverde diepgaande Intune troubleshooting methodiek (vier-tier forensische aanpak) met scripts en uitgewerkte voorbeelden |

Plus de prompt `generate-powershell` voor het genereren van productiewaardige scripts met actuele moduleversies.

## Veiligheidsmodel

1. `READ_ONLY=true` blokkeert elke schrijfactie, ongeacht bevestiging.
2. Schrijfacties zonder `confirm: true` voeren niets uit; ze geven een preview terug en vragen de assistent om eerst expliciete goedkeuring aan jou te vragen.
3. Destructieve Intune-acties (wipe, retire, cleanWindowsDevice, resetPasscode) vereisen bovendien `expectedDeviceName` dat exact overeenkomt met het doelapparaat.
4. PowerShell-scripts met muterende werkwoorden (Set-, New-, Remove-, Invoke-, enz.) vereisen ook bevestiging.
5. Rapporten worden standaard weggeschreven naar `~/microsoft-admin-mcp-reports/`.

## Versies en doorontwikkeling

Dit project gebruikt semantische versienummers (zie `package.json` en `CHANGELOG.md`). De actieve versie zie je via `auth_status`. Verbeteringen: pas de code aan, verhoog het versienummer, vul de changelog aan en push. Devices die via `npx github:...` starten gebruiken automatisch de nieuwste versie van de main branch.

## Licentie

MIT
