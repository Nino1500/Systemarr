# Systemarr

Ein schlankes, iframe-freundliches Ubuntu-Dashboard für CPU, RAM, Systemlast, Festplatten, Netzwerk, Temperaturen und Systeminformationen.

## Docker auf Ubuntu

```sh
cp .env.example .env
docker compose up -d --build
```

Danach ist Systemarr unter `http://<ubuntu-host>:3010` erreichbar. Das Host-Dateisystem wird ausschließlich lesbar (`read_only`) eingebunden. Dadurch zeigt Systemarr die Werte des Ubuntu-Hosts und nicht nur die des Containers.

## Iframe / Homarr

```text
http://<ubuntu-host>:3010/?embed=1
```

Jede Anzeige hat außerdem eine eigene, bildschirmfüllende Route und kann separat als iframe eingebunden werden:

```text
http://<ubuntu-host>:3010/cpu?embed=1
http://<ubuntu-host>:3010/memory?embed=1
http://<ubuntu-host>:3010/load?embed=1
http://<ubuntu-host>:3010/disks?embed=1
http://<ubuntu-host>:3010/network?embed=1
http://<ubuntu-host>:3010/temperature?embed=1
http://<ubuntu-host>:3010/system?embed=1
```

Die Kurzformen `/ram` und `/storage` funktionieren ebenfalls. `/overview` öffnet das Gesamtdashboard.

Über **Anzeigen** lassen sich einzelne Kacheln ein- und ausblenden. Die Auswahl wird im Browser gespeichert. Für eine feste iframe-Konfiguration können Module auch in der URL stehen:

```text
http://<ubuntu-host>:3010/?embed=1&modules=cpu,memory,disks,network
```

Verfügbare Namen: `cpu`, `memory`, `load`, `disks`, `network`, `temperature`, `system`.

## Konfiguration

| Variable | Standard | Beschreibung |
| --- | --- | --- |
| `SYSTEMARR_PORT` | `3010` | Veröffentlichter Port |
| `REFRESH_SECONDS` | `2` | Aktualisierungsintervall |
| `DISK_PATHS` | automatisch | Kommagetrennte Mountpoints, z. B. `/,/mnt/data` |

Temperaturen erscheinen nur, wenn der Ubuntu-Kernel passende Werte unter `/sys/class/thermal` bereitstellt.

## Lokal entwickeln

```sh
npm install
npm run dev
```
