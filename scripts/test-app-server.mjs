import WebSocket from "ws";

const target = process.env.CODEX_TEST_WS_URL || "ws://127.0.0.1:4174";
const ws = new WebSocket(target);
let nextId = 1;
const pending = new Map();

function rpc(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function notify(method, params = {}) {
  ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
}

ws.on("message", async (raw) => {
  const payload = JSON.parse(raw.toString());

  if (Object.hasOwn(payload, "id")) {
    const handler = pending.get(payload.id);
    if (!handler) {
      return;
    }

    pending.delete(payload.id);

    if (payload.error) {
      handler.reject(new Error(payload.error.message || "RPC error"));
      return;
    }

    handler.resolve(payload.result);
    return;
  }

  if (payload.method === "account/login/completed") {
    console.log("login notification", payload.params);
  }
});

ws.on("open", async () => {
  try {
    await rpc("initialize", {
      clientInfo: {
        name: "codex-site-test",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: false,
      },
    });

    notify("initialized");

    const account = await rpc("account/read", { refreshToken: false });
    console.log("account", JSON.stringify(account, null, 2));

    const rateLimits = await rpc("account/rateLimits/read", {});
    console.log("rateLimits", JSON.stringify(rateLimits, null, 2));

    const threads = await rpc("thread/list", {
      archived: false,
      limit: 5,
      sourceKinds: ["cli", "appServer", "exec"],
      sortKey: "updated_at",
    });
    console.log("threads", JSON.stringify(threads, null, 2));

    ws.close();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    ws.close();
  }
});

ws.on("close", () => {
  process.exit();
});
