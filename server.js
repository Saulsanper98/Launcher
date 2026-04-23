const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 9000;
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readDotEnv(cwd) {
  const envPath = path.join(cwd, ".env");
  try {
    if (!fs.existsSync(envPath)) return {};
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    const result = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      result[key] = val;
    }
    return result;
  } catch { return {}; }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── State ─────────────────────────────────────────────────────────────────────
// { appId: { procName: { proc, logs[], status, startedAt, restartCount, userStopped } } }
const state = {};
const sseClients = {};

for (const app_ of config.apps) {
  state[app_.id] = {};
  sseClients[app_.id] = new Set();
  for (const proc of app_.processes) {
    state[app_.id][proc.name] = {
      proc: null, logs: [], status: "stopped",
      startedAt: null, restartCount: 0, userStopped: false,
    };
  }
}

// ── Broadcast ─────────────────────────────────────────────────────────────────
function pushLog(appId, procName, text) {
  const entry = { proc: procName, text: text.trimEnd(), ts: Date.now() };
  const s = state[appId][procName];
  s.logs.push(entry);
  if (s.logs.length > 400) s.logs.shift();
  broadcast(appId, { type: "log", ...entry });
}

function broadcast(appId, data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients[appId]) {
    try { client.write(msg); } catch {}
  }
}

function broadcastStatus(appId) {
  const uptimes = {};
  for (const [pn, ps] of Object.entries(state[appId])) {
    uptimes[pn] = ps.startedAt;
  }
  broadcast(appId, { type: "status", status: getAppStatus(appId), uptimes });
}

function getAppStatus(appId) {
  const statuses = Object.values(state[appId]).map(p => p.status);
  if (statuses.every(s => s === "running"))  return "running";
  if (statuses.every(s => s === "stopped"))  return "stopped";
  if (statuses.some(s => s === "starting"))  return "starting";
  return "partial";
}

function getFullStatus() {
  const result = {};
  for (const app_ of config.apps) {
    result[app_.id] = { app: getAppStatus(app_.id), processes: {}, uptimes: {} };
    for (const proc of app_.processes) {
      const ps = state[app_.id][proc.name];
      result[app_.id].processes[proc.name] = ps.status;
      result[app_.id].uptimes[proc.name]   = ps.startedAt;
    }
  }
  return result;
}

// ── Start a process ───────────────────────────────────────────────────────────
const MAX_RETRIES = 3;

function startProcess(appId, procCfg) {
  const ps = state[appId][procCfg.name];
  if (ps.proc && ps.status !== "stopped") return;

  ps.status = "starting";
  ps.userStopped = false;
  broadcastStatus(appId);
  pushLog(appId, procCfg.name, `▶ Iniciando: ${procCfg.cmd} ${procCfg.args.join(" ")}`);
  pushLog(appId, procCfg.name, `  Carpeta: ${procCfg.cwd}`);

  const dotEnvVars = readDotEnv(procCfg.cwd);
  const proc = spawn(procCfg.cmd, procCfg.args, {
    cwd: procCfg.cwd, shell: true,
    env: { ...process.env, ...dotEnvVars, ...(procCfg.env ?? {}) },
  });

  ps.proc = proc;

  proc.stdout.on("data", d => {
    for (const line of d.toString().split("\n"))
      if (line.trim()) pushLog(appId, procCfg.name, line);
  });
  proc.stderr.on("data", d => {
    for (const line of d.toString().split("\n"))
      if (line.trim()) pushLog(appId, procCfg.name, line);
  });

  proc.on("spawn", () => {
    ps.status    = "running";
    ps.startedAt = Date.now();
    ps.restartCount = 0;
    broadcastStatus(appId);
    pushLog(appId, procCfg.name, `✓ Proceso iniciado (PID ${proc.pid})`);
    broadcast(appId, { type: "proc_started", proc: procCfg.name });
  });

  proc.on("close", code => {
    const wasUserStopped = ps.userStopped;
    ps.proc       = null;
    ps.startedAt  = null;
    ps.userStopped = false;

    const crashed = code !== 0; // code === null (signal) también cuenta como no-limpio
    const msg = (!crashed || (code === null && wasUserStopped))
      ? `■ Proceso finalizado`
      : `■ Proceso finalizado con error (código ${code ?? "señal"}) — revisa los logs`;
    pushLog(appId, procCfg.name, msg);

    // Auto-restart
    const canRetry = !wasUserStopped && crashed && (procCfg.autoRestart ?? false);
    if (canRetry && ps.restartCount < MAX_RETRIES) {
      ps.restartCount++;
      ps.status = "starting";
      broadcastStatus(appId);
      const delay = Math.pow(2, ps.restartCount - 1) * 5000; // 5s, 10s, 20s
      pushLog(appId, procCfg.name,
        `⟳ Auto-reinicio en ${delay / 1000}s (intento ${ps.restartCount}/${MAX_RETRIES})…`);
      broadcast(appId, { type: "crashed", proc: procCfg.name, restarting: true, retryIn: delay });
      setTimeout(() => startProcess(appId, procCfg), delay);
    } else {
      if (canRetry && ps.restartCount >= MAX_RETRIES) {
        pushLog(appId, procCfg.name,
          `✗ Máximo de reintentos (${MAX_RETRIES}) alcanzado. Intervención manual necesaria.`);
      }
      ps.restartCount = 0;
      ps.status = "stopped";
      broadcastStatus(appId);
      if (!wasUserStopped && crashed) {
        broadcast(appId, { type: "crashed", proc: procCfg.name, restarting: false });
      }
    }
  });

  proc.on("error", err => {
    ps.proc      = null;
    ps.startedAt = null;
    ps.status    = "stopped";
    broadcastStatus(appId);
    pushLog(appId, procCfg.name, `✗ Error: ${err.message}`);
  });
}

