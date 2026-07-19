const params = new URLSearchParams(location.search);
const isEmbedded = params.get("embed") === "1" || (params.get("embed") !== "0" && self !== top);
const routeAliases = { ram: "memory", storage: "disks", temperatures: "temperature" };
const routeName = location.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
const routeModule = routeAliases[routeName] || routeName;
const modules = [
  ["cpu", "CPU"], ["memory", "Memory"], ["load", "System Load"],
  ["disks", "Disks"], ["network", "Network"], ["temperature", "Temperature"], ["system", "System"],
  ["fans", "Fans"],
];
const defaultModules = modules.map(([key]) => key);

function savedModules() {
  if (modules.some(([key]) => key === routeModule)) return [routeModule];
  const fromUrl = params.get("modules")?.split(",").filter((key) => modules.some(([known]) => known === key));
  if (fromUrl?.length) return fromUrl;
  try {
    const value = JSON.parse(localStorage.getItem("systemarr-modules"));
    if (Array.isArray(value) && value.length) return value;
  } catch {}
  return defaultModules;
}

const state = { enabled: savedModules(), cpuHistory: [], downHistory: [], upHistory: [], timer: undefined, loading: false };
document.body.classList.toggle("embedded", isEmbedded);
document.body.classList.toggle("single-module", modules.some(([key]) => key === routeModule));
if (modules.some(([key]) => key === routeModule)) document.body.classList.add(`module-${routeModule}`);

const $ = (selector) => document.querySelector(selector);
const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));
const locale = "en-GB";
const dateTime = new Intl.DateTimeFormat(locale, {
  day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const number = (value, digits = 1) => Number(value || 0).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });

function bytes(value, rate = false) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Math.max(0, Number(value) || 0); let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  const digits = size >= 100 || unit === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${number(size, digits)} ${units[unit]}${rate ? "/s" : ""}`;
}

function duration(seconds) {
  const days = Math.floor(seconds / 86400); const hours = Math.floor(seconds % 86400 / 3600); const minutes = Math.floor(seconds % 3600 / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`].filter(Boolean).join(" ");
}

function setEnabled() {
  document.querySelectorAll("[data-module]").forEach((card) => { card.hidden = !state.enabled.includes(card.dataset.module); });
  document.querySelectorAll("[data-choice]").forEach((input) => { input.checked = state.enabled.includes(input.dataset.choice); });
  document.body.classList.toggle("few-modules", state.enabled.length <= 3);
}

function makeChoices() {
  const container = $("#moduleChoices");
  modules.forEach(([key, label]) => {
    const row = document.createElement("label");
    row.innerHTML = `<span>${label}</span><input type="checkbox" data-choice="${key}"><i></i>`;
    row.querySelector("input").addEventListener("change", (event) => {
      if (event.target.checked) state.enabled.push(key); else state.enabled = state.enabled.filter((item) => item !== key);
      if (!state.enabled.length) state.enabled = [key];
      try { localStorage.setItem("systemarr-modules", JSON.stringify(state.enabled)); } catch {}
      setEnabled();
    });
    container.append(row);
  });
  setEnabled();
}

function chart(element, series, secondary) {
  const all = secondary ? [...series, ...secondary] : series;
  const maximum = Math.max(100, ...all, 1);
  const points = (values) => values.map((value, index) => `${values.length === 1 ? 100 : index / (values.length - 1) * 100},${42 - value / maximum * 38}`).join(" ");
  element.innerHTML = `<svg viewBox="0 0 100 44" preserveAspectRatio="none"><defs><linearGradient id="fill-${element.id}" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#6ce5c2" stop-opacity=".28"/><stop offset="1" stop-color="#6ce5c2" stop-opacity="0"/></linearGradient></defs><polygon points="0,44 ${points(series)} 100,44" fill="url(#fill-${element.id})"/><polyline points="${points(series)}"/><polyline class="secondary" points="${secondary ? points(secondary) : ""}"/></svg>`;
}

function pushHistory(list, value) { list.push(value); if (list.length > 40) list.shift(); }

