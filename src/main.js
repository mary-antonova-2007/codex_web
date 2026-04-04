import { createCodexTransport } from "./codex-transport.js";
import {
  assistantPhaseGroup,
  createMessageRenderer,
  messagesFromThreadItem,
  normalizeMessageText,
  textFromAgentItem,
  textFromRawResponseMessage,
  textFromUserItem,
} from "./messages.js";
import {
  createThreadStateHelpers,
  mergeTurnItem,
  reconcileOptimisticUserItems,
} from "./thread-state.js";
import { createThreadRuntimeHelpers } from "./thread-runtime.js";
import { createUiRenderer } from "./ui-render.js";

const DEFAULT_SETTINGS = {
  approvalPolicy: "never",
  enabledSkills: [],
  fastMode: false,
  model: "",
  planMode: false,
  personality: "pragmatic",
  promptTemplate: "",
  reasoningEffort: "medium",
  sandbox: "danger-full-access",
};

const STORAGE_KEY = "codex-site-settings-v1";
// UI state is stored separately from settings.
const UI_STATE_KEY = "codex-site-ui-state-v1";
const LIVE_ITEM_STORAGE_KEY = "codex-site-live-items-v1";
// Bump this when forcing the browser to pick up client updates.
const UI_VERSION = "20260404s";

// Keep version constants grouped near storage keys.
// Minor note for maintenance.
// DOM mount point for the app shell.
// App bootstrap starts here.
const app = document.querySelector("#app");

// The shell is rendered from JS so the UI can stay zero-dependency.
app.innerHTML = `
  <div class="app-shell">
    <section class="screen screen-list active" id="list-screen">
      <header class="screen-header">
        <div class="brand">
          <span class="brand-dot"></span>
          <div>
            <p class="eyebrow">Local Codex</p>
            <h1>Chats</h1>
          </div>
        </div>
        <div class="header-actions">
          <button class="ghost-button" id="resume-last-button" type="button">Resume last</button>
          <button class="primary-button" id="new-chat-button" type="button">New chat</button>
        </div>
      </header>

      <section class="panel account-summary">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Account</p>
            <h2 id="account-email">Checking login</h2>
          </div>
          <span class="pill pill-subtle" id="account-plan">guest</span>
        </div>
        <div class="limit-grid" id="account-limits"></div>
        <div class="account-actions">
          <button class="primary-button" id="login-button" type="button">Sign in</button>
          <button class="ghost-button" id="switch-account-button" type="button">Switch</button>
          <button class="ghost-button" id="logout-button" type="button">Logout</button>
          <button class="ghost-button" id="start-codex-button" type="button">Start Codex</button>
          <button class="ghost-button" id="stop-codex-button" type="button">Stop Codex</button>
          <button class="ghost-button" id="open-settings-button" type="button">Settings</button>
        </div>
        <a id="auth-link" class="auth-link hidden" href="#" target="_blank" rel="noreferrer">Open ChatGPT auth</a>
      </section>

      <section class="panel thread-panel">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Threads</p>
            <h2>Recent chats</h2>
          </div>
          <span class="pill" id="connection-status">Connecting</span>
        </div>
        <label class="search-field">
          <span class="sr-only">Search chats</span>
          <input id="thread-search" type="search" placeholder="Search by title or preview" />
        </label>
        <div class="thread-list" id="thread-list"></div>
      </section>
    </section>

    <section class="screen screen-chat" id="chat-screen">
      <header class="chat-topbar">
        <div class="chat-topbar-left">
          <button class="ghost-button icon-button back-button" id="back-to-list-button" type="button" aria-label="Back to chats">←</button>
          <span class="chat-topbar-title" id="thread-title">Codex</span>
        </div>
        <div class="chat-topbar-right">
          <button class="ghost-button icon-button" id="chat-menu-button" type="button" aria-label="Open chat menu">☰</button>
        </div>
      </header>

      <section class="chat-menu-panel hidden" id="chat-menu-panel">
        <div class="chat-menu-grid">
          <div class="chat-menu-item">
            <small>Chat</small>
            <strong id="chat-menu-thread-title">Codex</strong>
          </div>
          <div class="chat-menu-item">
            <small>User</small>
            <strong id="chat-user-name">Guest</strong>
          </div>
          <div class="chat-menu-item">
            <small>Status</small>
            <strong id="thread-status">idle</strong>
          </div>
          <div class="chat-menu-item chat-menu-limits" id="chat-header-limits"></div>
          <button class="chat-menu-action" id="chat-settings-button" type="button">Settings</button>
          <button class="chat-menu-action" id="chat-start-codex-button" type="button">Start Codex</button>
          <button class="chat-menu-action" id="chat-stop-codex-button" type="button">Stop Codex</button>
          <button class="chat-menu-action" id="chat-list-button" type="button">Chats</button>
        </div>
      </section>

      <section class="chat-scroll-wrap">
        <div class="messages" id="messages"></div>
        <button class="scroll-to-bottom hidden" id="scroll-to-bottom-button" type="button" aria-label="Scroll to bottom">
          ˅
        </button>
      </section>

      <footer class="composer">
        <form class="composer-form" id="composer-form">
          <textarea id="prompt-input" rows="1" placeholder="Write a prompt for Codex"></textarea>
          <div class="composer-actions">
            <span class="hint" id="composer-hint">Shift+Enter for newline</span>
            <button class="primary-button" id="send-button" type="submit">Send</button>
          </div>
        </form>
      </footer>
    </section>

    <section class="screen screen-settings" id="settings-screen">
      <section class="settings-modal">
        <header class="settings-modal-header">
          <button class="ghost-button back-button" id="back-from-settings-button" type="button">Back</button>
          <div class="settings-modal-title">
            <p class="eyebrow">Codex</p>
            <h1>Settings</h1>
          </div>
          <button class="primary-button" id="save-settings-button" type="submit" form="settings-form">Save</button>
        </header>

        <section class="panel settings-panel">
          <form id="settings-form" class="settings-form">
          <label class="settings-field">
            <span>Prompt instructions</span>
            <textarea id="setting-prompt-template" rows="5" placeholder="Extra instructions for new chats and resumed chats"></textarea>
          </label>

          <label class="settings-field">
            <span>Model</span>
            <input id="setting-model" type="text" placeholder="Leave blank for default" />
          </label>

          <label class="settings-field">
            <span>Reasoning effort</span>
            <select id="setting-effort">
              <option value="none">none</option>
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
          </label>

          <label class="settings-field">
            <span>Sandbox</span>
            <select id="setting-sandbox">
              <option value="danger-full-access">danger-full-access</option>
              <option value="workspace-write">workspace-write</option>
              <option value="read-only">read-only</option>
            </select>
          </label>

          <label class="settings-field">
            <span>Permissions</span>
            <select id="setting-approval">
              <option value="never">Full access</option>
              <option value="on-request">With confirmation</option>
            </select>
          </label>

          <label class="settings-field">
            <span>Personality</span>
            <select id="setting-personality">
              <option value="pragmatic">pragmatic</option>
              <option value="friendly">friendly</option>
              <option value="none">none</option>
            </select>
          </label>

          <div class="toggle-grid">
            <label class="toggle-row">
              <span>Fast mode</span>
              <input id="setting-fast-mode" type="checkbox" />
            </label>
            <label class="toggle-row">
              <span>Plan mode</span>
              <input id="setting-plan-mode" type="checkbox" />
            </label>
          </div>

          <section class="skills-box">
            <div class="panel-head panel-head-compact">
              <div>
                <span class="eyebrow">Skills</span>
                <h2>Installed skills</h2>
              </div>
              <button class="ghost-button" id="reload-skills-button" type="button">Reload skills</button>
            </div>
            <div class="skill-installer">
              <input id="skill-install-input" type="text" placeholder="Curated skill name or GitHub URL" />
              <button class="primary-button" id="install-skill-button" type="button">Install skill</button>
            </div>
            <div class="skills-catalog" id="skills-catalog"></div>
            <div class="skills-list" id="skills-list"></div>
          </section>

          <section class="skills-box debug-box">
            <div class="panel-head panel-head-compact">
              <div>
                <span class="eyebrow">Debug</span>
                <h2>Live protocol</h2>
              </div>
              <span class="pill pill-subtle" id="ui-version-badge">${UI_VERSION}</span>
            </div>
            <div class="debug-grid">
              <label class="settings-field">
                <span>Recent websocket methods</span>
                <textarea id="debug-methods" rows="8" readonly></textarea>
              </label>
              <label class="settings-field">
                <span>Recent thread item types</span>
                <textarea id="debug-items" rows="8" readonly></textarea>
              </label>
            </div>
          </section>

          </form>
        </section>
      </section>
    </section>
  </div>
`;

