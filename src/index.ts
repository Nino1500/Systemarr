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

let previousCpu: CpuSnapshot | undefined;
let previousNetwork: NetworkSnapshot | undefined;

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

function percentage(value: number, maximum: number): number {
  return maximum > 0 ? Math.min(100, Math.max(0, value / maximum * 100)) : 0;
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
    return { usage, cores: cores.length, coreUsage, model: cores[0]?.model ?? "CPU" };
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
  return { usage, cores: coreCount, coreUsage, model };
}

async function memoryMetrics() {
  const info = await readText(join(procRoot, "meminfo"));
  if (!info) {
    const total = totalmem();
    const available = freemem();
    return { total, used: total - available, available, usage: percentage(total - available, total), swapTotal: 0, swapUsed: 0 };
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
  return { total, used: total - available, available, usage: percentage(total - available, total), swapTotal, swapUsed: swapTotal - swapFree };
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
      disks.push({ device: entry.device, mount: entry.mount, fs: entry.fs, total, used, available, usage: percentage(used, total) });
    } catch { /* Mount is not visible inside the container. */ }
  }
  return disks.sort((a, b) => a.mount === "/" ? -1 : b.mount === "/" ? 1 : a.mount.localeCompare(b.mount));
}

function friendlySensorName(name: string): string {
  if (["k10temp", "coretemp", "zenpower"].includes(name)) return "CPU";
  if (name === "nvme") return "NVMe";
  if (name === "drivetemp") return "Festplatte";
  if (/^nct|it87|asus|gigabyte|acpi/i.test(name)) return "Mainboard";
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
  const temperatures: Array<{ label: string; celsius: number; source: string; category: string }> = [];
  const fans: Array<{ label: string; rpm: number; source: string }> = [];
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
      if (!Number.isFinite(rpm) || rpm < 0) continue;
      const fanLabel = (await readText(join(base, `fan${fanIndex}_label`)))?.trim();
      fans.push({ label: fanLabel || `Lüfter ${fanIndex}`, rpm, source });
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
  return { timestamp: Date.now(), cpu, memory, load, uptime: up, network, disks, temperatures: sensors.temperatures, fans: sensors.fans, system };
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
    catch (error) { json(response, 500, { error: error instanceof Error ? error.message : "Metriken konnten nicht gelesen werden" }); }
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
  .listen(port, "0.0.0.0", () => console.log(`Systemarr läuft auf http://0.0.0.0:${port}`));
