import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, readdir, statfs } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { cpus, freemem, hostname as localHostname, loadavg, platform, release, totalmem, uptime } from "node:os";

const port = Number(process.env.PORT ?? 3010);
const publicDirectory = join(__dirname, "public");
const hostRoot = process.env.HOST_ROOT ?? "/host";
const procRoot = process.env.PROC_ROOT ?? "/host/proc";
const sysRoot = process.env.SYS_ROOT ?? "/host/sys";
const refreshSeconds = Math.max(1, Number(process.env.REFRESH_SECONDS ?? 2));
const dashboardRoutes = new Set([
  "/overview", "/cpu", "/memory", "/ram", "/load", "/disks", "/storage",
  "/network", "/temperature", "/temperatures", "/fans", "/system",
]);

interface CpuTimes { idle: number; total: number }
interface CpuSnapshot extends CpuTimes { cores: CpuTimes[] }
interface NetworkSnapshot { received: number; transmitted: number; at: number }
interface TemperatureSensor { label: string; celsius: number; source: string; category: string }
interface MemoryModule {
  label: string;
  manufacturer?: string;
  partNumber?: string;
  type?: string;
  size?: number;
  speedMTs?: number;
  deviceType?: string;
}

let previousCpu: CpuSnapshot | undefined;
let previousNetwork: NetworkSnapshot | undefined;
let memoryHardwareCache: Promise<{ source?: string; modules: MemoryModule[] }> | undefined;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch { return undefined; }
}

function usefulHardwareString(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned && !/^(?:unknown|not specified|none|no dimm|n\/a|0+)$/i.test(cleaned) ? cleaned : undefined;
}

function percentage(value: number, maximum: number): number {
  return maximum > 0 ? Math.min(100, Math.max(0, value / maximum * 100)) : 0;
}