const elements = {
  accountEmail: document.querySelector("#account-email"),
  accountLimits: document.querySelector("#account-limits"),
  accountPlan: document.querySelector("#account-plan"),
  authLink: document.querySelector("#auth-link"),
  backFromSettingsButton: document.querySelector("#back-from-settings-button"),
  backToListButton: document.querySelector("#back-to-list-button"),
  chatHeaderLimits: document.querySelector("#chat-header-limits"),
  chatListButton: document.querySelector("#chat-list-button"),
  chatMenuButton: document.querySelector("#chat-menu-button"),
  chatMenuPanel: document.querySelector("#chat-menu-panel"),
  chatMenuThreadTitle: document.querySelector("#chat-menu-thread-title"),
  chatScreen: document.querySelector("#chat-screen"),
  chatSettingsButton: document.querySelector("#chat-settings-button"),
  chatStartCodexButton: document.querySelector("#chat-start-codex-button"),
  chatStopCodexButton: document.querySelector("#chat-stop-codex-button"),
  chatUserName: document.querySelector("#chat-user-name"),
  composer: document.querySelector(".composer"),
  composerForm: document.querySelector("#composer-form"),
  composerHint: document.querySelector("#composer-hint"),
  connectionStatus: document.querySelector("#connection-status"),
  debugItems: document.querySelector("#debug-items"),
  debugMethods: document.querySelector("#debug-methods"),
  listScreen: document.querySelector("#list-screen"),
  loginButton: document.querySelector("#login-button"),
  logoutButton: document.querySelector("#logout-button"),
  messages: document.querySelector("#messages"),
  newChatButton: document.querySelector("#new-chat-button"),
  openSettingsButton: document.querySelector("#open-settings-button"),
  promptInput: document.querySelector("#prompt-input"),
  installSkillButton: document.querySelector("#install-skill-button"),
  reloadSkillsButton: document.querySelector("#reload-skills-button"),
  resumeLastButton: document.querySelector("#resume-last-button"),
  scrollToBottomButton: document.querySelector("#scroll-to-bottom-button"),
  search: document.querySelector("#thread-search"),
  sendButton: document.querySelector("#send-button"),
  saveSettingsButton: document.querySelector("#save-settings-button"),
  settingApproval: document.querySelector("#setting-approval"),
  settingEffort: document.querySelector("#setting-effort"),
  settingFastMode: document.querySelector("#setting-fast-mode"),
  settingModel: document.querySelector("#setting-model"),
  settingPersonality: document.querySelector("#setting-personality"),
  settingPlanMode: document.querySelector("#setting-plan-mode"),
  settingPromptTemplate: document.querySelector("#setting-prompt-template"),
  settingSandbox: document.querySelector("#setting-sandbox"),
  settingsForm: document.querySelector("#settings-form"),
  settingsScreen: document.querySelector("#settings-screen"),
  skillInstallInput: document.querySelector("#skill-install-input"),
  skillsCatalog: document.querySelector("#skills-catalog"),
  skillsList: document.querySelector("#skills-list"),
  startCodexButton: document.querySelector("#start-codex-button"),
  stopCodexButton: document.querySelector("#stop-codex-button"),
  switchAccountButton: document.querySelector("#switch-account-button"),
  threadList: document.querySelector("#thread-list"),
  threadStatus: document.querySelector("#thread-status"),
  threadTitle: document.querySelector("#thread-title"),
};

const uiRenderer = createUiRenderer({
  elements,
  escapeHtml,
  extractRateLimitCards,
  formatPlan,
  formatTimestamp,
  getThreadLabel,
  getThreadSubtitle,
  normalizeStatus,
});

const {
  renderAccount,
  renderCatalog,
  renderChatMenu,
  renderComposerState,
  renderConnection,
  renderHeader,
  renderScreens,
  renderSkills,
  renderThreads,
  syncComposerInteractivity,
} = uiRenderer;

