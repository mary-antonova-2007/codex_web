export function createUiRenderer({
  elements,
  escapeHtml,
  extractRateLimitCards,
  formatPlan,
  formatTimestamp,
  getThreadLabel,
  getThreadSubtitle,
  normalizeStatus,
}) {
  function renderComposerButtonContent(mode) {
    if (mode === "stop") {
      return `
        <span class="button-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <rect x="7" y="7" width="10" height="10" rx="2"></rect>
          </svg>
        </span>
      `;
    }

    if (mode === "queue") {
      return `
        <span class="button-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M5 12h9"></path>
            <path d="M11 8l4 4-4 4"></path>
            <path d="M15 6h4v4"></path>
          </svg>
        </span>
        <span class="button-label">Queue</span>
      `;
    }

    return `
      <span class="button-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M5 12h10"></path>
          <path d="M11 6l6 6-6 6"></path>
        </svg>
      </span>
      <span class="button-label">Send</span>
    `;
  }

  function renderScreens(state) {
    elements.listScreen.classList.toggle("active", state.view === "list");
    elements.chatScreen.classList.toggle("active", state.view === "chat");
    elements.settingsScreen.classList.toggle("active", state.view === "settings");
  }

  function syncComposerInteractivity(state) {
    const disabled = !state.connected;
    elements.attachButton.disabled = disabled;
    elements.sendButton.disabled = disabled;
    elements.promptInput.disabled = disabled;
  }

  function renderComposerState(state) {
    syncComposerInteractivity(state);
    const isBusy = Boolean(state.activeTurnId);
    const attachmentCount = Array.isArray(state.composerAttachments) ? state.composerAttachments.length : 0;
    const isEmpty = !elements.promptInput.value.trim() && attachmentCount === 0;
    const queuedCount = Array.isArray(state.queuedPrompts) ? state.queuedPrompts.length : 0;
    const mode = isBusy && isEmpty ? "stop" : isBusy ? "queue" : "send";

    elements.sendButton.classList.toggle("button-stop", mode === "stop");
    elements.sendButton.classList.toggle("button-queue", mode === "queue");
    elements.sendButton.classList.remove("button-spinner");
    elements.sendButton.innerHTML = renderComposerButtonContent(mode);
    elements.sendButton.setAttribute(
      "aria-label",
      mode === "stop" ? "Stop current turn" : mode === "queue" ? "Queue next prompt" : "Send prompt",
    );
    elements.composerHint.textContent = !state.connected
      ? "Wait for Codex connection"
      : mode === "stop"
        ? queuedCount
          ? `Stop current turn • ${queuedCount} queued`
          : "Stop current turn"
        : mode === "queue"
          ? queuedCount
            ? `${queuedCount} queued`
            : "Send queues the next turn"
          : "Shift+Enter for newline";
  }

  function renderConnection(state) {
    const statusText = state.connected
      ? "Connected"
      : state.connecting
        ? "Connecting"
        : "Disconnected";
    elements.connectionStatus.textContent = statusText;
    elements.connectionStatus.classList.toggle("pill-online", state.connected);

    const disabled = !state.connected;
    elements.attachButton.disabled = disabled;
    elements.sendButton.disabled = disabled;
    elements.promptInput.disabled = disabled;
    renderComposerState(state);
  }

  function renderAccount(state) {
    if (state.account?.type === "chatgpt") {
      elements.accountEmail.textContent = state.account.email;
      elements.accountPlan.textContent = formatPlan(state.account.planType);
      elements.chatUserName.textContent = state.account.email;
    } else if (state.account?.type === "apiKey") {
      elements.accountEmail.textContent = "API key account";
      elements.accountPlan.textContent = "api key";
      elements.chatUserName.textContent = "API key";
    } else {
      elements.accountEmail.textContent = "Not signed in";
      elements.accountPlan.textContent = "guest";
      elements.chatUserName.textContent = "Guest";
    }

    const limitCards = extractRateLimitCards(state.rateLimits);
    const html = limitCards.length
      ? limitCards
          .map(
            (card) => `
              <div class="limit-card">
                <strong>${escapeHtml(card.title)}</strong>
                <span>${card.remaining}% left</span>
                <small>${escapeHtml(card.resetsAt)}</small>
              </div>
            `,
          )
          .join("")
      : `
          <div class="limit-card limit-card-empty">
            <strong>Limits</strong>
            <span>No rate-limit data yet</span>
          </div>
        `;

    elements.accountLimits.innerHTML = html;
    elements.chatHeaderLimits.innerHTML = html;
    elements.authLink.classList.toggle("hidden", !elements.authLink.href || elements.authLink.href === "#");
  }

  function renderThreads(state) {
    const searchTerm = elements.search.value.trim().toLowerCase();
    const filteredThreads = state.threads.filter((thread) => {
      const haystack = `${getThreadLabel(thread)} ${getThreadSubtitle(thread)}`.toLowerCase();
      return haystack.includes(searchTerm);
    });

    if (!filteredThreads.length) {
      elements.threadList.innerHTML = `
        <div class="empty-card">
          <p>No chats found.</p>
        </div>
      `;
      return;
    }

    elements.threadList.innerHTML = filteredThreads
      .map((thread) => {
        const activeClass = thread.id === state.selectedThreadId ? " thread-card-active" : "";
        return `
          <button class="thread-card${activeClass}" data-thread-id="${thread.id}" type="button">
            <div class="thread-card-head">
              <strong>${escapeHtml(getThreadLabel(thread))}</strong>
              <span>${escapeHtml(normalizeStatus(thread.status))}</span>
            </div>
            <p>${escapeHtml(getThreadSubtitle(thread))}</p>
            <small>${escapeHtml(formatTimestamp(thread.updatedAt))}</small>
          </button>
        `;
      })
      .join("");
  }

  function renderHeader(state) {
    elements.threadTitle.textContent = state.selectedThread ? getThreadLabel(state.selectedThread) : "Codex";
    elements.chatMenuThreadTitle.textContent = state.selectedThread ? getThreadLabel(state.selectedThread) : "Codex";
    elements.threadStatus.textContent = state.selectedThread
      ? normalizeStatus(state.selectedThread.status)
      : "idle";
  }

  function renderChatMenu(state) {
    elements.chatMenuPanel.classList.toggle("hidden", !state.chatMenuOpen || state.view !== "chat");
    elements.chatMenuButton.setAttribute("aria-label", state.chatMenuOpen ? "Close chat menu" : "Open chat menu");
    elements.chatMenuButton.innerHTML = state.chatMenuOpen
      ? `
        <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path d="M8 8l8 8"></path>
          <path d="M16 8l-8 8"></path>
        </svg>
      `
      : `
        <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path d="M7 8h10"></path>
          <path d="M7 12h10"></path>
          <path d="M7 16h10"></path>
        </svg>
      `;
  }

  function renderSkills(state) {
    const skills = state.skills.flatMap((entry) => entry.skills || []).filter((skill) => skill.enabled);

    if (!skills.length) {
      elements.skillsList.innerHTML = `
        <div class="empty-card">
          <p>No installed skills found for this workspace.</p>
        </div>
      `;
      return;
    }

    elements.skillsList.innerHTML = skills
      .map((skill) => {
        const checked = state.settings.enabledSkills.includes(skill.path) ? "checked" : "";
        const description = skill.interface?.shortDescription || skill.shortDescription || skill.description || "";

        return `
          <label class="skill-row">
            <input class="skill-checkbox" type="checkbox" data-skill-path="${escapeHtml(skill.path)}" ${checked} />
            <div class="skill-copy">
              <strong>${escapeHtml(skill.name)}</strong>
              <small>${escapeHtml(description)}</small>
            </div>
          </label>
        `;
      })
      .join("");
  }

  function renderCatalog(state) {
    if (!state.curatedSkills.length) {
      elements.skillsCatalog.innerHTML = "";
      return;
    }

    const installed = new Set(
      state.skills.flatMap((entry) => entry.skills || []).map((skill) => skill.path.split("/").pop()),
    );

    elements.skillsCatalog.innerHTML = `
      <div class="catalog-copy">
        ${state.curatedSkills
          .slice(0, 18)
          .map((name) =>
            installed.has(name)
              ? `<span class="catalog-chip catalog-chip-installed">${escapeHtml(name)}</span>`
              : `<button class="catalog-chip" data-install-curated="${escapeHtml(name)}" type="button">${escapeHtml(name)}</button>`,
          )
          .join(" ")}
      </div>
    `;
  }

  return {
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
  };
}