function average(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

async function cpuFrequency(cpuInfo?: string) {
  const cpuRoot = join(sysRoot, "devices", "system", "cpu");
  let frequencyDirectories: string[] = [];
  try {
    const policyRoot = join(cpuRoot, "cpufreq");
    frequencyDirectories = (await readdir(policyRoot))
      .filter((name) => /^policy\d+$/.test(name))
      .map((name) => join(policyRoot, name));
  } catch { /* Some drivers expose cpufreq only below the individual CPUs. */ }

  if (!frequencyDirectories.length) {
    try {
      frequencyDirectories = (await readdir(cpuRoot))
        .filter((name) => /^cpu\d+$/.test(name))
        .map((name) => join(cpuRoot, name, "cpufreq"));
    } catch { /* Fall back to /proc/cpuinfo below. */ }
  }

  const readings = await Promise.all(frequencyDirectories.map(async (directory) => {
    const current = await readText(join(directory, "scaling_cur_freq"));
    const maximum = await readText(join(directory, "cpuinfo_max_freq")) ?? await readText(join(directory, "scaling_max_freq"));
    const parse = (value: string | undefined) => {
      const frequency = Number(value?.trim());
      return Number.isFinite(frequency) && frequency > 0 ? frequency / 1_000_000 : undefined;
    };
    return { current: parse(current), maximum: parse(maximum) };
  }));

  const currentValues = readings.flatMap(({ current }) => current === undefined ? [] : [current]);
  const maximumValues = readings.flatMap(({ maximum }) => maximum === undefined ? [] : [maximum]);
  let currentGHz = average(currentValues);
  if (currentGHz === undefined && cpuInfo) {
    const mhzValues = [...cpuInfo.matchAll(/^cpu MHz\s*:\s*([\d.]+)$/gm)]
      .map((match) => Number(match[1])).filter(Number.isFinite);
    const currentMhz = average(mhzValues);
    if (currentMhz !== undefined) currentGHz = currentMhz / 1000;
  }
  const maxGHz = maximumValues.length ? Math.max(...maximumValues) : undefined;
  return currentGHz === undefined && maxGHz === undefined
    ? undefined
    : { currentGHz, maxGHz };
}

async function cpuMetrics() {
  const stat = await readText(join(procRoot, "stat"));
  if (!stat) {
    const cores = cpus();
    const coreTimes = cores.map((cpu) => ({ idle: cpu.times.idle, total: Object.values(cpu.times).reduce((a, b) => a + b, 0) }));
    const current = {
      idle: coreTimes.reduce((sum, core) => sum + core.idle, 0),
      total: coreTimes.reduce((sum, core) => sum + core.total, 0),
      cores: coreTimes,
    };
    const deltaTotal = previousCpu ? current.total - previousCpu.total : 0;
    const usage = previousCpu && deltaTotal > 0 ? percentage(deltaTotal - (current.idle - previousCpu.idle), deltaTotal) : 0;
    const coreUsage = current.cores.map((core, index) => {
      const previous = previousCpu?.cores[index];
      const elapsed = previous ? core.total - previous.total : 0;
      return previous && elapsed > 0 ? percentage(elapsed - (core.idle - previous.idle), elapsed) : 0;
    });
    previousCpu = current;
    const currentMhz = average(cores.map((cpu) => cpu.speed).filter((speed) => speed > 0));
    return {
      usage, cores: cores.length, coreUsage, model: cores[0]?.model ?? "CPU",
      frequency: currentMhz === undefined ? undefined : { currentGHz: currentMhz / 1000 },
    };
  }

  const lines = stat.split("\n");
  const values = lines[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const deltaTotal = previousCpu ? total - previousCpu.total : 0;
  const usage = previousCpu && deltaTotal > 0 ? percentage(deltaTotal - (idle - previousCpu.idle), deltaTotal) : 0;
  const coreTimes = lines.filter((line) => /^cpu\d+\s/.test(line)).map((line) => {
    const coreValues = line.trim().split(/\s+/).slice(1).map(Number);
    return { idle: (coreValues[3] ?? 0) + (coreValues[4] ?? 0), total: coreValues.reduce((sum, value) => sum + value, 0) };
  });
  const coreUsage = coreTimes.map((core, index) => {
    const previous = previousCpu?.cores[index];
    const elapsed = previous ? core.total - previous.total : 0;
    return previous && elapsed > 0 ? percentage(elapsed - (core.idle - previous.idle), elapsed) : 0;
  });
  previousCpu = { idle, total, cores: coreTimes };
  const coreCount = coreTimes.length;
  const cpuInfo = await readText(join(procRoot, "cpuinfo"));
  const model = cpuInfo?.match(/^(?:model name|Hardware)\s*:\s*(.+)$/m)?.[1]?.trim() ?? "CPU";
  return { usage, cores: coreCount, coreUsage, model, frequency: await cpuFrequency(cpuInfo) };
}

async function memoryMetrics() {
  const [info, hardware] = await Promise.all([readText(join(procRoot, "meminfo")), memoryHardware()]);
  if (!info) {
    const total = totalmem();
    const available = freemem();
    return { total, used: total - available, available, usage: percentage(total - available, total), swapTotal: 0, swapUsed: 0, hardware };
  }
  const values = new Map<string, number>();
  for (const line of info.split("\n")) {
    const match = line.match(/^(\w+):\s+(\d+)/);
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  const total = values.get("MemTotal") ?? 0;
  const available = values.get("MemAvailable") ?? values.get("MemFree") ?? 0;
  const swapTotal = values.get("SwapTotal") ?? 0;
  const swapFree = values.get("SwapFree") ?? 0;
  return { total, used: total - available, available, usage: percentage(total - available, total), swapTotal, swapUsed: swapTotal - swapFree, hardware };
}

const dmiMemoryTypes: Record<number, string> = {
  18: "DDR", 19: "DDR2", 20: "DDR2 FB-DIMM", 24: "DDR3", 26: "DDR4",
  27: "LPDDR", 28: "LPDDR2", 29: "LPDDR3", 30: "LPDDR4", 34: "DDR5", 35: "LPDDR5",
};

function parseDmiMemoryModule(raw: Buffer, index: number): MemoryModule | undefined {
  if (raw.length < 0x1b || raw[0] !== 17) return undefined;
  const formattedLength = raw[1];
  if (formattedLength < 0x1b || raw.length < formattedLength) return undefined;
  const strings = raw.subarray(formattedLength).toString("utf8").split("\0");
  const stringAt = (offset: number) => {
    const stringIndex = raw[offset] ?? 0;
    return stringIndex > 0 ? usefulHardwareString(strings[stringIndex - 1]) : undefined;
  };

  const sizeValue = raw.readUInt16LE(0x0c);
  if (sizeValue === 0) return undefined;
  let size: number | undefined;
  if (sizeValue === 0x7fff && formattedLength >= 0x20) size = raw.readUInt32LE(0x1c) * 1024 * 1024;
  else if (sizeValue !== 0xffff) size = (sizeValue & 0x7fff) * ((sizeValue & 0x8000) ? 1024 : 1024 * 1024);

  const configuredSpeed = formattedLength >= 0x22 ? raw.readUInt16LE(0x20) : 0;
  const ratedSpeed = formattedLength >= 0x17 ? raw.readUInt16LE(0x15) : 0;
  const speed = configuredSpeed && configuredSpeed !== 0xffff ? configuredSpeed : ratedSpeed && ratedSpeed !== 0xffff ? ratedSpeed : undefined;
  return {
    label: stringAt(0x10) ?? stringAt(0x11) ?? `Module ${index + 1}`,
    manufacturer: stringAt(0x17),
    partNumber: stringAt(0x1a),
    type: dmiMemoryTypes[raw[0x12]],
    size,
    speedMTs: speed,
  };
}

async function dmiMemoryModules(): Promise<MemoryModule[]> {
  const entriesRoot = join(sysRoot, "firmware", "dmi", "entries");
  try {
    const entries = (await readdir(entriesRoot)).filter((name) => /^17-\d+$/.test(name));
    const modules = await Promise.all(entries.map(async (entry, index) => {
      try { return parseDmiMemoryModule(await readFile(join(entriesRoot, entry, "raw")), index); }
      catch { return undefined; }
    }));
    return modules.filter((module): module is MemoryModule => module !== undefined);
  } catch { return []; }
}

async function edacMemoryModules(): Promise<MemoryModule[]> {
  const controllersRoot = join(sysRoot, "devices", "system", "edac", "mc");
  try {
    const controllers = (await readdir(controllersRoot)).filter((name) => /^mc\d+$/.test(name));
    const modules: MemoryModule[] = [];
    for (const controller of controllers) {
      const controllerRoot = join(controllersRoot, controller);
      const entries = (await readdir(controllerRoot)).filter((name) => /^(?:dimm|rank)\d+$/.test(name));
      for (const entry of entries) {
        const base = join(controllerRoot, entry);
        const [sizeRaw, labelRaw, locationRaw, typeRaw, deviceTypeRaw] = await Promise.all([
          readText(join(base, "size")), readText(join(base, "dimm_label")), readText(join(base, "dimm_location")),
          readText(join(base, "dimm_mem_type")), readText(join(base, "dimm_dev_type")),
        ]);
        const sizeMb = Number(sizeRaw?.trim());
        if (!Number.isFinite(sizeMb) || sizeMb <= 0) continue;
        modules.push({
          label: usefulHardwareString(labelRaw) ?? usefulHardwareString(locationRaw) ?? `${controller} ${entry}`,
          type: usefulHardwareString(typeRaw)?.replace(/^MEM_/, ""),
          deviceType: usefulHardwareString(deviceTypeRaw),
          size: sizeMb * 1024 * 1024,
        });
      }
    }
    return modules;
  } catch { return []; }
}

async function discoverMemoryHardware() {
  const dmiModules = await dmiMemoryModules();
  if (dmiModules.length) return { source: "DMI", modules: dmiModules };
  const edacModules = await edacMemoryModules();
  return { source: edacModules.length ? "EDAC" : undefined, modules: edacModules };
}

function memoryHardware() {
  memoryHardwareCache ??= discoverMemoryHardware();
  return memoryHardwareCache;
}

async function loadMetrics() {
  const source = await readText(join(procRoot, "loadavg"));
  const values = source?.trim().split(/\s+/).slice(0, 3).map(Number) ?? loadavg();
  return { one: values[0] ?? 0, five: values[1] ?? 0, fifteen: values[2] ?? 0 };
}

async function uptimeSeconds() {
  const source = await readText(join(procRoot, "uptime"));
  return source ? Number(source.split(/\s+/)[0]) : uptime();
}

async function networkMetrics() {
  const source = await readText(join(procRoot, "net", "dev"));
  if (!source) return { receivedPerSecond: 0, transmittedPerSecond: 0, received: 0, transmitted: 0 };
  let received = 0;
  let transmitted = 0;
  for (const line of source.split("\n").slice(2)) {
    const match = line.match(/^\s*([^:]+):\s*(.+)$/);
    if (!match || match[1].trim() === "lo") continue;
    const fields = match[2].trim().split(/\s+/).map(Number);
    received += fields[0] ?? 0;
    transmitted += fields[8] ?? 0;
  }
  const now = Date.now();
  const elapsed = previousNetwork ? (now - previousNetwork.at) / 1000 : 0;
  const result = {
    received,
    transmitted,
    receivedPerSecond: previousNetwork && elapsed > 0 ? Math.max(0, (received - previousNetwork.received) / elapsed) : 0,
    transmittedPerSecond: previousNetwork && elapsed > 0 ? Math.max(0, (transmitted - previousNetwork.transmitted) / elapsed) : 0,
  };
  previousNetwork = { received, transmitted, at: now };
  return result;
}

const physicalFileSystems = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "vfat", "exfat", "ntfs", "ntfs3", "f2fs"]);

function decodeMount(value: string): string {
  return value.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\134/g, "\\");
}