const {
  removeMessageElement,
  renderEmptyMessagesState,
  syncRenderedMessages,
  upsertMessageElement,
} = createMessageRenderer({
  elements,
  escapeHtml,
  toMessageHtml,
  updateScrollButton,
});

const state = {
  account: null,
  activeThreadSyncTimer: null,
  activeTurnId: null,
  connected: false,
  connecting: false,
  finalAssistantFallbacks: new Map(),
  lastError: null,
  liveThreadItems: loadLiveThreadItems(),
  pendingAssistantMessages: new Map(),
  pendingLiveItems: new Map(),
  pendingLoginId: null,
  rateLimits: null,
  recentItemTypes: [],
  recentMethods: [],
  refreshTimer: null,
  selectedThread: null,
  selectedThreadId: null,
  settings: loadSettings(),
  streamRenderTimers: new Map(),
  streamRenderState: new Map(),
  curatedSkills: [],
  chatMenuOpen: false,
  skills: [],
  threadLoadRequestIds: new Map(),
  threadActivities: new Map(),
  settingsReturnView: "list",
  threads: [],
  view: "list",
};

let autoScrollPinned = true;

function loadSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
}

function loadUiState() {
  try {
    return JSON.parse(window.localStorage.getItem(UI_STATE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveUiState() {
  window.localStorage.setItem(
    UI_STATE_KEY,
    JSON.stringify({
      selectedThreadId: state.selectedThreadId,
      view: state.view,
    }),
  );
}

function loadLiveThreadItems() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(LIVE_ITEM_STORAGE_KEY) || "{}");
    return new Map(
      Object.entries(saved).map(([threadId, entries]) => [
        threadId,
        Array.isArray(entries)
          ? entries
              .map((entry) => ({
                item: entry?.item || null,
                turnId: entry?.turnId || null,
                updatedAt: entry?.updatedAt || 0,
              }))
              .filter((entry) => entry.item?.id && entry.item?.type)
          : [],
      ]),
    );
  } catch {
    return new Map();
  }
}

function saveLiveThreadItems() {
  const serializable = {};

  for (const [threadId, entries] of state.liveThreadItems) {
    if (!Array.isArray(entries) || !entries.length) {
      continue;
    }

    serializable[threadId] = entries.slice(-80);
  }

  window.localStorage.setItem(LIVE_ITEM_STORAGE_KEY, JSON.stringify(serializable));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function toMessageHtml(text) {
  return escapeHtml(text).replace(/\n/g, "<br />");
}

function getThreadLabel(thread) {
  return thread?.name || thread?.preview || "Untitled chat";
}

function getThreadSubtitle(thread) {
  return thread?.preview || thread?.path || thread?.id || "";
}

function formatTimestamp(unixSeconds) {
  if (!unixSeconds) {
    return "";
  }

  return new Date(unixSeconds * 1000).toLocaleString("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function normalizeStatus(status) {
  if (!status) {
    return "unknown";
  }
  if (typeof status === "string") {
    return status;
  }
  return status.type || "unknown";
}

function pushDebugEntry(list, value, limit = 24) {
  if (!value) {
    return;
  }
  list.unshift(value);
  if (list.length > limit) {
    list.length = limit;
  }
}

function rememberMethod(method) {
  pushDebugEntry(state.recentMethods, `${new Date().toLocaleTimeString("ru-RU")}  ${method}`);
}

function rememberItemType(item, source = "item") {
  if (!item?.type) {
    return;
  }
  pushDebugEntry(
    state.recentItemTypes,
    `${new Date().toLocaleTimeString("ru-RU")}  ${source}: ${item.type}${item.phase ? ` (${item.phase})` : ""}`,
  );
}

function truncateInlineText(text, maxLength = 96) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function isLiveOnlyItemType(type) {
  return [
    "collabAgentToolCall",
    "commandExecution",
    "contextCompaction",
    "dynamicToolCall",
    "enteredReviewMode",
    "exitedReviewMode",
    "fileChange",
    "imageGeneration",
    "mcpToolCall",
    "plan",
    "reasoning",
    "webSearch",
  ].includes(type);
}

function getLiveThreadEntries(threadId) {
  return state.liveThreadItems.get(threadId) || [];
}

const {
  clearFinalAssistantFallback,
  clearResolvedFinalAssistantFallbacks,
  findAssistantMessageTarget,
  flattenMessages,
  hasFinalTurnMessage,
  hasRealFileChangeForTurn,
  mergeTurns,
  reconcileOptimisticTurnId,
  setFinalAssistantFallback,
  threadItemById,
  threadTurnById,
} = createThreadStateHelpers({
  assistantPhaseGroup,
  getLiveThreadEntries,
  messagesFromThreadItem,
  normalizeMessageText,
  normalizeStatus,
  state,
  textFromAgentItem,
  textFromUserItem,
});

const {
  appendOptimisticUserMessage,
  applyCompletedItem,
  applyRawResponseItemCompleted,
  applyStartedItem,
  applyStreamingAssistantDelta,
  applyStreamingLiveItemDelta,
  clearPendingStateForThread,
  finalizePendingAssistantForTurn,
  reconcileThreadActivity,
  renderMessages,
  scheduleStreamRender,
  upsertThreadTurnItem,
} = createThreadRuntimeHelpers({
  cleanupStreamState,
  clearFinalAssistantFallback,
  clearPendingAssistantMessagesForTurn,
  elements,
  findAssistantMessageTarget,
  flattenMessages,
  hasFinalTurnMessage,
  hasRealFileChangeForTurn,
  mergeTurnItem,
  messagesFromThreadItem,
  normalizeStatus,
  removeMessageElement,
  renderComposerState,
  renderEmptyMessagesState,
  reconcileOptimisticUserItems,
  removePendingAssistantMessage,
  removePendingLiveItem,
  scrollMessagesToBottom,
  setFinalAssistantFallback,
  setThreadActivityFromItem,
  state,
  stopActiveThreadSync,
  stopStreamRender,
  syncRenderedMessages,
  textFromAgentItem,
  textFromRawResponseMessage,
  threadItemById,
  threadTurnById,
  updateScrollButton,
  upsertLiveThreadItem,
  upsertMessageElement,
});

function getLiveThreadItem(threadId, itemId) {
  return getLiveThreadEntries(threadId).find((entry) => entry.item?.id === itemId)?.item || null;
}

function upsertLiveThreadItem(threadId, turnId, item) {
  if (!threadId || !item?.id || !isLiveOnlyItemType(item.type)) {
    return;
  }

  const entries = [...getLiveThreadEntries(threadId)];
  const index = entries.findIndex((entry) => entry.item?.id === item.id);
  const previousEntry = index >= 0 ? entries[index] : null;
  const mergedItem = mergeTurnItem(previousEntry?.item, item);
  const nextEntry = {
    item: mergedItem,
    turnId: turnId || previousEntry?.turnId || null,
    updatedAt: Date.now(),
  };

  if (index >= 0) {
    entries[index] = nextEntry;
  } else {
    entries.push(nextEntry);
  }

  state.liveThreadItems.set(threadId, entries);
  saveLiveThreadItems();
}

function clearThreadActivity(threadId) {
  if (!threadId) {
    return;
  }
  state.threadActivities.delete(threadId);
}

function activityTextFromItem(item) {
  if (!item?.type) {
    return "";
  }

  if (item.type === "reasoning") {
    return truncateInlineText([...(item.summary || []), ...(item.content || [])].filter(Boolean).join("\n"));
  }

  if (item.type === "commandExecution") {
    return item.command
      ? `Running: ${truncateInlineText(item.command, 88)}`
      : "Running command";
  }

  if (item.type === "fileChange") {
    const firstPath = item.changes?.[0]?.path;
    return firstPath
      ? `Applying changes: ${truncateInlineText(firstPath, 72)}`
      : "Applying code changes";
  }

  if (item.type === "plan") {
    return truncateInlineText(item.text) || "Updating plan";
  }

  if (item.type === "mcpToolCall") {
    return item.tool
      ? `Tool: ${truncateInlineText(item.tool, 72)}`
      : "Using tool";
  }

  if (item.type === "dynamicToolCall" || item.type === "collabAgentToolCall") {
    return item.tool
      ? `Tool: ${truncateInlineText(item.tool, 72)}`
      : "Using tool";
  }

  if (item.type === "webSearch") {
    return item.query
      ? `Searching: ${truncateInlineText(item.query, 72)}`
      : "Searching web";
  }

  if (item.type === "imageGeneration") {
    return "Generating image";
  }

  if (item.type === "contextCompaction") {
    return "Compacting context";
  }

  if (item.type === "enteredReviewMode") {
    return "Entering review mode";
  }

  if (item.type === "exitedReviewMode") {
    return "Leaving review mode";
  }

  return "";
}

function setThreadActivityFromItem(threadId, item) {
  const text = activityTextFromItem(item);
  if (!threadId || !text) {
    return;
  }
  state.threadActivities.set(threadId, text);
}

function formatPlan(planType) {
  return planType ? String(planType).replaceAll("_", " ") : "guest";
}

function formatResetTime(unixSeconds) {
  if (!unixSeconds) {
    return "unknown reset";
  }

  return new Date(unixSeconds * 1000).toLocaleString("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatWindowName(windowDurationMins, fallback) {
  if (windowDurationMins === 300) {
    return "5h";
  }
  if (windowDurationMins === 10080) {
    return "weekly";
  }
  if (windowDurationMins && windowDurationMins % 60 === 0) {
    return `${windowDurationMins / 60}h`;
  }
  return windowDurationMins ? `${windowDurationMins}m` : fallback;
}

function extractRateLimitCards(snapshot) {
  if (!snapshot) {
    return [];
  }

  return [
    { data: snapshot.primary, fallback: "primary" },
    { data: snapshot.secondary, fallback: "secondary" },
  ]
    .filter((entry) => entry.data)
    .map((entry) => ({
      remaining: Math.max(0, 100 - entry.data.usedPercent),
      resetsAt: formatResetTime(entry.data.resetsAt),
      title: formatWindowName(entry.data.windowDurationMins, entry.fallback),
    }));
}

function shouldShowScrollButton() {
  const distance = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight;
  return distance > 120;
}

function updateScrollButton() {
  elements.scrollToBottomButton.classList.toggle("hidden", !shouldShowScrollButton());
}

function scrollMessagesToBottom(force = false) {
  if (force || autoScrollPinned) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        elements.messages.scrollTop = elements.messages.scrollHeight;
        updateScrollButton();
      });
    });
    return;
  }
  updateScrollButton();
}

