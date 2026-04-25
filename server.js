const express = require("express");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");

const app = express();
const PORT = 9000;
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForPortFree(port, attempts, delayMs, done) {
  const tryOnce = (left) => {
    const server = net.createServer();
    server.once("error", () => {
      if (left <= 1) return done(false);
      setTimeout(() => tryOnce(left - 1), delayMs);
    });
    server.once("listening", () => {
      server.close(() => done(true));
    });
    // host undefined => let node choose, catches typical EADDRINUSE cases
    server.listen(Number(port));
  };
  tryOnce(attempts);
}

function killPortListeners(port, done) {
  const p = Number(port);
  execFile("cmd", ["/c", "netstat -ano -p tcp"], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
    if (err) return done("netstat_error");
    const lines = (stdout ?? "").toString().split(/\r?\n/);
    const pids = new Set();
    for (const line of lines) {
      if (!line.includes(`:${p}`) || !line.includes("LISTENING")) continue;
      const cols = line.trim().split(/\s+/);
      const pid = cols[cols.length - 1];
      if (pid && /^\d+$/.test(pid)) pids.add(pid);
    }

    if (pids.size === 0) return done("killed=0;still=0");

    const pidList = [...pids];
    let idx = 0;
    const killNext = () => {
      if (idx >= pidList.length) {
        return setTimeout(() => {
          const server = net.createServer();
          server.once("error", () => done(`killed=${pidList.length};still=1`));
          server.once("listening", () => server.close(() => done(`killed=${pidList.length};still=0`)));
          server.listen(p, "0.0.0.0");
        }, 250);
      }
      const pid = pidList[idx++];
      execFile("taskkill", ["/PID", String(pid), "/F", "/T"], { windowsHide: true, timeout: 3000 }, () => killNext());
    };
    killNext();
  });
}

function killNodeProcessesByCwd(cwd, done) {
  const safeCwd = String(cwd).replace(/\\/g, "\\\\").replace(/'/g, "''");
  const psCmd = [
    "$killed=0;",
    `$needle='${safeCwd}';`,
    "Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | ForEach-Object {",
    "  $cmd = $_.CommandLine;",
    "  if ($cmd -and $cmd -like ('*' + $needle + '*')) {",
    "    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ } catch {}",
    "  }",
    "};",
    "Write-Output (\"killed_cwd=\" + $killed);",
  ].join(" ");

  execFile(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCmd],
    { windowsHide: true, timeout: 5000 },
    (_err, stdout, stderr) => {
      const out = (stdout ?? "").toString().trim();
      const serr = (stderr ?? "").toString().trim();
      done([out, serr].filter(Boolean).join(" | "));
    },
  );
}

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
// { appId: { procName: { proc, logs[], status, startedAt, restartCount, userStopped, retryTimer } } }
const state = {};
const sseClients = {};
const appStartLocks = new Set();

for (const app_ of config.apps) {
  state[app_.id] = {};
  sseClients[app_.id] = new Set();
  for (const proc of app_.processes) {
    state[app_.id][proc.name] = {
      proc: null, logs: [], status: "stopped",
      startedAt: null, restartCount: 0, userStopped: false,
      retryTimer: null,
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
  // Hard guard against concurrent/double starts and delayed retry overlaps.
  if (ps.status === "starting" || (ps.proc && ps.status !== "stopped")) return;
  if (ps.retryTimer) {
    clearTimeout(ps.retryTimer);
    ps.retryTimer = null;
  }

  ps.status = "starting";
  ps.userStopped = false;
  broadcastStatus(appId);
  pushLog(appId, procCfg.name, `▶ Iniciando: ${procCfg.cmd} ${procCfg.args.join(" ")}`);
  pushLog(appId, procCfg.name, `  Carpeta: ${procCfg.cwd}`);

  const dotEnvVars = readDotEnv(procCfg.cwd);
  const launch = () => {
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
      if (ps.retryTimer) {
        clearTimeout(ps.retryTimer);
        ps.retryTimer = null;
      }
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
      ps.retryTimer = setTimeout(() => {
        ps.retryTimer = null;
        startProcess(appId, procCfg);
      }, delay);
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
  };

  // Optional: free TCP port before starting process (async to avoid blocking API).
  if (procCfg.preKillPort) {
    killPortListeners(procCfg.preKillPort, (portOutcome) => {
      if (portOutcome) pushLog(appId, procCfg.name, `  Pre-start port ${procCfg.preKillPort}: ${portOutcome}`);

      // Extra cleanup: kill stale node processes tied to this process cwd.
      killNodeProcessesByCwd(procCfg.cwd, (cwdOutcome) => {
        if (cwdOutcome) pushLog(appId, procCfg.name, `  Pre-start cwd cleanup: ${cwdOutcome}`);

        waitForPortFree(procCfg.preKillPort, 8, 500, (free) => {
          if (!free) {
            pushLog(appId, procCfg.name, `  Pre-start warning: port ${procCfg.preKillPort} still busy`);
            ps.status = "starting";
            broadcastStatus(appId);
            ps.retryTimer = setTimeout(() => {
              ps.retryTimer = null;
              startProcess(appId, procCfg);
            }, 2000);
            return;
          }
          launch();
        });
      });
    });
  } else {
    launch();
  }
}

// ── Stop a process ────────────────────────────────────────────────────────────
function stopProcess(appId, procName) {
  const ps = state[appId][procName];
  const appCfg = config.apps.find(a => a.id === appId);
  const procCfg = appCfg?.processes.find(p => p.name === procName);
  if (ps.retryTimer) {
    clearTimeout(ps.retryTimer);
    ps.retryTimer = null;
  }

  if (!ps.proc && !procCfg?.preKillPort) return;
  ps.userStopped = true;
  pushLog(appId, procName, "■ Deteniendo proceso...");
  if (procCfg?.preKillPort) {
    killPortListeners(procCfg.preKillPort, (outcome) => {
      if (outcome) pushLog(appId, procName, `  Stop port ${procCfg.preKillPort}: ${outcome}`);
    });
  }
  if (!ps.proc) return;
  try {
    spawn("taskkill", ["/pid", String(ps.proc.pid), "/f", "/t"], { shell: true });
  } catch {
    ps.proc.kill("SIGTERM");
  }
}

// ── Start app (sequential, respeta startDelay) ────────────────────────────────
async function startApp(appCfg) {
  if (appStartLocks.has(appCfg.id)) return;
  appStartLocks.add(appCfg.id);
  for (const proc of appCfg.processes) {
    startProcess(appCfg.id, proc);
    const delay = proc.startDelay ?? 0;
    if (delay > 0) await sleep(delay);
  }
  appStartLocks.delete(appCfg.id);
}

// ── API ───────────────────────────────────────────────────────────────────────
app.get("/api/config",  (_req, res) => res.json(config));
app.get("/api/status",  (_req, res) => res.json(getFullStatus()));

app.post("/api/apps/:id/start", (req, res) => {
  const appCfg = config.apps.find(a => a.id === req.params.id);
  if (!appCfg) return res.status(404).json({ error: "App not found" });
  if (getAppStatus(appCfg.id) === "starting") return res.json({ ok: true, ignored: "already_starting" });
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
