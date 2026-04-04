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
  function renderScreens(state) {
    elements.listScreen.classList.toggle("active", state.view === "list");
    elements.chatScreen.classList.toggle("active", state.view === "chat");
    elements.settingsScreen.classList.toggle("active", state.view === "settings");
  }

  function syncComposerInteractivity(state) {
    const disabled = !state.connected;
    elements.sendButton.disabled = disabled;
    elements.promptInput.disabled = disabled;
  }

  function renderComposerState(state) {
    syncComposerInteractivity(state);
    const isBusy = Boolean(state.activeTurnId);
    const isEmpty = !elements.promptInput.value.trim();
    elements.sendButton.classList.toggle("button-spinner", isBusy && isEmpty);
    elements.sendButton.innerHTML = isBusy && isEmpty ? `<span class="spinner"></span>` : "Send";
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
    elements.sendButton.disabled = disabled;
    elements.promptInput.disabled = disabled;
    elements.composerHint.textContent = disabled
      ? "Wait for Codex connection"
      : "Shift+Enter for newline";
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
    elements.chatMenuButton.textContent = state.chatMenuOpen ? "×" : "☰";
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