function syncComposerLayout() {
  const composerHeight = elements.composer?.offsetHeight || 0;
  // Keep the message list clear of the fixed mobile composer.
  document.documentElement.style.setProperty("--composer-offset", `${composerHeight + 18}px`);
  updateScrollButton();
}

function stopStreamRender(messageId) {
  const timer = state.streamRenderTimers.get(messageId);
  if (timer) {
    window.clearTimeout(timer);
    state.streamRenderTimers.delete(messageId);
  }
}

function cleanupStreamState(messageId) {
  stopStreamRender(messageId);
  state.streamRenderState.delete(messageId);
}

function clearPendingAssistantMessagesForTurn(threadId, turnId, text = "") {
  const normalizedText = normalizeMessageText(text);

  for (const [itemId, pending] of state.pendingAssistantMessages) {
    if (pending.threadId !== threadId || pending.turnId !== turnId) {
      continue;
    }

    const pendingText = normalizeMessageText(pending.text);
    if (normalizedText && pendingText && pendingText !== normalizedText) {
      continue;
    }

    removePendingAssistantMessage(itemId);
    cleanupStreamState(itemId);
  }
}

function removePendingAssistantMessage(itemId) {
  state.pendingAssistantMessages.delete(itemId);
  removeMessageElement(itemId);
}

function removePendingLiveItem(itemId) {
  state.pendingLiveItems.delete(itemId);
  removeMessageElement(itemId);
}

function renderSettings() {
  elements.settingModel.value = state.settings.model;
  elements.settingPromptTemplate.value = state.settings.promptTemplate;
  elements.settingEffort.value = state.settings.reasoningEffort;
  elements.settingSandbox.value = state.settings.sandbox;
  elements.settingApproval.value = state.settings.approvalPolicy;
  elements.settingPersonality.value = state.settings.personality;
  elements.settingFastMode.checked = state.settings.fastMode;
  elements.settingPlanMode.checked = state.settings.planMode;
  elements.debugMethods.value = state.recentMethods.join("\n");
  elements.debugItems.value = state.recentItemTypes.join("\n");
  renderSkills(state);
  renderCatalog(state);
}

