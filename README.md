# Systemarr

A lightweight, iframe-friendly Ubuntu dashboard for CPU, RAM, system load, disks, network, temperatures, fans, and system information.

The interface is English and uses European formatting: 24-hour time, `DD/MM/YYYY` dates, Celsius, and metric units.

## Docker on Ubuntu

```sh
docker compose up -d
```

Compose automatically pulls `ghcr.io/nino1500/systemarr:latest`. Systemarr is then available at `http://<ubuntu-host>:3010`. No `.env` file is required. The host filesystem is mounted read-only (`read_only`), allowing Systemarr to display metrics from the Ubuntu host rather than only from the container.

## Iframe / Homarr

```text
http://<ubuntu-host>:3010/?embed=1
```

Each module also has its own full-screen route and can be embedded as a separate iframe:

```text
http://<ubuntu-host>:3010/cpu?embed=1
http://<ubuntu-host>:3010/memory?embed=1
http://<ubuntu-host>:3010/load?embed=1
http://<ubuntu-host>:3010/disks?embed=1
http://<ubuntu-host>:3010/network?embed=1
http://<ubuntu-host>:3010/temperature?embed=1
http://<ubuntu-host>:3010/fans?embed=1
http://<ubuntu-host>:3010/system?embed=1
```

Single-module iframe routes automatically use a compact layout without the Systemarr header. The CPU route adjusts its gauge, core grid, and chart to the available widget size and hides the chart only in very short iframes.

The RAM card uses the same circular utilization gauge as the CPU card and shows used, total, available, and swap memory. It also displays the hottest detected DIMM temperature from `spd5118`, `jc42`, `peci-dimmtemp`, or an explicitly labelled memory sensor. When the host exposes module information through SMBIOS/DMI or EDAC, the card additionally shows the RAM manufacturer, part number, type, capacity, speed, and slot where available. Hardware fields that Linux does not expose are omitted instead of being guessed.

The `/ram` and `/storage` aliases are also available. `/overview` opens the complete dashboard.

Use **Modules** to show or hide individual cards. The selection is stored in the browser. For a fixed iframe configuration, modules can also be specified in the URL:

```text
http://<ubuntu-host>:3010/?embed=1&modules=cpu,memory,disks,network
```

Available names: `cpu`, `memory`, `load`, `disks`, `network`, `temperature`, `fans`, `system`.

Systemarr automatically discovers sensors through `/sys/class/hwmon`. Depending on the hardware, this includes CPU and motherboard temperatures, NVMe and `drivetemp` disk values, and fan speeds. `/sys/class/thermal` is used as a fallback on minimal systems.

The CPU card also shows the current average frequency, the maximum frequency, and a representative CPU temperature. For CPU temperature, Systemarr prefers AMD `Tdie`, then Intel package temperature, then AMD `Tctl`, with other CPU sensors used only as fallbacks. Disks include their hardware model, while ZFS volumes show their pool and dataset. Fans reporting 0 RPM are hidden; available minimum, maximum, and PWM values are shown as additional details.

## Local development

```sh
npm install
npm run dev
```