// ── Stop a process ────────────────────────────────────────────────────────────
function stopProcess(appId, procName) {
  const ps = state[appId][procName];
  if (!ps.proc) return;
  ps.userStopped = true;
  pushLog(appId, procName, "■ Deteniendo proceso...");
  try {
    spawn("taskkill", ["/pid", String(ps.proc.pid), "/f", "/t"], { shell: true });
  } catch {
    ps.proc.kill("SIGTERM");
  }
}

// ── Start app (sequential, respeta startDelay) ────────────────────────────────
async function startApp(appCfg) {
  for (const proc of appCfg.processes) {
    startProcess(appCfg.id, proc);
    const delay = proc.startDelay ?? 0;
    if (delay > 0) await sleep(delay);
  }
}

// ── API ───────────────────────────────────────────────────────────────────────
app.get("/api/config",  (_req, res) => res.json(config));
app.get("/api/status",  (_req, res) => res.json(getFullStatus()));

app.post("/api/apps/:id/start", (req, res) => {
  const appCfg = config.apps.find(a => a.id === req.params.id);
  if (!appCfg) return res.status(404).json({ error: "App not found" });
  startApp(appCfg); // fire-and-forget, delays corren en background
  res.json({ ok: true });
});

app.post("/api/apps/:id/stop", (req, res) => {
  const appCfg = config.apps.find(a => a.id === req.params.id);
  if (!appCfg) return res.status(404).json({ error: "App not found" });
  for (const proc of appCfg.processes) stopProcess(appCfg.id, proc.name);
  res.json({ ok: true });
});

app.post("/api/apps/:id/restart", (req, res) => {
  const appCfg = config.apps.find(a => a.id === req.params.id);
  if (!appCfg) return res.status(404).json({ error: "App not found" });
  pushLog(appCfg.id, appCfg.processes[0].name, "⟳ Reiniciando aplicación…");
  for (const proc of appCfg.processes) stopProcess(appCfg.id, proc.name);
  setTimeout(() => startApp(appCfg), 2000);
  res.json({ ok: true });
});

// SSE log stream
app.get("/api/apps/:id/logs", (req, res) => {
  const { id } = req.params;
  if (!state[id]) return res.status(404).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Historial de logs
  for (const procName of Object.keys(state[id])) {
    for (const entry of state[id][procName].logs) {
      res.write(`data: ${JSON.stringify({ type: "log", ...entry })}\n\n`);
    }
  }
  // Estado actual + uptimes
  const uptimes = {};
  for (const pn of Object.keys(state[id])) uptimes[pn] = state[id][pn].startedAt;
  res.write(`data: ${JSON.stringify({ type: "status", status: getAppStatus(id), uptimes })}\n\n`);

  sseClients[id].add(res);
  req.on("close", () => sseClients[id].delete(res));
});

// ── Arrancar servidor ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║       Dev Launcher corriendo         ║`);
  console.log(`  ║   http://localhost:${PORT}            ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
  spawn("cmd", ["/c", `start http://localhost:${PORT}`], { shell: true });

  // Auto-start apps marcadas
  for (const app_ of config.apps) {
    if (app_.autoStart) {
      console.log(`  Auto-starting: ${app_.name}`);
      startApp(app_);
    }
  }
});

// Limpieza al salir
process.on("exit", () => {
  for (const appId of Object.keys(state))
    for (const pn of Object.keys(state[appId])) {
      const ps = state[appId][pn];
      if (ps.proc) try { ps.proc.kill(); } catch {}
    }
});