function render() {
  renderScreens(state);
  renderConnection(state);
  renderAccount(state);
  renderThreads(state);
  renderHeader(state);
  renderChatMenu(state);
  renderMessages(autoScrollPinned);
  renderSettings();
}

function openView(view) {
  state.view = view;
  if (view !== "chat") {
    state.chatMenuOpen = false;
  }
  saveUiState();
  render();
}

function openSettingsView(sourceView = state.view) {
  state.settingsReturnView = sourceView === "chat" ? "chat" : "list";
  openView("settings");
  renderSettings();
}

function closeSettingsView() {
  openView(state.settingsReturnView === "chat" ? "chat" : "list");
}

function currentThreadOptions() {
  return {
    approvalPolicy: state.settings.approvalPolicy,
    developerInstructions: buildDeveloperInstructions(),
    model: state.settings.model || null,
    personality: state.settings.personality || null,
    sandbox: state.settings.sandbox || null,
    serviceTier: state.settings.fastMode ? "fast" : null,
  };
}

function buildTurnSandboxPolicy() {
  if (state.settings.sandbox === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }

  if (state.settings.sandbox === "workspace-write") {
    return {
      networkAccess: true,
      type: "workspaceWrite",
      writableRoots: ["/root"],
    };
  }

  return {
    access: { type: "fullAccess" },
    networkAccess: false,
    type: "readOnly",
  };
}

function currentTurnOptions() {
  return {
    approvalPolicy: state.settings.approvalPolicy,
    effort: state.settings.reasoningEffort || null,
    model: state.settings.model || null,
    personality: state.settings.personality || null,
    sandboxPolicy: buildTurnSandboxPolicy(),
    serviceTier: state.settings.fastMode ? "fast" : null,
  };
}

function buildDeveloperInstructions() {
  const parts = [];

  if (state.settings.promptTemplate.trim()) {
    parts.push(state.settings.promptTemplate.trim());
  }

  if (state.settings.planMode) {
    parts.push("Work in plan mode by default: present or maintain a concise plan before substantial implementation.");
  }

  return parts.length ? parts.join("\n\n") : null;
}

function getSelectedSkillInputs() {
  const skills = state.skills.flatMap((entry) => entry.skills || []).filter((skill) =>
    state.settings.enabledSkills.includes(skill.path),
  );

  return skills.map((skill) => ({
    name: skill.name,
    path: skill.path,
    type: "skill",
  }));
}

async function initializeConnection() {
  await rpc("initialize", {
    capabilities: {
      experimentalApi: false,
    },
    clientInfo: {
      name: "codex-local-web",
      version: "0.0.2",
    },
  });

  await notify("initialized");
}

async function loadAccountState() {
  const accountResponse = await rpc("account/read", { refreshToken: false });
  state.account = accountResponse.account;

  try {
    const rateLimitResponse = await rpc("account/rateLimits/read", {});
    state.rateLimits = rateLimitResponse.rateLimits;
  } catch {
    state.rateLimits = null;
  }

  renderAccount(state);
}

async function loadSkills(forceReload = false) {
  const response = await rpc("skills/list", {
    cwds: ["/root"],
    forceReload,
  });

  state.skills = response.data || [];
  renderSkills(state);
}

async function loadCuratedSkills() {
  try {
    const response = await api("/api/skills/catalog");
    state.curatedSkills = Array.isArray(response.data)
      ? response.data.map((entry) => (typeof entry === "string" ? entry : entry.name)).filter(Boolean)
      : [];
  } catch {
    state.curatedSkills = [];
  }

  renderCatalog(state);
}

async function loadThreads() {
  const response = await rpc("thread/list", {
    archived: false,
    limit: 100,
    sortKey: "updated_at",
    sourceKinds: ["cli", "appServer", "exec"],
  });

  state.threads = response.data || [];

  if (state.selectedThreadId) {
    const selectedSummary = state.threads.find((thread) => thread.id === state.selectedThreadId);
    if (selectedSummary && state.selectedThread) {
      state.selectedThread = { ...selectedSummary, turns: state.selectedThread.turns || [] };
      reconcileThreadActivity(state.selectedThread);
    }
  }

  renderThreads(state);
}

async function loadThread(threadId, includeTurns = true, forceScrollToBottom = true) {
  const previousThreadId = state.selectedThreadId;
  const isSameThread = previousThreadId === threadId;
  const isThreadSwitch = state.selectedThreadId && state.selectedThreadId !== threadId;
  if (isThreadSwitch) {
    for (const messageId of state.streamRenderTimers.keys()) {
      stopStreamRender(messageId);
    }
    state.streamRenderState.clear();
  }

  state.selectedThreadId = threadId;
  const summary = state.threads.find((thread) => thread.id === threadId) || null;
  if (isSameThread && state.selectedThread?.id === threadId && includeTurns) {
    state.selectedThread = summary
      ? { ...summary, turns: state.selectedThread.turns || [] }
      : state.selectedThread;
  } else {
    state.selectedThread = summary;
  }

  if (!isSameThread || !includeTurns) {
    render();
  }

  if (!includeTurns) {
    openView("chat");
    return;
  }

  const requestId = (state.threadLoadRequestIds.get(threadId) || 0) + 1;
  state.threadLoadRequestIds.set(threadId, requestId);

  const response = await rpc("thread/read", {
    includeTurns: true,
    threadId,
  });

  if (state.threadLoadRequestIds.get(threadId) !== requestId || state.selectedThreadId !== threadId) {
    return;
  }

  const previousTurns = state.selectedThread?.turns || [];
  state.selectedThread = response.thread;
  state.selectedThread.turns = mergeTurns(previousTurns, response.thread.turns || []);
  clearResolvedFinalAssistantFallbacks(state.selectedThread);
  for (const turn of response.thread.turns || []) {
    for (const item of turn.items || []) {
      rememberItemType(item, "read");
    }
  }
  state.selectedThreadId = response.thread.id;
  state.threads = state.threads.map((thread) =>
    thread.id === response.thread.id ? { ...thread, ...response.thread } : thread,
  );
  reconcileThreadActivity(state.selectedThread, { clearPending: true });
  openView("chat");
  saveUiState();
  render();
  if (forceScrollToBottom) {
    scrollMessagesToBottom(true);
  }
}