function render(data) {
  const cpu = clamp(data.cpu.usage);
  $("#cpuValue").textContent = number(cpu, 0); $("#cpuBadge").textContent = `${data.cpu.cores} Cores`; $("#cpuModel").textContent = data.cpu.model;
  const cpuFrequency = $("#cpuFrequency"); const frequencyParts = [];
  if (data.cpu.frequency?.currentGHz !== undefined) frequencyParts.push(`Current ${number(data.cpu.frequency.currentGHz, 2)} GHz`);
  if (data.cpu.frequency?.minGHz !== undefined && data.cpu.frequency?.maxGHz !== undefined) {
    frequencyParts.push(`Range ${number(data.cpu.frequency.minGHz, 2)}–${number(data.cpu.frequency.maxGHz, 2)} GHz`);
  } else if (data.cpu.frequency?.maxGHz !== undefined) frequencyParts.push(`Max. ${number(data.cpu.frequency.maxGHz, 2)} GHz`);
  cpuFrequency.textContent = frequencyParts.join(" · "); cpuFrequency.hidden = !frequencyParts.length;
  $("#cpuState").textContent = cpu > 85 ? "High utilization" : cpu > 55 ? "Working steadily" : "Running smoothly";
  $("#cpuGauge").style.setProperty("--value", `${cpu * 3.6}deg`);
  const coreList = $("#cpuCores"); coreList.replaceChildren();
  (data.cpu.coreUsage || []).forEach((usage, index) => {
    const core = document.createElement("div");
    core.innerHTML = `<span>C${index + 1}</span><i><b></b></i><strong></strong>`;
    core.querySelector("b").style.width = `${clamp(usage)}%`;
    core.querySelector("strong").textContent = `${number(usage, 0)}%`;
    coreList.append(core);
  });
  pushHistory(state.cpuHistory, cpu); chart($("#cpuChart"), state.cpuHistory);

  $("#memoryPercent").textContent = `${number(data.memory.usage, 0)}%`; $("#memoryBar").style.width = `${clamp(data.memory.usage)}%`;
  $("#memoryUsed").textContent = bytes(data.memory.used); $("#memoryFree").textContent = bytes(data.memory.available);
  $("#swapRow").hidden = !data.memory.swapTotal; $("#swapValue").textContent = `${bytes(data.memory.swapUsed)} / ${bytes(data.memory.swapTotal)}`;

  $("#loadOne").textContent = number(data.load.one, 2); $("#loadFive").textContent = number(data.load.five, 2); $("#loadFifteen").textContent = number(data.load.fifteen, 2);
  $("#uptimeValue").textContent = duration(data.uptime);

  $("#diskCount").textContent = `${data.disks.length} ${data.disks.length === 1 ? "Volume" : "Volumes"}`;
  const diskList = $("#diskList"); diskList.replaceChildren();
  if (!data.disks.length) diskList.innerHTML = '<p class="empty">No disks found</p>';
  data.disks.forEach((disk) => {
    const item = document.createElement("div"); item.className = "disk-item";
    item.innerHTML = `<div class="disk-top"><div><strong class="disk-mount"></strong><span class="disk-name"></span><small class="disk-source"></small></div><b></b></div><div class="bar"><i></i></div><small class="disk-usage"></small>`;
    item.querySelector(".disk-mount").textContent = disk.mount === "/" ? "System" : disk.mount;
    item.querySelector(".disk-name").textContent = disk.name || disk.device;
    item.querySelector(".disk-source").textContent = `${disk.fs === "zfs" ? "Dataset " : ""}${disk.device} · ${disk.fs}`;
    item.querySelector("b").textContent = `${number(disk.usage, 0)}%`;
    item.querySelector("i").style.width = `${clamp(disk.usage)}%`;
    item.querySelector(".disk-usage").textContent = `${bytes(disk.used)} of ${bytes(disk.total)} used · ${bytes(disk.available)} available`;
    diskList.append(item);
  });

  $("#downloadValue").textContent = bytes(data.network.receivedPerSecond, true); $("#uploadValue").textContent = bytes(data.network.transmittedPerSecond, true);
  pushHistory(state.downHistory, data.network.receivedPerSecond); pushHistory(state.upHistory, data.network.transmittedPerSecond);
  const peak = Math.max(...state.downHistory, ...state.upHistory, 1);
  chart($("#networkChart"), state.downHistory.map((v) => v / peak * 100), state.upHistory.map((v) => v / peak * 100));

  const temperatures = $("#temperatureList"); temperatures.replaceChildren();
  $("#temperatureCount").textContent = `${data.temperatures.length} Sensors`;
  if (!data.temperatures.length) temperatures.innerHTML = '<p class="empty">No supported sensors found</p>';
  data.temperatures.forEach((sensor) => {
    const item = document.createElement("div"); item.innerHTML = `<span class="sensor-copy"><strong></strong><small></small></span><b></b>`;
    item.querySelector("strong").textContent = sensor.label;
    item.querySelector("small").textContent = sensor.source;
    item.querySelector("b").textContent = `${number(sensor.celsius, 1)} °C`;
    item.dataset.category = sensor.category;
    temperatures.append(item);
  });

  const fans = $("#fanList"); fans.replaceChildren();
  $("#fanCount").textContent = `${data.fans?.length || 0} Fans`;
  if (!data.fans?.length) fans.innerHTML = '<p class="empty">No supported fans found</p>';
  (data.fans || []).forEach((sensor) => {
    const item = document.createElement("div"); item.innerHTML = `<span class="sensor-copy"><strong></strong><small></small></span><b></b>`;
    item.querySelector("strong").textContent = sensor.label;
    const details = [sensor.source];
    if (sensor.minRpm !== undefined && sensor.maxRpm !== undefined) details.push(`${number(sensor.minRpm, 0)}–${number(sensor.maxRpm, 0)} RPM`);
    else if (sensor.maxRpm !== undefined) details.push(`Max. ${number(sensor.maxRpm, 0)} RPM`);
    else if (sensor.minRpm !== undefined) details.push(`Min. ${number(sensor.minRpm, 0)} RPM`);
    if (sensor.percent !== undefined) details.push(`${number(sensor.percent, 0)} %`);
    item.querySelector("small").textContent = details.join(" · ");
    item.querySelector("b").textContent = `${number(sensor.rpm, 0)} RPM`;
    fans.append(item);
  });

  $("#systemHost").textContent = data.system.hostname; $("#systemOs").textContent = data.system.os; $("#systemKernel").textContent = data.system.kernel;
  $("#hostLabel").textContent = data.system.hostname; $("#lastUpdated").textContent = `Updated ${dateTime.format(new Date(data.timestamp))}`;
  $("#liveStatus").classList.remove("error"); $("#liveStatus").innerHTML = "<i></i> Live";
  clearTimeout(state.timer); state.timer = setTimeout(load, data.system.refreshSeconds * 1000);
}

