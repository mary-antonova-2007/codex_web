import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { extname, join, normalize, basename } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";

const host = "127.0.0.1";
const port = 4173;
const root = "/root/codex-site";
const uploadsRoot = "/root/.codex-site-uploads";
const codexAppServerUrl = "ws://127.0.0.1:4174";
const codexHome = process.env.CODEX_HOME || "/root/.codex";
const codexAppServerArgs = ["app-server", "--listen", "ws://127.0.0.1:4174"];
const execFileAsync = promisify(execFile);
const sessionsRoot = "/root/.codex/sessions";
const threadRenderableItemsCache = new Map();

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

function sanitizeFilename(name = "attachment") {
  const safeBase = basename(String(name || "attachment"))
    .replace(/[^\w.\-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return safeBase || "attachment";
}

async function saveAttachment(payload = {}) {
  const base64 = String(payload.dataBase64 || "");
  if (!base64) {
    throw new Error("Attachment payload is empty");
  }

  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) {
    throw new Error("Attachment payload is invalid");
  }

  if (buffer.length > 25 * 1024 * 1024) {
    throw new Error("Attachment is too large. Max size is 25 MB.");
  }

  await mkdir(uploadsRoot, { recursive: true });
  const filename = `${Date.now()}-${randomUUID()}-${sanitizeFilename(payload.name)}`;
  const filePath = join(uploadsRoot, filename);
  await writeFile(filePath, buffer);

  return {
    mimeType: payload.mimeType || "application/octet-stream",
    name: payload.name || filename,
    path: filePath,
    size: buffer.length,
  };
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

function resolveUploadPath(rawPath = "") {
  const normalizedPath = normalize(String(rawPath || ""));
  if (!normalizedPath.startsWith(uploadsRoot)) {
    return null;
  }

  return normalizedPath;
}

function resolveSessionPath(rawPath = "") {
  const normalizedPath = normalize(String(rawPath || ""));
  if (!normalizedPath.startsWith(sessionsRoot) || !normalizedPath.endsWith(".jsonl")) {
    return null;
  }

  return normalizedPath;
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeNewlines(text = "") {
  return String(text || "").replaceAll("\r\n", "\n");
}

function parseCommandCallOutput(output = "") {
  const normalizedOutput = normalizeNewlines(output);
  const command = normalizedOutput.match(/^Command:\s+([^\n]+)$/m)?.[1] || "";
  const sessionId = normalizedOutput.match(/Process running with session ID (\d+)/)?.[1] || null;
  const didExit = /Process exited with code -?\d+/.test(normalizedOutput);
  const didFail = /^exec_command failed/m.test(normalizedOutput);
  const marker = "\nOutput:\n";
  const markerIndex = normalizedOutput.indexOf(marker);

  return {
    aggregatedOutput: markerIndex >= 0
      ? normalizedOutput.slice(markerIndex + marker.length)
      : didFail
        ? normalizedOutput
        : "",
    command,
    sessionId,
    status: didExit ? "completed" : sessionId ? "running" : didFail ? "failed" : normalizedOutput.trim() ? "completed" : "",
  };
}

function textFromResponseMessageContent(content = []) {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => (item?.type === "output_text" || item?.type === "text" || item?.type === "input_text") ? String(item.text || "") : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseApplyPatchInput(input = "") {
  const lines = normalizeNewlines(input).split("\n");
  const changes = [];
  let currentChange = null;

  function pushCurrentChange() {
    if (!currentChange) {
      return;
    }

    const diff = currentChange.diffLines.join("\n").trimEnd();
    changes.push({
      diff,
      kind: currentChange.kind,
      path: currentChange.path,
    });
    currentChange = null;
  }

  for (const line of lines) {
    if (line === "*** Begin Patch" || line === "*** End Patch" || line === "*** End of File") {
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      pushCurrentChange();
      currentChange = {
        diffLines: [],
        kind: { type: "add" },
        path: line.slice("*** Add File: ".length).trim(),
      };
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      pushCurrentChange();
      currentChange = {
        diffLines: [],
        kind: { type: "update" },
        path: line.slice("*** Update File: ".length).trim(),
      };
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      pushCurrentChange();
      changes.push({
        diff: "(deleted)",
        kind: { type: "delete" },
        path: line.slice("*** Delete File: ".length).trim(),
      });
      continue;
    }

    if (line.startsWith("*** Move to: ")) {
      continue;
    }

    if (!currentChange) {
      continue;
    }

    if (currentChange.kind.type === "add") {
      if (line.startsWith("+")) {
        currentChange.diffLines.push(line.slice(1));
      }
      continue;
    }

    currentChange.diffLines.push(line);
  }

  pushCurrentChange();
  return changes.filter((change) => change.path);
}

function buildRenderableTurnsFromSession(rawSession = "") {
  const turns = new Map();
  const pendingToolCalls = new Map();
  let currentTurnId = null;
  let nextSyntheticId = 1;

  function nextId(prefix, turnId) {
    const normalizedTurnId = String(turnId || "unknown").replace(/[^\w.-]+/g, "-");
    const id = `${prefix}-${normalizedTurnId}-${nextSyntheticId}`;
    nextSyntheticId += 1;
    return id;
  }

  function ensureTurn(turnId) {
    if (!turnId) {
      return null;
    }

    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        _assistantSignatures: new Set(),
        _commandsByCallId: new Map(),
        _commandsBySessionId: new Map(),
        id: turnId,
        items: [],
        status: "inProgress",
      };
      turns.set(turnId, turn);
    }

    return turn;
  }

  function pushAssistantMessage(turn, turnId, phase, text, prefix = "session-agent") {
    const normalizedText = normalizeNewlines(text).trim();
    if (!turn || !normalizedText) {
      return;
    }

    const signature = `${phase || "unknown"}::${normalizedText}`;
    if (turn._assistantSignatures.has(signature)) {
      return;
    }

    turn._assistantSignatures.add(signature);
    turn.items.push({
      id: nextId(prefix, turnId),
      phase,
      text: normalizedText,
      type: "agentMessage",
    });
  }

  function ensureCommandItem(turn, turnId, toolCall, callId) {
    if (!turn || !toolCall || (toolCall.name !== "exec_command" && toolCall.name !== "write_stdin")) {
      return null;
    }

    const declaredSessionId = toolCall.name === "write_stdin"
      ? String(toolCall.arguments?.session_id || "")
      : "";
    const commandId = declaredSessionId
      ? `session-command-${declaredSessionId}`
      : `session-command-${callId}`;
    let commandItem = declaredSessionId ? turn._commandsBySessionId.get(declaredSessionId) : null;

    if (!commandItem && turn._commandsByCallId.has(callId)) {
      commandItem = turn._commandsByCallId.get(callId);
    }

    if (!commandItem) {
      commandItem = {
        aggregatedOutput: "",
        command: String(toolCall.arguments?.cmd || ""),
        commandActions: [],
        cwd: "/root",
        id: commandId,
        status: "inProgress",
        type: "commandExecution",
      };
      turn.items.push(commandItem);
    }

    commandItem.command = commandItem.command || String(toolCall.arguments?.cmd || "");
    turn._commandsByCallId.set(callId, commandItem);
    if (declaredSessionId) {
      turn._commandsBySessionId.set(declaredSessionId, commandItem);
    }
    return commandItem;
  }

  for (const line of rawSession.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const entry = safeJsonParse(trimmed);
    if (!entry) {
      continue;
    }

    if (entry.type === "event_msg") {
      const payload = entry.payload || {};

      if (payload.type === "task_started" && payload.turn_id) {
        currentTurnId = payload.turn_id;
        ensureTurn(currentTurnId);
        continue;
      }

      if (payload.type === "task_complete") {
        const completedTurn = ensureTurn(payload.turn_id || currentTurnId);
        if (completedTurn) {
          completedTurn.status = "completed";
        }
        currentTurnId = null;
        continue;
      }

      if (!currentTurnId) {
        continue;
      }

      const turn = ensureTurn(currentTurnId);
      if (!turn) {
        continue;
      }

      if (payload.type === "user_message" && payload.message) {
        turn.items.push({
          content: [{
            text: String(payload.message),
            type: "text",
          }],
          id: nextId("session-user", currentTurnId),
          type: "userMessage",
        });
        continue;
      }

      if (payload.type === "agent_message" && payload.message) {
        pushAssistantMessage(turn, currentTurnId, payload.phase, String(payload.message));
      }
      continue;
    }

    if (entry.type === "turn_context" && entry.payload?.turn_id) {
      currentTurnId = entry.payload.turn_id;
      ensureTurn(currentTurnId);
      continue;
    }

    if (entry.type !== "response_item") {
      continue;
    }

    const payload = entry.payload || {};
    if (payload.type === "message" && payload.role === "assistant" && currentTurnId) {
      const turn = ensureTurn(currentTurnId);
      pushAssistantMessage(turn, currentTurnId, payload.phase, textFromResponseMessageContent(payload.content), "session-agent-response");
      continue;
    }

    if (payload.type === "function_call" && payload.call_id) {
      const toolCall = {
        arguments: safeJsonParse(payload.arguments, {}),
        name: payload.name || "",
        turnId: currentTurnId,
      };
      pendingToolCalls.set(payload.call_id, toolCall);
      ensureCommandItem(ensureTurn(currentTurnId), currentTurnId, toolCall, payload.call_id);
      continue;
    }

    if (payload.type === "function_call_output" && payload.call_id) {
      const toolCall = pendingToolCalls.get(payload.call_id);
      if (!toolCall?.turnId) {
        continue;
      }

      const turn = ensureTurn(toolCall.turnId);
      if (!turn) {
        continue;
      }

      if (toolCall.name === "exec_command" || toolCall.name === "write_stdin") {
        const parsedOutput = parseCommandCallOutput(payload.output);
        const declaredSessionId = toolCall.name === "write_stdin"
          ? String(toolCall.arguments?.session_id || "")
          : "";
        const sessionId = parsedOutput.sessionId || declaredSessionId || null;
        const commandItem = ensureCommandItem(turn, toolCall.turnId, toolCall, payload.call_id);
        if (!commandItem) {
          continue;
        }

        commandItem.command = commandItem.command || parsedOutput.command || String(toolCall.arguments?.cmd || "");
        commandItem.aggregatedOutput = parsedOutput.aggregatedOutput
          ? `${commandItem.aggregatedOutput || ""}${parsedOutput.aggregatedOutput}`
          : commandItem.aggregatedOutput || "";
        commandItem.status = parsedOutput.status || commandItem.status || "completed";
        if (sessionId) {
          turn._commandsBySessionId.set(sessionId, commandItem);
        }
      }
      continue;
    }

    if (payload.type === "custom_tool_call" && payload.name === "apply_patch" && payload.status === "completed" && currentTurnId) {
      const turn = ensureTurn(currentTurnId);
      const changes = parseApplyPatchInput(payload.input);
      if (turn && changes.length) {
        turn.items.push({
          changes,
          id: `session-diff-${payload.call_id}`,
          status: "completed",
          type: "fileChange",
        });
      }
    }
  }

  return Array.from(turns.values()).map((turn) => ({
    id: turn.id,
    items: turn.items.map((item) => ({ ...item })),
    status: turn.status || "completed",
  }));
}

async function loadRenderableTurns(sessionPath) {
  const filePath = resolveSessionPath(sessionPath);
  if (!filePath || !existsSync(filePath)) {
    throw new Error("Session file not found");
  }

  const fileStats = await stat(filePath);
  const cacheKey = `${fileStats.mtimeMs}:${fileStats.size}`;
  const cached = threadRenderableItemsCache.get(filePath);
  if (cached?.cacheKey === cacheKey) {
    return cached.turns;
  }

  const rawSession = await readFile(filePath, "utf8");
  const turns = buildRenderableTurnsFromSession(rawSession);
  threadRenderableItemsCache.set(filePath, { cacheKey, turns });
  return turns;
}

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

  if (req.url === "/api/attachments" && req.method === "POST") {
    try {
      const payload = await readRequestBody(req);
      const files = Array.isArray(payload.files) ? payload.files : [];
      if (!files.length) {
        json(res, 400, { error: "No files provided" });
        return;
      }

      const savedFiles = [];
      for (const file of files) {
        savedFiles.push(await saveAttachment(file));
      }

      json(res, 200, { files: savedFiles });
    } catch (error) {
      json(res, 500, { error: error.message || "Failed to store attachments" });
    }
    return;
  }

  if (url.pathname === "/api/thread/renderable-items" && req.method === "GET") {
    const sessionPath = resolveSessionPath(url.searchParams.get("path"));
    if (!sessionPath) {
      json(res, 400, { error: "Invalid session path" });
      return;
    }

    try {
      json(res, 200, { turns: await loadRenderableTurns(sessionPath) });
    } catch (error) {
      json(res, 500, { error: error.message || "Failed to read thread renderable items" });
    }
    return;
  }

  if (url.pathname === "/api/attachments/file" && req.method === "GET") {
    const filePath = resolveUploadPath(url.searchParams.get("path"));
    if (!filePath || !existsSync(filePath)) {
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
        "Cache-Control": "no-cache",
        "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
      });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server error");
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