async function ensureResumed(threadId) {
  const thread = state.threads.find((entry) => entry.id === threadId);
  if (normalizeStatus(thread?.status) !== "notLoaded") {
    return;
  }

  await rpc("thread/resume", {
    cwd: "/root",
    threadId,
    ...currentThreadOptions(),
  });
}

async function createThread(promptText) {
  const response = await rpc("thread/start", {
    cwd: "/root",
    ...currentThreadOptions(),
  });

  state.threads.unshift(response.thread);
  state.selectedThread = response.thread;
  state.selectedThreadId = response.thread.id;
  openView("chat");
  saveUiState();
  render();
  await startTurn(response.thread.id, promptText);
}

async function startTurn(threadId, promptText) {
  await ensureResumed(threadId);

  clearThreadActivity(threadId);
  state.selectedThreadId = threadId;
  state.selectedThread = {
    ...(state.selectedThread || {}),
    id: threadId,
    status: { type: "active" },
    turns: state.selectedThread?.turns || [],
  };
  openView("chat");
  appendOptimisticUserMessage(threadId, `pending-${Date.now()}`, promptText);
  autoScrollPinned = true;
  renderComposerState(state);
  renderHeader(state);
  renderChatMenu(state);

  const response = await rpc("turn/start", {
    input: [
      {
        text: promptText,
        type: "text",
      },
      ...getSelectedSkillInputs(),
    ],
    threadId,
    ...currentTurnOptions(),
  });

  state.selectedThreadId = threadId;
  state.selectedThread = {
    ...(state.selectedThread || {}),
    id: threadId,
    status: { type: "active" },
  };
  const reconciledOptimisticTurn = Array.isArray(state.selectedThread.turns)
    && reconcileOptimisticTurnId(state.selectedThread, response.turn.id);
  if (!reconciledOptimisticTurn) {
    appendOptimisticUserMessage(threadId, response.turn.id, promptText);
  }
  openView("chat");
  render();
  state.activeTurnId = response.turn.id;
  autoScrollPinned = true;
  renderComposerState(state);
  startActiveThreadSync(threadId);
}

async function sendPrompt(promptText) {
  if (!promptText.trim()) {
    return;
  }

  if (!state.connected) {
    alert("Codex is still connecting. Wait for Connected.");
    return;
  }

  elements.sendButton.disabled = true;

  try {
    if (!state.selectedThreadId) {
      await createThread(promptText);
    } else {
      await startTurn(state.selectedThreadId, promptText);
    }

    elements.promptInput.value = "";
    autoSizeTextarea();
  } catch (error) {
    console.error(error);
    alert(`Request failed: ${error.message}`);
  } finally {
    elements.sendButton.disabled = !state.connected;
  }
}