function blockDeviceCandidates(device: string): string[] {
  if (!device.startsWith("/dev/")) return [];
  const name = device.split("/").pop() ?? "";
  const parent = name.match(/^(nvme\d+n\d+|mmcblk\d+)p\d+$/)?.[1]
    ?? name.match(/^((?:sd|hd|vd|xvd)[a-z]+)\d+$/)?.[1];
  return [...new Set([name, parent].filter((value): value is string => Boolean(value)))];
}

async function diskName(device: string, fs: string): Promise<string> {
  if (fs === "zfs") return `ZFS-Pool ${device.split("/")[0]}`;
  for (const blockDevice of blockDeviceCandidates(device)) {
    const [vendor, model] = await Promise.all([
      readText(join(sysRoot, "class", "block", blockDevice, "device", "vendor")),
      readText(join(sysRoot, "class", "block", blockDevice, "device", "model")),
    ]);
    const label = [vendor?.trim(), model?.trim()].filter(Boolean).join(" ").replace(/\s+/g, " ");
    if (label) return label;
  }
  if (device.startsWith("/dev/mapper/")) return `Mapper ${device.split("/").pop()}`;
  return device;
}

async function diskMetrics() {
  const configured = (process.env.DISK_PATHS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  let mounts: Array<{ device: string; mount: string; fs: string }> = [];
  const mountSource = await readText(join(procRoot, "1", "mounts")) ?? await readText(join(procRoot, "mounts"));
  if (configured.length) {
    mounts = configured.map((mount) => ({ device: mount, mount, fs: "configured" }));
  } else if (mountSource) {
    mounts = mountSource.split("\n").flatMap((line) => {
      const fields = line.split(" ");
      if (fields.length < 3 || !physicalFileSystems.has(fields[2])) return [];
      return [{ device: decodeMount(fields[0]), mount: decodeMount(fields[1]), fs: fields[2] }];
    });
  }
  if (!mounts.some(({ mount }) => mount === "/")) mounts.unshift({ device: "root", mount: "/", fs: "root" });

  const seen = new Set<string>();
  const disks = [];
  for (const entry of mounts) {
    if (seen.has(entry.mount)) continue;
    seen.add(entry.mount);
    const localPath = hostRoot === "/" ? entry.mount : join(hostRoot, entry.mount.replace(/^[/\\]+/, ""));
    try {
      const stats = await statfs(localPath, { bigint: true });
      const total = Number(stats.blocks * stats.bsize);
      const available = Number(stats.bavail * stats.bsize);
      const free = Number(stats.bfree * stats.bsize);
      const used = total - free;
      disks.push({
        device: entry.device, name: await diskName(entry.device, entry.fs), mount: entry.mount,
        fs: entry.fs, total, used, available, usage: percentage(used, total),
      });
    } catch { /* Mount is not visible inside the container. */ }
  }
  return disks.sort((a, b) => a.mount === "/" ? -1 : b.mount === "/" ? 1 : a.mount.localeCompare(b.mount));
}

function friendlySensorName(name: string): string {
  if (["k10temp", "coretemp", "zenpower"].includes(name)) return "CPU";
  if (name === "nvme") return "NVMe";
  if (name === "drivetemp") return "Disk";
  if (/^nct|it87|asus|gigabyte|acpi/i.test(name)) return "Motherboard";
  return name;
}

function sensorCategory(name: string): "cpu" | "disk" | "board" | "other" {
  if (["k10temp", "coretemp", "zenpower"].includes(name)) return "cpu";
  if (["nvme", "drivetemp"].includes(name)) return "disk";
  if (/^nct|it87|asus|gigabyte|acpi/i.test(name)) return "board";
  return "other";
}

async function hwmonDeviceName(base: string, driver: string): Promise<string> {
  const blockDirectory = join(base, "device", "block");
  try {
    const devices = await readdir(blockDirectory);
    if (devices[0]) return devices[0];
  } catch { /* Not a block-device sensor. */ }
  const model = (await readText(join(base, "device", "model")))?.trim();
  return model || friendlySensorName(driver);
}

async function sensorMetrics() {
  const temperatures: TemperatureSensor[] = [];
  const fans: Array<{ label: string; rpm: number; source: string; minRpm?: number; maxRpm?: number; percent?: number }> = [];
  const hwmonRoot = join(sysRoot, "class", "hwmon");
  let hwmonDirectories: string[] = [];
  try { hwmonDirectories = (await readdir(hwmonRoot)).filter((name) => /^hwmon\d+$/.test(name)); }
  catch { /* Fall back to thermal zones below. */ }

  for (const directory of hwmonDirectories) {
    const base = join(hwmonRoot, directory);
    const driver = (await readText(join(base, "name")))?.trim();
    if (!driver) continue;
    const files = await readdir(base);
    const device = await hwmonDeviceName(base, driver);
    const source = device === friendlySensorName(driver) ? device : `${friendlySensorName(driver)} ${device}`;

    const temperatureIndexes = files.flatMap((file) => file.match(/^temp(\d+)_input$/)?.[1] ?? []).map(Number);
    for (const sensorIndex of temperatureIndexes) {
      const raw = await readText(join(base, `temp${sensorIndex}_input`));
      if (!raw) continue;
      const value = Number(raw.trim());
      const celsius = Math.abs(value) > 1000 ? value / 1000 : value;
      if (!Number.isFinite(celsius) || celsius < -20 || celsius > 150) continue;
      const sensorLabel = (await readText(join(base, `temp${sensorIndex}_label`)))?.trim();
      temperatures.push({
        label: sensorLabel || (driver === "drivetemp" ? device : `Sensor ${sensorIndex}`),
        celsius,
        source,
        category: sensorCategory(driver),
      });
    }

    const fanIndexes = files.flatMap((file) => file.match(/^fan(\d+)_input$/)?.[1] ?? []).map(Number);
    for (const fanIndex of fanIndexes) {
      const raw = await readText(join(base, `fan${fanIndex}_input`));
      if (!raw) continue;
      const rpm = Number(raw.trim());
      if (!Number.isFinite(rpm) || rpm <= 0) continue;
      const [fanLabelRaw, minimumRaw, maximumRaw, pwmRaw, pwmMaximumRaw] = await Promise.all([
        readText(join(base, `fan${fanIndex}_label`)),
        readText(join(base, `fan${fanIndex}_min`)),
        readText(join(base, `fan${fanIndex}_max`)),
        readText(join(base, `pwm${fanIndex}`)),
        readText(join(base, `pwm${fanIndex}_max`)),
      ]);
      const rpmLimit = (value: string | undefined) => {
        const parsed = Number(value?.trim());
        return Number.isFinite(parsed) && parsed > 0 && parsed < 100_000 ? parsed : undefined;
      };
      const minRpm = rpmLimit(minimumRaw);
      const maxRpm = rpmLimit(maximumRaw);
      const pwm = Number(pwmRaw?.trim());
      const pwmMaximum = Number(pwmMaximumRaw?.trim()) || 255;
      const percent = Number.isFinite(pwm) && pwm >= 0 && pwmMaximum > 0
        ? percentage(pwm, pwmMaximum)
        : maxRpm ? percentage(rpm, maxRpm) : undefined;
      fans.push({
        label: fanLabelRaw?.trim() || `Fan ${fanIndex}`,
        rpm, source, minRpm, maxRpm, percent,
      });
    }
  }

  const categoryOrder = { cpu: 0, disk: 1, board: 2, other: 3 } as Record<string, number>;
  temperatures.sort((a, b) => categoryOrder[a.category] - categoryOrder[b.category] || a.source.localeCompare(b.source) || a.label.localeCompare(b.label));
  if (temperatures.length) return { temperatures, fans };

  // Older or minimal systems sometimes expose only thermal zones.
  const thermalRoot = join(sysRoot, "class", "thermal");
  for (let index = 0; index < 32; index += 1) {
    const base = join(thermalRoot, `thermal_zone${index}`);
    const raw = await readText(join(base, "temp"));
    if (!raw) continue;
    const celsius = Number(raw.trim()) / 1000;
    if (!Number.isFinite(celsius) || celsius < -20 || celsius > 150) continue;
    const type = (await readText(join(base, "type")))?.trim();
    temperatures.push({ label: type || `Sensor ${index + 1}`, celsius, source: "Thermal Zone", category: "other" });
  }
  return { temperatures, fans };
}

function primaryCpuTemperature(temperatures: TemperatureSensor[]): TemperatureSensor | undefined {
  const candidates = temperatures.flatMap((sensor) => {
    const label = sensor.label.trim().toLowerCase();
    const source = sensor.source.trim().toLowerCase();
    let priority: number | undefined;
    if (/^tdie(?:\b|\d)/.test(label)) priority = 0;
    else if (/package id|physical id|cpu package|package temp|x86_pkg_temp/.test(label)) priority = 1;
    else if (/^tctl(?:\b|\d)/.test(label)) priority = 2;
    else if (/cpu[_ -]?(?:temp|thermal)|soc[_ -]?thermal/.test(label)) priority = 3;
    else if (/x86_pkg_temp|cpu[_ -]?thermal|soc[_ -]?thermal/.test(source)) priority = 3;
    else if (sensor.category === "cpu" && !/^core\s+\d+$/i.test(sensor.label)) priority = 4;
    else if (sensor.category === "cpu") priority = 5;
    return priority === undefined ? [] : [{ sensor, priority }];
  });
  candidates.sort((a, b) => a.priority - b.priority || b.sensor.celsius - a.sensor.celsius);
  return candidates[0]?.sensor;
}

async function systemInfo() {
  const releaseText = await readText(join(hostRoot, "etc", "os-release")) ?? "";
  const values = Object.fromEntries(releaseText.split("\n").map((line) => {
    const index = line.indexOf("=");
    return index < 0 ? ["", ""] : [line.slice(0, index), line.slice(index + 1).replace(/^\"|\"$/g, "")];
  }));
  const hostName = (await readText(join(hostRoot, "etc", "hostname")))?.trim() || localHostname();
  const kernel = (await readText(join(procRoot, "sys", "kernel", "osrelease")))?.trim() || release();
  return { hostname: hostName, os: values.PRETTY_NAME || `${platform()} ${release()}`, kernel, refreshSeconds };
}

async function collectMetrics() {
  const [cpu, memory, load, up, network, disks, sensors, system] = await Promise.all([
    cpuMetrics(), memoryMetrics(), loadMetrics(), uptimeSeconds(), networkMetrics(), diskMetrics(), sensorMetrics(), systemInfo(),
  ]);
  const cpuTemperature = primaryCpuTemperature(sensors.temperatures);
  const cpuWithTemperature = cpuTemperature
    ? { ...cpu, temperature: { celsius: cpuTemperature.celsius, label: cpuTemperature.label, source: cpuTemperature.source } }
    : cpu;
  return { timestamp: Date.now(), cpu: cpuWithTemperature, memory, load, uptime: up, network, disks, temperatures: sensors.temperatures, fans: sensors.fans, system };
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = resolve(publicDirectory, normalize(requestedPath));
  if (filePath !== publicDirectory && !filePath.startsWith(`${publicDirectory}${sep}`)) {
    json(response, 404, { error: "Not found" });
    return;
  }
  try {
    const file = await readFile(filePath);
    const extension = extname(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extension] ?? "application/octet-stream",
      "Cache-Control": [".html", ".css", ".js"].includes(extension) ? "no-cache" : "public, max-age=3600",
      "Content-Security-Policy": "frame-ancestors *",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(file);
  } catch { json(response, 404, { error: "Not found" }); }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (requestUrl.pathname === "/api/metrics") {
    try { json(response, 200, await collectMetrics()); }
    catch (error) { json(response, 500, { error: error instanceof Error ? error.message : "Metrics could not be read" }); }
    return;
  }
  if (requestUrl.pathname === "/api/health") { json(response, 200, { status: "ok" }); return; }
  if (dashboardRoutes.has(requestUrl.pathname.replace(/\/$/, ""))) {
    await serveStatic("/", response);
    return;
  }
  await serveStatic(requestUrl.pathname, response);
}

createServer((request, response) => { void handleRequest(request, response); })
  .listen(port, "0.0.0.0", () => console.log(`Systemarr is running at http://0.0.0.0:${port}`));
