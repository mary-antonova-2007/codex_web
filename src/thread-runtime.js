export function createThreadRuntimeHelpers({
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
}) {
  function clearPendingStateForThread(threadId) {
    for (const [itemId, pending] of state.pendingAssistantMessages) {
      if (pending.threadId !== threadId) {
        continue;
      }

      state.pendingAssistantMessages.delete(itemId);
      cleanupStreamState(itemId);
      removeMessageElement(itemId);
    }

    for (const [itemId, pending] of state.pendingLiveItems) {
      if (pending.threadId !== threadId) {
        continue;
      }

      state.pendingLiveItems.delete(itemId);
      cleanupStreamState(itemId);
      removeMessageElement(itemId);
    }
  }

  function finalizePendingAssistantForTurn(threadId, turnId) {
    const candidates = Array.from(state.pendingAssistantMessages.entries())
      .filter(([, pending]) =>
        pending.threadId === threadId && pending.turnId === turnId && String(pending.text || "").trim(),
      )
      .sort((left, right) =>
        (right[1].updatedAt || 0) - (left[1].updatedAt || 0)
        || right[1].text.length - left[1].text.length,
      );

    if (!candidates.length) {
      return false;
    }

    const [itemId, pending] = candidates[0];
    state.pendingAssistantMessages.delete(itemId);
    cleanupStreamState(itemId);
    setFinalAssistantFallback(threadId, turnId, {
      id: itemId,
      text: pending.text,
    });
    return true;
  }

  function removeThreadTurnItem(threadId, turnId, itemId) {
    if (state.selectedThread?.id !== threadId) {
      return false;
    }

    const turn = threadTurnById(state.selectedThread, turnId);
    if (!turn?.items?.length) {
      return false;
    }

    const nextItems = turn.items.filter((item) => item.id !== itemId);
    if (nextItems.length === turn.items.length) {
      return false;
    }

    turn.items = nextItems;
    return true;
  }

  function removeLiveThreadItem(threadId, itemId) {
    const entries = state.liveThreadItems.get(threadId) || [];
    if (!entries.length) {
      return false;
    }

    const nextEntries = entries.filter((entry) => entry.item?.id !== itemId);
    if (nextEntries.length === entries.length) {
      return false;
    }

    if (nextEntries.length) {
      state.liveThreadItems.set(threadId, nextEntries);
    } else {
      state.liveThreadItems.delete(threadId);
    }
    return true;
  }

  function discardRenderedItem(threadId, turnId, itemId) {
    removeThreadTurnItem(threadId, turnId, itemId);
    removeLiveThreadItem(threadId, itemId);
    state.pendingAssistantMessages.delete(itemId);
    state.pendingLiveItems.delete(itemId);
    cleanupStreamState(itemId);
    removeMessageElement(itemId);
  }

  function discardSyntheticItemsForCompletedItem(threadId, turnId, item) {
    if (!item?.id) {
      return;
    }

    if (item.type === "plan") {
      const syntheticId = `plan-${turnId}`;
      if (item.id !== syntheticId) {
        discardRenderedItem(threadId, turnId, syntheticId);
      }
      return;
    }

    if (item.type === "fileChange") {
      const syntheticId = `diff-${turnId}`;
      if (item.id !== syntheticId) {
        discardRenderedItem(threadId, turnId, syntheticId);
      }
      return;
    }

    if (item.type !== "agentMessage" || String(item.id).startsWith("raw-response-")) {
      return;
    }

    const turn = threadTurnById(state.selectedThreadId === threadId ? state.selectedThread : null, turnId);
    const targetText = String(textFromAgentItem(item) || "").replaceAll("\r\n", "\n").trim();
    const targetPhase = item.phase === "commentary" ? "commentary" : "final";

    for (const turnItem of turn?.items || []) {
      if (turnItem.type !== "agentMessage" || turnItem.id === item.id) {
        continue;
      }

      if ((turnItem.phase === "commentary" ? "commentary" : "final") !== targetPhase) {
        continue;
      }

      if (String(textFromAgentItem(turnItem) || "").replaceAll("\r\n", "\n").trim() !== targetText) {
        continue;
      }

      discardRenderedItem(threadId, turnId, turnItem.id);
    }
  }

  function clearReconciledPendingStateForThread(thread) {
    if (!thread?.id) {
      return;
    }

    for (const [itemId, pending] of state.pendingAssistantMessages) {
      if (pending.threadId !== thread.id) {
        continue;
      }

      const actualItem = threadItemById(thread, itemId);
      const actualText = actualItem?.type === "agentMessage" ? textFromAgentItem(actualItem).trim() : "";
      if (!actualItem || !actualText) {
        continue;
      }

      state.pendingAssistantMessages.delete(itemId);
      if (!state.streamRenderState.has(itemId)) {
        removeMessageElement(itemId);
      }
    }

    for (const [itemId, pending] of state.pendingLiveItems) {
      if (pending.threadId !== thread.id) {
        continue;
      }

      const actualItem = threadItemById(thread, itemId);
      if (!actualItem) {
        continue;
      }

      const isComplete =
        actualItem.status !== "inProgress" ||
        actualItem.type === "reasoning" ||
        actualItem.type === "plan" ||
        actualItem.type === "contextCompaction";

      if (!isComplete) {
        continue;
      }

      state.pendingLiveItems.delete(itemId);
      cleanupStreamState(itemId);
      removeMessageElement(itemId);
    }
  }

  function reconcileThreadActivity(thread, { clearPending = false } = {}) {
    if (!thread?.id || normalizeStatus(thread.status) === "active") {
      return;
    }

    state.threadActivities.delete(thread.id);

    if (clearPending) {
      clearReconciledPendingStateForThread(thread);
    }

    if (state.selectedThreadId === thread.id && state.activeTurnId) {
      state.activeTurnId = null;
      stopActiveThreadSync();
      renderComposerState(state);
    }
  }

  function scheduleStreamRender(messageId, autoScrollPinned) {
    const stream = state.streamRenderState.get(messageId);
    if (!stream) {
      stopStreamRender(messageId);
      return;
    }

    stream.displayedText = stream.targetText || "";

    const renderedMessage = stream.renderedMessage
      ? {
          ...stream.renderedMessage,
          id: messageId,
          meta: stream.meta,
          pending: stream.pending,
          role: stream.role,
        }
      : {
          id: messageId,
          meta: stream.meta,
          pending: stream.pending,
          role: stream.role,
          text: stream.displayedText,
        };

    if (renderedMessage.kind === "terminal") {
      renderedMessage.output = stream.displayedText || renderedMessage.output || renderedMessage.text || "";
      renderedMessage.text = renderedMessage.output;
    } else {
      renderedMessage.text = stream.displayedText || renderedMessage.text || "";
    }

    upsertMessageElement(renderedMessage, Boolean(state.selectedThread));

    if (autoScrollPinned) {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    }
    updateScrollButton();

    stopStreamRender(messageId);
    if (!stream.pending) {
      state.streamRenderState.delete(messageId);
    }
  }

  function renderMessages(autoScrollPinned) {
    const previousBottomDistance =
      elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight;
    const hasPendingStream = Array.from(state.pendingAssistantMessages.values()).some(
      (pending) => pending.threadId === state.selectedThreadId,
    );
    const hasLocalStream = state.streamRenderState.size > 0;
    const isActiveThread = normalizeStatus(state.selectedThread?.status) === "active";

    if (!state.selectedThread) {
      renderEmptyMessagesState("Open a chat or start a new one.");
      return;
    }

    const messages = flattenMessages(state.selectedThread);
    if (!messages.length) {
      if (isActiveThread || hasPendingStream || hasLocalStream) {
        updateScrollButton();
        return;
      }

      renderEmptyMessagesState("This chat is empty. Write the first prompt below.");
      return;
    }

    const emptyState = elements.messages.querySelector(".messages-empty");
    if (emptyState) {
      emptyState.remove();
    }

    syncRenderedMessages(messages, Boolean(state.selectedThread));

    if (autoScrollPinned) {
      scrollMessagesToBottom(true);
    } else {
      elements.messages.scrollTop = Math.max(
        0,
        elements.messages.scrollHeight - elements.messages.clientHeight - previousBottomDistance,
      );
      updateScrollButton();
    }
  }

  function upsertThreadTurnItem(threadId, turnId, item, turnStatus = "inProgress") {
    if (state.selectedThread?.id !== threadId) {
      return;
    }

    if (!Array.isArray(state.selectedThread.turns)) {
      state.selectedThread.turns = [];
    }

    let turn = state.selectedThread.turns.find((entry) => entry.id === turnId);
    if (!turn) {
      turn = { id: turnId, items: [], status: turnStatus };
      state.selectedThread.turns.push(turn);
    }

    if (!Array.isArray(turn.items)) {
      turn.items = [];
    }

    const existingIndex = turn.items.findIndex((entry) => entry.id === item.id);
    if (existingIndex >= 0) {
      turn.items[existingIndex] = item;
    } else {
      turn.items.push(item);
    }

    turn.items = reconcileOptimisticUserItems(turn.items);
  }

  function appendOptimisticUserMessage(threadId, turnId, text) {
    upsertThreadTurnItem(
      threadId,
      turnId,
      {
        content: [{ text, type: "text" }],
        id: `local-user-${turnId}`,
        type: "userMessage",
      },
      "inProgress",
    );

    if (state.selectedThreadId === threadId) {
      upsertMessageElement({
        id: `local-user-${turnId}`,
        meta: "You",
        role: "user",
        text,
      }, true);
      scrollMessagesToBottom(true);
    }
  }

  function findSelectedThreadTurnItem(turnId, itemId) {
    const turn = state.selectedThread?.turns?.find((entry) => entry.id === turnId);
    if (!turn?.items) {
      return null;
    }
    return turn.items.find((entry) => entry.id === itemId) || null;
  }

  function upsertSelectedThreadTurnItem(threadId, turnId, itemFactory, mutator) {
    if (state.selectedThreadId !== threadId) {
      return null;
    }

    const initialItem = itemFactory();
    let item = findSelectedThreadTurnItem(turnId, initialItem.id);
    if (!item) {
      item = initialItem;
      upsertThreadTurnItem(threadId, turnId, item);
      item = findSelectedThreadTurnItem(turnId, item.id) || item;
    }

    mutator(item);
    upsertThreadTurnItem(threadId, turnId, item);
    return item;
  }

  function applyStreamingAssistantDelta({ itemId, threadId, turnId, delta }, autoScrollPinned) {
    const current = state.pendingAssistantMessages.get(itemId) || {
      text: "",
      threadId,
      turnId,
      updatedAt: 0,
    };
    current.text += delta;
    current.updatedAt = Date.now();
    state.pendingAssistantMessages.set(itemId, current);

    if (state.selectedThreadId === threadId) {
      const stream = state.streamRenderState.get(itemId) || {
        displayedText: "",
        meta: "Codex is typing",
        pending: true,
        renderedMessage: null,
        role: "assistant",
        targetText: "",
      };
      stream.targetText = current.text;
      stream.pending = true;
      state.streamRenderState.set(itemId, stream);

      upsertMessageElement({
        id: itemId,
        meta: stream.meta,
        pending: true,
        role: stream.role,
        text: stream.displayedText,
      }, true);
      scheduleStreamRender(itemId, autoScrollPinned);
    }
  }

  function applyStreamingLiveItemDelta({ itemId, threadId, turnId, delta, factory, mutate, meta, role = "commentary" }, autoScrollPinned) {
    const item = upsertSelectedThreadTurnItem(threadId, turnId, factory, mutate);
    let liveItem = item;
    if (!liveItem) {
      const entries = state.liveThreadItems.get(threadId) || [];
      const previousLiveItem = entries.find((entry) => entry.item?.id === itemId)?.item || null;
      liveItem = mergeTurnItem(previousLiveItem, factory());
      mutate(liveItem);
    }
    upsertLiveThreadItem(threadId, turnId, liveItem);
    setThreadActivityFromItem(threadId, liveItem);

    const pending = state.pendingLiveItems.get(itemId) || {
      meta,
      pending: true,
      role,
      text: "",
      threadId,
      turnId,
    };
    pending.meta = meta;
    pending.pending = true;
    pending.role = role;
    pending.text += delta;
    pending.threadId = threadId;
    pending.turnId = turnId;
    state.pendingLiveItems.set(itemId, pending);

    if (state.selectedThreadId === threadId) {
      const stream = state.streamRenderState.get(itemId) || {
        displayedText: "",
        meta,
        pending: true,
        renderedMessage: null,
        role,
        targetText: "",
      };

      const messages = messagesFromThreadItem(liveItem);
      const renderedMessage = messages[0]
        ? {
            ...messages[0],
            meta,
            pending: true,
            role,
          }
        : null;
      stream.meta = meta;
      stream.pending = true;
      stream.renderedMessage = renderedMessage;
      stream.role = role;
      stream.targetText =
        renderedMessage?.kind === "terminal"
          ? (renderedMessage.output || renderedMessage.text || pending.text)
          : (renderedMessage?.text || pending.text);
      state.streamRenderState.set(itemId, stream);
      scheduleStreamRender(itemId, autoScrollPinned);
    }
  }

  function applyStartedItem({ item, threadId, turnId }, autoScrollPinned) {
    if (item.type === "plan") {
      const syntheticId = `plan-${turnId}`;
      if (item.id !== syntheticId) {
        discardRenderedItem(threadId, turnId, syntheticId);
      }
    }

    if (item.type === "fileChange") {
      const syntheticId = `diff-${turnId}`;
      if (item.id !== syntheticId) {
        discardRenderedItem(threadId, turnId, syntheticId);
      }
    }

    upsertLiveThreadItem(threadId, turnId, item);
    setThreadActivityFromItem(threadId, item);
    upsertThreadTurnItem(threadId, turnId, item);

    if (state.selectedThreadId !== threadId) {
      return;
    }

    for (const message of messagesFromThreadItem(item)) {
      upsertMessageElement({
        ...message,
        pending: item.status === "inProgress",
      }, true);
    }

    renderMessages(autoScrollPinned);
  }

  function applyCompletedItem({ item, threadId, turnId }, autoScrollPinned) {
    if (item.type === "agentMessage" && item.phase !== "commentary") {
      clearFinalAssistantFallback(threadId, turnId);
    }

    discardSyntheticItemsForCompletedItem(threadId, turnId, item);
    upsertLiveThreadItem(threadId, turnId, item);
    upsertThreadTurnItem(threadId, turnId, item);

    if (item.type === "agentMessage") {
      removePendingAssistantMessage(item.id);
    } else {
      removePendingLiveItem(item.id);
      cleanupStreamState(item.id);
      if (normalizeStatus(state.selectedThread?.status) === "active") {
        setThreadActivityFromItem(threadId, item);
      }
    }

    if (state.selectedThreadId === threadId) {
      if (item.type === "agentMessage") {
        const completedText = textFromAgentItem(item);
        const existing = state.streamRenderState.get(item.id) || {
          displayedText: "",
          meta: item.phase === "commentary" ? "Codex commentary" : "Codex",
          pending: false,
          renderedMessage: null,
          role: item.phase === "commentary" ? "commentary" : "assistant",
          targetText: "",
        };

        existing.meta = item.phase === "commentary" ? "Codex commentary" : "Codex";
        existing.role = item.phase === "commentary" ? "commentary" : "assistant";
        existing.pending = false;
        existing.renderedMessage = null;
        existing.targetText = completedText || existing.targetText || "";
        state.streamRenderState.set(item.id, existing);
        scheduleStreamRender(item.id, autoScrollPinned);
        return;
      }

      for (const message of messagesFromThreadItem(item)) {
        upsertMessageElement({
          ...message,
          pending: false,
        }, true);
      }
      renderMessages(autoScrollPinned);
    }
  }

  function applyRawResponseItemCompleted({ item, threadId, turnId }, autoScrollPinned) {
    if (!item || item.type !== "message" || item.role !== "assistant") {
      return;
    }

    const text = textFromRawResponseMessage(item).trim();
    if (!text) {
      return;
    }

    const phase = item.phase || (item.end_turn ? "final_answer" : null);
    const target = findAssistantMessageTarget(threadId, turnId, phase, text);
    if (target?.exact) {
      clearFinalAssistantFallback(threadId, turnId);
      clearPendingAssistantMessagesForTurn(threadId, turnId, text);
      if (state.selectedThreadId === threadId) {
        renderMessages(autoScrollPinned);
      }
      return;
    }

    const syntheticItem = {
      id: target?.itemId || `raw-response-${phase || "message"}-${turnId}`,
      phase,
      text,
      type: "agentMessage",
    };

    applyCompletedItem({
      item: syntheticItem,
      threadId,
      turnId,
    }, autoScrollPinned);
  }

  return {
    appendOptimisticUserMessage,
    applyCompletedItem,
    applyRawResponseItemCompleted,
    applyStartedItem,
    applyStreamingAssistantDelta,
    applyStreamingLiveItemDelta,
    clearPendingStateForThread,
    clearReconciledPendingStateForThread,
    discardRenderedItem,
    discardSyntheticItemsForCompletedItem,
    finalizePendingAssistantForTurn,
    reconcileThreadActivity,
    renderMessages,
    scheduleStreamRender,
    upsertThreadTurnItem,
  };
}