function autoSizeTextarea() {
  elements.promptInput.style.height = "auto";
  elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 220)}px`;
  syncComposerLayout();
  if (autoScrollPinned) {
    scrollMessagesToBottom(true);
  }
}

async function handleNotification(payload) {
  const { method, params } = payload;
  rememberMethod(method);

  if (method === "thread/started") {
    state.threads.unshift(params.thread);
    renderThreads(state);
    return;
  }

  if (method === "thread/status/changed") {
    state.threads = state.threads.map((thread) =>
      thread.id === params.threadId ? { ...thread, status: params.status } : thread,
    );

    if (state.selectedThreadId === params.threadId && state.selectedThread) {
      state.selectedThread = { ...state.selectedThread, status: params.status };
      reconcileThreadActivity(state.selectedThread);
    }

    renderThreads(state);
    renderHeader(state);
    renderChatMenu(state);
    renderMessages(autoScrollPinned);
    return;
  }

  if (method === "item/agentMessage/delta") {
    applyStreamingAssistantDelta({
      delta: params.delta,
      itemId: params.itemId,
      threadId: params.threadId,
      turnId: params.turnId,
    }, autoScrollPinned);
    return;
  }

  if (method === "item/started") {
    rememberItemType(params.item, "started");
    applyStartedItem({
      item: params.item,
      threadId: params.threadId,
      turnId: params.turnId,
    }, autoScrollPinned);
    return;
  }

  if (method === "item/commandExecution/outputDelta") {
    applyStreamingLiveItemDelta({
      delta: params.delta,
      factory: () => ({
        aggregatedOutput: "",
        command: "",
        commandActions: [],
        cwd: "/root",
        id: params.itemId,
        status: "inProgress",
        type: "commandExecution",
      }),
      itemId: params.itemId,
      meta: "Command",
      mutate: (item) => {
        item.aggregatedOutput = `${item.aggregatedOutput || ""}${params.delta}`;
        item.status = "inProgress";
      },
      threadId: params.threadId,
      turnId: params.turnId,
    }, autoScrollPinned);
    return;
  }

  if (method === "item/fileChange/outputDelta") {
    applyStreamingLiveItemDelta({
      delta: params.delta,
      factory: () => ({
        changes: [{ diff: "", kind: { type: "update" }, path: "pending.diff" }],
        id: params.itemId,
        status: "inProgress",
        type: "fileChange",
      }),
      itemId: params.itemId,
      meta: "Code changes",
      mutate: (item) => {
        if (!Array.isArray(item.changes) || !item.changes.length) {
          item.changes = [{ diff: "", kind: { type: "update" }, path: "pending.diff" }];
        }
        item.changes[0].diff = `${item.changes[0].diff || ""}${params.delta}`;
        item.status = "inProgress";
      },
      threadId: params.threadId,
      turnId: params.turnId,
    }, autoScrollPinned);
    return;
  }

  if (method === "item/reasoning/textDelta") {
    applyStreamingLiveItemDelta({
      delta: params.delta,
      factory: () => ({
        content: [],
        id: params.itemId,
        summary: [],
        type: "reasoning",
      }),
      itemId: params.itemId,
      meta: "Reasoning",
      mutate: (item) => {
        const index = Number(params.contentIndex) || 0;
        const content = [...(item.content || [])];
        content[index] = `${content[index] || ""}${params.delta}`;
        item.content = content;
      },
      threadId: params.threadId,
      turnId: params.turnId,
    }, autoScrollPinned);
    return;
  }

  if (method === "item/reasoningSummary/textDelta") {
    applyStreamingLiveItemDelta({
      delta: params.delta,
      factory: () => ({
        content: [],
        id: params.itemId,
        summary: [],
        type: "reasoning",
      }),
      itemId: params.itemId,
      meta: "Reasoning",
      mutate: (item) => {
        const index = Number(params.summaryIndex) || 0;
        const summary = [...(item.summary || [])];
        summary[index] = `${summary[index] || ""}${params.delta}`;
        item.summary = summary;
      },
      threadId: params.threadId,
      turnId: params.turnId,
    }, autoScrollPinned);
    return;
  }

  if (method === "turn/planUpdated") {
    applyStartedItem({
      item: {
        id: `plan-${params.turnId}`,
        text: [params.explanation, ...(params.plan || []).map((step) => `[${step.status}] ${step.step}`)]
          .filter(Boolean)
          .join("\n"),
        type: "plan",
      },
      threadId: params.threadId,
      turnId: params.turnId,
    }, autoScrollPinned);
    return;
  }

  if (method === "turn/diffUpdated" || method === "turn/diff/updated") {
    if (hasRealFileChangeForTurn(params.threadId, params.turnId)) {
      return;
    }

    applyStartedItem({
      item: {
        changes: [{
          diff: params.diff,
          kind: { type: "update" },
          path: "turn.diff",
        }],
        id: `diff-${params.turnId}`,
        status: "inProgress",
        type: "fileChange",
      },
      threadId: params.threadId,
      turnId: params.turnId,
    }, autoScrollPinned);
    return;
  }

  if (method === "item/completed") {
    rememberItemType(params.item, "completed");
    applyCompletedItem({
      item: params.item,
      threadId: params.threadId,
      turnId: params.turnId,
    }, autoScrollPinned);
    return;
  }

  if (method === "rawResponseItem/completed") {
    applyRawResponseItemCompleted({
      item: params.item,
      threadId: params.threadId,
      turnId: params.turnId,
    }, autoScrollPinned);
    return;
  }

  if (method === "turn/completed") {
    state.activeTurnId = null;
    clearThreadActivity(params.threadId);
    stopActiveThreadSync();
    renderComposerState(state);
    if (params.threadId === state.selectedThreadId) {
      const completedTurnId = params.turn?.id || params.turnId;
      for (const item of params.turn?.items || []) {
        applyCompletedItem({
          item,
          threadId: params.threadId,
          turnId: completedTurnId,
        }, autoScrollPinned);
      }

      if (!hasFinalTurnMessage(state.selectedThread, completedTurnId)) {
        finalizePendingAssistantForTurn(params.threadId, completedTurnId);
      }

      renderMessages(autoScrollPinned);
      syncComposerInteractivity(state);
      window.setTimeout(() => elements.promptInput.focus(), 0);

      await loadThread(params.threadId, true, false).catch(() => {});

      window.setTimeout(() => {
        loadThread(params.threadId, true, false).catch(() => {});
      }, 250);
      window.setTimeout(() => {
        loadThread(params.threadId, true, false).catch(() => {});
      }, 1200);

      const pollForFinal = async (attempt = 0) => {
        await loadThread(params.threadId, true, false).catch(() => {});
        if (hasFinalTurnMessage(state.selectedThread, completedTurnId)) {
          renderMessages(autoScrollPinned);
          return;
        }
        if (attempt >= 20) {
          return;
        }
        window.setTimeout(() => {
          pollForFinal(attempt + 1).catch(() => {});
        }, 750);
      };

      window.setTimeout(() => {
        pollForFinal().catch(() => {});
      }, 300);
    } else {
      await loadThreads();
    }
    return;
  }

  if (method === "account/updated") {
    await loadAccountState();
    return;
  }

  if (method === "account/rateLimits/updated") {
    state.rateLimits = params.rateLimits;
    renderAccount(state);
    return;
  }

  if (method === "account/login/completed") {
    if (!params.success) {
      alert(params.error || "ChatGPT login failed");
      return;
    }

    state.pendingLoginId = null;
    elements.authLink.href = "#";
    await loadAccountState();
  }
}

async function startChatGptLogin() {
  const response = await rpc("account/login/start", { type: "chatgpt" });
  if (response.type !== "chatgpt") {
    return;
  }

  state.pendingLoginId = response.loginId;
  elements.authLink.href = response.authUrl;
  elements.authLink.classList.remove("hidden");
  window.open(response.authUrl, "_blank", "noopener,noreferrer");
}

async function logoutAccount() {
  await rpc("account/logout", {});
  state.account = null;
  state.rateLimits = null;
  state.pendingLoginId = null;
  elements.authLink.href = "#";
  renderAccount(state);
}

function startRefreshLoop() {
  if (state.refreshTimer) {
    window.clearInterval(state.refreshTimer);
  }

  state.refreshTimer = window.setInterval(async () => {
    if (!state.connected) {
      return;
    }

    try {
      await loadThreads();
      if (state.selectedThreadId && normalizeStatus(state.selectedThread?.status) === "active") {
        await loadThread(state.selectedThreadId, true, false);
      }
    } catch {
      // keep quiet during polling
    }
  }, 8000);
}

function startActiveThreadSync(threadId) {
  if (state.activeThreadSyncTimer) {
    window.clearInterval(state.activeThreadSyncTimer);
  }

  state.activeThreadSyncTimer = window.setInterval(async () => {
    if (!state.connected || !state.selectedThreadId || state.selectedThreadId !== threadId) {
      return;
    }

    try {
      await loadThread(threadId, true, false);
      if (normalizeStatus(state.selectedThread?.status) !== "active") {
        stopActiveThreadSync();
      }
    } catch {
      // ignore transient sync failures
    }
  }, 1500);
}

function stopActiveThreadSync() {
  if (state.activeThreadSyncTimer) {
    window.clearInterval(state.activeThreadSyncTimer);
    state.activeThreadSyncTimer = null;
  }
}

const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const transport = createCodexTransport({
  url: `${protocol}//${window.location.host}/codex`,
  onStateChange: ({ connected, connecting }) => {
    state.connected = connected;
    state.connecting = connecting;
    renderConnection(state);
  },
  onOpen: async () => {
    await initializeConnection();
    await loadAccountState();
    await loadThreads();
    await loadSkills(false);
    await loadCuratedSkills();
    if (state.selectedThreadId && state.view === "chat") {
      await loadThread(state.selectedThreadId);
    }
    startRefreshLoop();
  },
  onNotification: handleNotification,
  onClose: () => {
    state.lastError = null;
  },
  onError: (error) => {
    console.error(error);
    state.lastError = error;
  },
});

