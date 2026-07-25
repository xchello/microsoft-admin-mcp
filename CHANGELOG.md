# Changelog

Alle noemenswaardige wijzigingen aan dit project worden hier bijgehouden.
Het formaat volgt [Keep a Changelog](https://keepachangelog.com/) en het project gebruikt [semantische versienummers](https://semver.org/).

## [0.5.0] - 2026-07-25

### Toegevoegd
- Tenant-kennisbank: de server bouwt per tenant kennis op. `tenant_note_add` slaat een duurzaam feit op (bijvoorbeeld "HPOMEN30L kan geen BitLocker hebben, Windows 11 Home"), `tenant_notes` haalt de kennis terug (met zoekterm of overzicht over alle tenants) en `tenant_note_remove` vergeet een verouderd feit na bevestiging.
- Kennis wordt automatisch teruggegeven bij `environment_use` en `environment_login`, en de contextregel meldt hoeveel notities er voor de actieve tenant bekend zijn, zodat opgeslagen kennis nooit ongemerkt blijft.
- Serverinstructies verplichten de assistent de kennisbank te lezen voordat hij conclusies trekt over compliance of configuratie, en nieuwe tenant-specifieke feiten proactief op te slaan.
- Opslag in `~/.microsoft-admin-mcp/tenant-knowledge.json` (te overrulen met `TENANT_KNOWLEDGE_FILE`), in het gebruikersprofiel en dus buiten het repository: klantkennis gaat nooit mee naar GitHub.

## [0.4.1] - 2026-07-25

### Opgelost
- environments.json met een UTF-8 BOM (zoals PowerShell die schrijft) wordt nu correct gelezen; voorheen werd het bestand stilzwijgend genegeerd.
- local-setup.ps1 schrijft environments.json en claude_desktop_config.json voortaan zonder BOM en ondersteunt Microsoft Store installaties (virtuele AppData-configlocatie).

## [0.4.0] - 2026-07-25

### Toegevoegd
- Interactief tenantbeheer via de chat: `environment_add` (verbind een nieuwe tenant, standaard via browserlogin zonder secrets), `environment_remove` (met bevestiging) en `environment_login` (identiteit controleren).
- Omgevingen worden lokaal opgeslagen in `~/.microsoft-admin-mcp/environments.json` in het gebruikersprofiel, buiten het repository; tenantgegevens gaan dus nooit mee naar GitHub. Secrets bij voorkeur als `env:VARNAAM` verwijzing.

## [0.3.0] - 2026-07-25

### Toegevoegd
- Contextregel bij elke actie: ieder toolresultaat begint met "[microsoft-admin-mcp] omgeving/tenant | LEESACTIE of SCHRIJFACTIE", zodat altijd zichtbaar is in welke tenant iets gebeurt en of het lezen of schrijven is. PowerShell en lokale bestandsexports worden apart gemarkeerd.
- Serverinstructie die de assistent verplicht om bij elke schrijfactie de tenant en het actietype expliciet aan de gebruiker te melden voor de bevestiging.

## [0.2.0] - 2026-07-25

### Toegevoegd
- `export_visualization`: grafisch verzorgde infographics (panelen, icoonkaarten, flow-pijlen, banner) en Mermaid-diagrammen naar html, png en pdf via headless Edge/Chrome.
- `intune_troubleshooting_guide`: meegeleverde vier-tier Intune troubleshooting methodiek (gebaseerd op powerstacks-corp/intune-advanced-troubleshooting) met forensische collector-scripts en uitgewerkte voorbeelden.
- Gedeelde rendermodule (`src/render.ts`) voor pdf en png, met BROWSER_PATH override.

## [0.1.0] - 2026-07-25

### Toegevoegd
- Eerste versie van de MCP server voor Azure, Entra ID, Intune en PowerShell.
- Multi-tenant ondersteuning via environments.json met `environment_list` en `environment_use`.
- Vier auth-modi: Azure CLI, interactieve browser, device code en app registration (secret of certificaat).
- Generieke `graph_request` en `azure_request` met automatische paging en throttling-retry.
- Entra tools: gebruikers, groepen, leden, sign-in logs, audit logs.
- Intune tools: apparaten, remote acties met dubbele beveiliging, compliance-overzicht, apps, policies.
- `powershell_run` met detectie van muterende commando's en bevestigingsplicht.
- Actualiteitstools: `psgallery_module_info`, `mslearn_search`, `mslearn_fetch`.
- `export_report` naar csv, xlsx, html, pdf (headless Edge/Chrome) en docx.
- Prompt `generate-powershell` voor scripts volgens moderne standaarden.
- Veiligheidsmodel: READ_ONLY modus, confirm-vereiste voor schrijfacties, expectedDeviceName voor destructieve Intune-acties.
