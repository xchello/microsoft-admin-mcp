# Changelog

Alle noemenswaardige wijzigingen aan dit project worden hier bijgehouden.
Het formaat volgt [Keep a Changelog](https://keepachangelog.com/) en het project gebruikt [semantische versienummers](https://semver.org/).

## [0.6.0] - 2026-07-25

Grote versie met nieuwe functionaliteit, een testsuite en een reeks beveiligingsreparaties die uit een gerichte audit kwamen.

### Toegevoegd
- Auditlogboek van elke schrijfactie in `~/.microsoft-admin-mcp/audit-log.jsonl`, met tijdstip, omgeving, tenant, tool, geredigeerde argumenten en uitkomst (uitgevoerd, geweigerd, wacht op bevestiging, fout). Uitleesbaar met de nieuwe tool `audit_log`; roteert automatisch en blijft ook bij een oud logboek snel.
- `server_diagnostics`: waar de lokale data staat en welke optionele mogelijkheden (pdf-rendering, persistente login) op deze machine beschikbaar zijn.
- Persistente aanmelding: de aanmelding overleeft een herstart van de host, via de door het besturingssysteem versleutelde tokencache plus een opgeslagen accountverwijzing. Valt netjes terug op opnieuw inloggen als de optionele package ontbreekt.
- `readOnly` per omgeving, zodat je bij een klant alleen kunt rapporteren terwijl je eigen tenant wel wijzigbaar blijft.
- Rechtencontrole vooraf: een Intune-actie waarvoor de aanmelding de permissie mist wordt geweigerd met een duidelijke melding in plaats van een 403 halverwege. `auth_status` toont nu ook wat de huidige identiteit daadwerkelijk mag.
- `intune_device_compliance_detail`: welke policy en welke instelling precies faalt op een device, inclusief encryptie- en Defender-status op Windows.
- `intune_app_assignments`: aan welke groepen een app is toegewezen, met groepsnamen in één gebundelde aanvraag.
- `multi_tenant_query`: dezelfde gegevens over meerdere klanten in één aanroep, met klantkolom, per-klant foutmelding en gegarandeerd herstel van de actieve omgeving.
- Grafieken: donut-, staaf- en horizontale staafdiagrammen als inline SVG in rapporten (html en pdf) en in visualisaties, plus `autoChart` dat zelf de verdeling van een kolom berekent.
- `graphBatch`: meerdere Graph-aanvragen in één ronde, met een garantie dat elk antwoord bij de juiste aanvraag hoort.
- Verversbare kennis: `intune_troubleshooting_guide` kan de nieuwste versie van de troubleshooting-methodiek uit de bron ophalen naar een lokale cache.
- Testsuite (`npm test`) met 33 tests over veiligheidsmodel, omgevingsbeheer, kennisbank, rapportage en classificatie, plus een GitHub Actions build-check op Node 20 en 22 en een `-Tag` optie in push.ps1 voor releasetags.

### Opgelost (beveiliging)
- **PowerShell-classificatie is nu default-deny.** Aantoonbaar konden `-WhatIf:$false`, aliassen als `del` en `rm`, `Out-File`, `[System.IO.File]::Delete`, `iex`, `$ExecutionContext.InvokeCommand.InvokeScript`, methodes op variabelen zoals `$x.Delete()`, reflectie en een HTTP-methode in een variabele of splat als "alleen lezen" doorgaan, waardoor ze zonder bevestiging en zelfs in read-only stand uitgevoerd werden. Een script geldt nu alleen als lezend wanneer elk commando erin herkenbaar lezend is.
- **Wipe zonder naamcontrole.** Als Graph geen apparaatnaam teruggaf, waren beide kanten van de vergelijking leeg en ging een wipe door zonder dat de naam was opgegeven. Nu wordt zo'n actie geweigerd.
- **Verkeerde tenant bij gelijktijdige aanroepen.** Tenantkeuze was globale toestand, waardoor een aanroep die de gebruiker voor klant A goedkeurde bij klant B kon uitkomen, en een klantnotitie in de verkeerde kennisbank kon landen. Tenant-aanroepen worden nu geserialiseerd op de volgorde waarin ze binnenkomen, met een tijdslimiet zodat een openstaande aanmelding de rij niet blokkeert.
- **Geheimen in het auditlogboek.** Een door Graph teruggegeven client secret, tijdelijke toegangspas of storage key kwam letterlijk in het logboek en werd door `audit_log` weer aan het model gegeven. Resultaattekst en bevestigingspreviews worden nu geredigeerd, en de redactie dekt veel meer sleutel- en waardevormen.
- **Read-only was omzeilbaar.** Een nieuwe schrijfbare omgeving toevoegen en daarnaar wisselen omzeilde de hele beveiliging; ook de kennisbank en het verversen van kennis schreven door. Alle drie respecteren nu de read-only stand.
- **Rapporten schreven de verkeerde klant op.** De voettekst en het kengetal kwamen uit de actieve omgeving in plaats van uit de gerapporteerde data, waardoor een document voor klant A de tenant-id van klant B kon prijsgeven. Attributie komt nu uit de data of uit een expliciete parameter.
- **Rapporten overschreven elkaar stil.** Twee exports met dezelfde titel op dezelfde dag schreven hetzelfde bestand; nu zit de klant in de bestandsnaam en wordt een bestaand bestand nooit ongemerkt vervangen.
- **Padveiligheid.** Schrijven in de eigen configuratiemap of een `.git`-map wordt geweigerd, een symlink kan niet meer uit de rapportmap ontsnappen, en overschrijven buiten de rapportmap vereist bevestiging.
- **HTML-injectie.** Namen uit een tenant konden script uitvoeren in de headless browser die pdf en png maakt. Alle ingevoegde tekst wordt nu ontsnapt en kleuren worden gevalideerd.
- **Bestandsrechten.** Alle lokale statusbestanden worden nu als alleen-eigenaar aangemaakt (0600 in een 0700 map) in plaats van wereld-leesbaar.
- **Dataverlies bij een kapot bestand.** Een enkele komma te veel in environments.json wiste bij de volgende schrijfactie al je tenants; kapotte bestanden worden nu bewaard en niet overschreven. Verwijderingen blijven verwijderd, handmatige wijzigingen blijven staan en alle statusbestanden worden atomisch geschreven.
- Verder: geen herhaalde POST of DELETE meer na een 504, `@odata.nextLink` wordt alleen nog naar Graph gevolgd, tijdslimieten op alle externe aanvragen, een onjuiste `REQUEST_TIMEOUT_MS` breekt niets meer, afgekapte lijsten worden expliciet gemeld in plaats van als volledig te gelden, een mislukte gebundelde subaanvraag wordt niet meer als diagnose gepresenteerd, een quadratische regex die de server seconden kon blokkeren is weg, PowerShell-uitvoer meldt afkapping, lange scripts werken ook op Windows, en tijdelijke bestanden met klantdata worden opgeruimd.

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