async function startCodexServer() {
  await api("/api/app-server/start", { method: "POST" });
  transport.connect();
}

async function stopCodexServer() {
  await api("/api/app-server/stop", { method: "POST" });
  state.connected = false;
  state.connecting = false;
  renderConnection(state);
}

async function rpc(method, params = {}) {
  return transport.rpc(method, params);
}

async function notify(method, params = {}) {
  return transport.notify(method, params);
}

elements.threadList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-thread-id]");
  if (!button) {
    return;
  }

  await loadThread(button.dataset.threadId);
});

elements.search.addEventListener("input", () => {
  renderThreads(state);
});

elements.newChatButton.addEventListener("click", () => {
  stopActiveThreadSync();
  state.activeTurnId = null;
  for (const messageId of state.streamRenderTimers.keys()) {
    stopStreamRender(messageId);
  }
  state.streamRenderState.clear();
  state.selectedThread = null;
  state.selectedThreadId = null;
  state.pendingAssistantMessages.clear();
  openView("chat");
  saveUiState();
  render();
  window.setTimeout(() => elements.promptInput.focus(), 0);
});

elements.resumeLastButton.addEventListener("click", async () => {
  if (!state.threads.length) {
    return;
  }
  await loadThread(state.threads[0].id);
});

elements.backToListButton.addEventListener("click", () => {
  stopActiveThreadSync();
  for (const messageId of state.streamRenderTimers.keys()) {
    stopStreamRender(messageId);
  }
  state.streamRenderState.clear();
  openView("list");
});

elements.chatMenuButton.addEventListener("click", () => {
  state.chatMenuOpen = !state.chatMenuOpen;
  renderChatMenu(state);
});

elements.openSettingsButton.addEventListener("click", () => {
  openSettingsView("list");
});

elements.chatSettingsButton.addEventListener("click", () => {
  openSettingsView("chat");
});

elements.chatListButton.addEventListener("click", () => {
  openView("list");
});

elements.backFromSettingsButton.addEventListener("click", () => {
  closeSettingsView();
});

elements.startCodexButton.addEventListener("click", async () => {
  try {
    await startCodexServer();
  } catch (error) {
    alert(`Start failed: ${error.message}`);
  }
});

elements.chatStartCodexButton.addEventListener("click", async () => {
  try {
    await startCodexServer();
  } catch (error) {
    alert(`Start failed: ${error.message}`);
  }
});

elements.stopCodexButton.addEventListener("click", async () => {
  try {
    await stopCodexServer();
  } catch (error) {
    alert(`Stop failed: ${error.message}`);
  }
});

elements.chatStopCodexButton.addEventListener("click", async () => {
  try {
    await stopCodexServer();
  } catch (error) {
    alert(`Stop failed: ${error.message}`);
  }
});

elements.loginButton.addEventListener("click", async () => {
  try {
    await startChatGptLogin();
  } catch (error) {
    alert(`Login failed: ${error.message}`);
  }
});

elements.switchAccountButton.addEventListener("click", async () => {
  try {
    if (state.account) {
      await logoutAccount();
    }
    await startChatGptLogin();
  } catch (error) {
    alert(`Switch account failed: ${error.message}`);
  }
});

elements.logoutButton.addEventListener("click", async () => {
  try {
    await logoutAccount();
  } catch (error) {
    alert(`Logout failed: ${error.message}`);
  }
});

elements.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.settings = {
    approvalPolicy: elements.settingApproval.value,
    enabledSkills: state.settings.enabledSkills,
    fastMode: elements.settingFastMode.checked,
    model: elements.settingModel.value.trim(),
    planMode: elements.settingPlanMode.checked,
    personality: elements.settingPersonality.value,
    promptTemplate: elements.settingPromptTemplate.value,
    reasoningEffort: elements.settingEffort.value,
    sandbox: elements.settingSandbox.value,
  };
  saveSettings();
  closeSettingsView();
});

elements.reloadSkillsButton.addEventListener("click", async () => {
  try {
    await loadSkills(true);
    await loadCuratedSkills();
  } catch (error) {
    alert(`Skills reload failed: ${error.message}`);
  }
});

elements.installSkillButton.addEventListener("click", async () => {
  const raw = elements.skillInstallInput.value.trim();
  if (!raw) {
    return;
  }

  try {
    const payload = raw.startsWith("http://") || raw.startsWith("https://")
      ? { url: raw }
      : { curatedName: raw };
    await api("/api/skills/install", {
      body: JSON.stringify(payload),
      method: "POST",
    });
    elements.skillInstallInput.value = "";
    await loadSkills(true);
    await loadCuratedSkills();
    alert("Skill installed. Restart Codex to pick up new skills everywhere.");
  } catch (error) {
    alert(`Skill install failed: ${error.message}`);
  }
});

elements.skillsList.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".skill-checkbox");
  if (!checkbox) {
    return;
  }

  const path = checkbox.dataset.skillPath;
  if (!path) {
    return;
  }

  const selected = new Set(state.settings.enabledSkills);
  if (checkbox.checked) {
    selected.add(path);
  } else {
    selected.delete(path);
  }

  state.settings.enabledSkills = [...selected];
  saveSettings();
});

elements.skillsCatalog.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-install-curated]");
  if (!button) {
    return;
  }

  elements.skillInstallInput.value = button.dataset.installCurated;
  await elements.installSkillButton.click();
});

elements.promptInput.addEventListener("input", autoSizeTextarea);

elements.promptInput.addEventListener("input", () => {
  renderComposerState(state);
});

elements.promptInput.addEventListener("keydown", async (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    await sendPrompt(elements.promptInput.value);
  }
});

elements.composerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendPrompt(elements.promptInput.value);
});

elements.messages.addEventListener("scroll", () => {
  const distance = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight;
  autoScrollPinned = distance < 40;
  updateScrollButton();
});

elements.scrollToBottomButton.addEventListener("click", () => {
  autoScrollPinned = true;
  scrollMessagesToBottom(true);
});

autoSizeTextarea();
window.addEventListener("resize", syncComposerLayout);
const uiState = loadUiState();
if (uiState.view && ["list", "chat", "settings"].includes(uiState.view)) {
  state.view = uiState.view;
}
if (uiState.selectedThreadId) {
  state.selectedThreadId = uiState.selectedThreadId;
}
render();
syncComposerLayout();
transport.connect();
