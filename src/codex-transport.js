export function createCodexTransport({
  onNotification = async () => {},
  onOpen = async () => {},
  onClose = () => {},
  onError = () => {},
  onStateChange = () => {},
  reconnectDelayMs = 1200,
  url,
}) {
  let connected = false;
  let connecting = false;
  let manualClose = false;
  let nextRequestId = 1;
  let reconnectTimer = null;
  let socket = null;
  const pendingRequests = new Map();
  const pendingWaiters = new Set();

  function snapshot() {
    return {
      connected,
      connecting,
      socket,
    };
  }

  function emitStateChange() {
    onStateChange(snapshot());
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function rejectPendingRequests(error) {
    for (const { reject } of pendingRequests.values()) {
      reject(error);
    }
    pendingRequests.clear();
  }

  function rejectPendingWaiters(error) {
    for (const waiter of pendingWaiters) {
      if (waiter.timeoutId) {
        window.clearTimeout(waiter.timeoutId);
      }
      waiter.reject(error);
    }
    pendingWaiters.clear();
  }

  function resolvePendingWaiters() {
    for (const waiter of pendingWaiters) {
      if (waiter.timeoutId) {
        window.clearTimeout(waiter.timeoutId);
      }
      waiter.resolve();
    }
    pendingWaiters.clear();
  }

  function scheduleReconnect() {
    if (manualClose || reconnectTimer) {
      return;
    }

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function cleanupSocket(currentSocket = socket) {
    if (socket === currentSocket) {
      socket = null;
    }
    connected = false;
    connecting = false;
    emitStateChange();
  }

  function connect() {
    if (connected || connecting) {
      return;
    }

    manualClose = false;
    clearReconnectTimer();
    connecting = true;
    emitStateChange();

    const currentSocket = new WebSocket(url);
    socket = currentSocket;

    currentSocket.addEventListener("open", async () => {
      if (socket !== currentSocket) {
        currentSocket.close();
        return;
      }

      connected = true;
      connecting = false;
      emitStateChange();
      resolvePendingWaiters();

      try {
        await onOpen(snapshot());
      } catch (error) {
        onError(error, snapshot());
        currentSocket.close();
      }
    });

    currentSocket.addEventListener("message", async (event) => {
      let payload = null;

      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        onError(error, snapshot());
        return;
      }

      if (Object.hasOwn(payload, "id")) {
        const pending = pendingRequests.get(payload.id);
        if (!pending) {
          return;
        }

        pendingRequests.delete(payload.id);
        if (payload.error) {
          pending.reject(new Error(payload.error.message || "RPC error"));
          return;
        }

        pending.resolve(payload.result);
        return;
      }

      if (payload.method) {
        try {
          await onNotification(payload, snapshot());
        } catch (error) {
          onError(error, snapshot());
        }
      }
    });

    currentSocket.addEventListener("close", () => {
      if (socket !== currentSocket) {
        return;
      }

      cleanupSocket(currentSocket);
      const disconnectError = new Error("Codex app server is disconnected");
      rejectPendingRequests(disconnectError);
      rejectPendingWaiters(disconnectError);
      onClose(snapshot());
      scheduleReconnect();
    });

    currentSocket.addEventListener("error", (error) => {
      onError(error, snapshot());
    });
  }

  function waitForConnection(timeoutMs = 12000) {
    if (socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    connect();

    return new Promise((resolve, reject) => {
      const waiter = {
        reject,
        resolve,
        timeoutId: window.setTimeout(() => {
          pendingWaiters.delete(waiter);
          reject(new Error("Timed out while connecting to Codex app server"));
        }, timeoutMs),
      };

      pendingWaiters.add(waiter);
    });
  }

  async function rpc(method, params = {}) {
    await waitForConnection();
    const id = nextRequestId++;

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { reject, resolve });

      try {
        socket.send(JSON.stringify({ id, jsonrpc: "2.0", method, params }));
      } catch (error) {
        pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  async function notify(method, params = {}) {
    await waitForConnection();
    socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  return {
    connect,
    notify,
    rpc,
    snapshot,
    waitForConnection,
  };
}