async function load() {
  if (state.loading) return; state.loading = true;
  try {
    const response = await fetch("/api/metrics", { cache: "no-store" }); const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Server unavailable"); render(data);
  } catch (error) {
    $("#liveStatus").classList.add("error"); $("#liveStatus").innerHTML = "<i></i> Offline"; $("#lastUpdated").textContent = error.message;
    clearTimeout(state.timer); state.timer = setTimeout(load, 5000);
  } finally { state.loading = false; }
}

makeChoices();
if (document.body.classList.contains("single-module")) {
  $("#layoutButton").hidden = true;
  document.title = `${modules.find(([key]) => key === routeModule)?.[1] || "System"} · Systemarr`;
}
$("#layoutButton").addEventListener("click", () => { const panel = $("#layoutPanel"); panel.hidden = !panel.hidden; $("#layoutButton").setAttribute("aria-expanded", String(!panel.hidden)); });
$("#resetLayout").addEventListener("click", () => { state.enabled = [...defaultModules]; try { localStorage.removeItem("systemarr-modules"); } catch {} setEnabled(); });
$("#refreshButton").addEventListener("click", load);
document.addEventListener("click", (event) => { if (!event.target.closest("#layoutPanel, #layoutButton")) $("#layoutPanel").hidden = true; });
load();
