import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";

const host = "127.0.0.1";
const port = 4173;
const root = "/root/codex-site";
const codexAppServerUrl = "ws://127.0.0.1:4174";
const codexHome = process.env.CODEX_HOME || "/root/.codex";
const codexAppServerArgs = ["app-server", "--listen", "ws://127.0.0.1:4174"];
const execFileAsync = promisify(execFile);

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function runCommand(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: "/root",
    env: process.env,
    maxBuffer: 1024 * 1024 * 8,
    ...options,
  });
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function isAppServerRunning() {
  try {
    const { stdout } = await runCommand("pgrep", ["-af", "codex app-server --listen ws://127.0.0.1:4174"]);
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

async function startAppServer() {
  if (await isAppServerRunning()) {
    return { started: false, running: true };
  }

  await runCommand("setsid", ["-f", "codex", ...codexAppServerArgs], {
    stdio: "ignore",
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { started: true, running: await isAppServerRunning() };
}

async function stopAppServer() {
  try {
    await runCommand("pkill", ["-f", "codex app-server --listen ws://127.0.0.1:4174"]);
  } catch {
    // ignore "no process found"
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
  return { running: await isAppServerRunning() };
}

async function listCuratedSkills() {
  const script = `${codexHome}/skills/.system/skill-installer/scripts/list-skills.py`;
  const { stdout } = await runCommand("python", [script, "--format", "json"]);
  return JSON.parse(stdout);
}

async function installSkill(payload) {
  const script = `${codexHome}/skills/.system/skill-installer/scripts/install-skill-from-github.py`;

  if (payload.url) {
    return runCommand("python", [script, "--url", payload.url]);
  }

  if (payload.curatedName) {
    return runCommand("python", [
      script,
      "--repo",
      "openai/skills",
      "--path",
      `skills/.curated/${payload.curatedName}`,
    ]);
  }

  throw new Error("Either url or curatedName is required");
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${host}:${port}`);

  if (req.url === "/api/app-server/status" && req.method === "GET") {
    json(res, 200, { running: await isAppServerRunning() });
    return;
  }

  if (req.url === "/api/app-server/start" && req.method === "POST") {
    json(res, 200, await startAppServer());
    return;
  }

  if (req.url === "/api/app-server/stop" && req.method === "POST") {
    json(res, 200, await stopAppServer());
    return;
  }

  if (req.url === "/api/skills/catalog" && req.method === "GET") {
    try {
      json(res, 200, { data: await listCuratedSkills() });
    } catch (error) {
      json(res, 500, { error: error.message || "Failed to list curated skills" });
    }
    return;
  }

  if (req.url === "/api/skills/install" && req.method === "POST") {
    try {
      const payload = await readRequestBody(req);
      const result = await installSkill(payload);
      json(res, 200, { ok: true, stdout: result.stdout, stderr: result.stderr });
    } catch (error) {
      json(res, 500, { error: error.message || "Failed to install skill" });
    }
    return;
  }

  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname || "/index.html";
  const safePath = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);

  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  try {
    const fileStat = await stat(filePath);

    if (fileStat.isDirectory()) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });

    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Server error");
  }
});

const proxyWss = new WebSocketServer({ noServer: true });

proxyWss.on("connection", (clientSocket) => {
  const upstreamSocket = new WebSocket(codexAppServerUrl);
  const pendingClientMessages = [];

  const closeBoth = () => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close();
    }
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.close();
    }
  };

  clientSocket.on("message", (data, isBinary) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(data, { binary: isBinary });
      return;
    }

    pendingClientMessages.push({ data, isBinary });
  });

  upstreamSocket.on("open", () => {
    upstreamSocket.on("message", (data, isBinary) => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(data, { binary: isBinary });
      }
    });

    for (const message of pendingClientMessages) {
      upstreamSocket.send(message.data, { binary: message.isBinary });
    }
    pendingClientMessages.length = 0;
  });

  upstreamSocket.on("error", () => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "error",
          params: {
            error: { message: "Failed to connect to local Codex app server" },
            threadId: "",
            turnId: "",
            willRetry: false,
          },
        }),
      );
    }
    closeBoth();
  });

  clientSocket.on("close", closeBoth);
  clientSocket.on("error", closeBoth);
  upstreamSocket.on("close", closeBoth);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/codex") {
    socket.destroy();
    return;
  }

  proxyWss.handleUpgrade(req, socket, head, (websocket) => {
    proxyWss.emit("connection", websocket, req);
  });
});

server.listen(port, host, () => {
  console.log(`Codex Workspace is running at http://${host}:${port}`);
});
