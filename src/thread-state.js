export function mergeContentArrays(previous = [], incoming = []) {
  const maxLength = Math.max(previous.length, incoming.length);
  const merged = [];

  for (let index = 0; index < maxLength; index += 1) {
    const prevValue = previous[index];
    const nextValue = incoming[index];

    if (nextValue && typeof nextValue === "object" && !Array.isArray(nextValue)) {
      merged[index] = {
        ...(prevValue && typeof prevValue === "object" ? prevValue : {}),
        ...nextValue,
      };
      continue;
    }

    merged[index] = nextValue ?? prevValue;
  }

  return merged;
}

export function mergeFileChanges(previous = [], incoming = []) {
  if (!previous.length) {
    return [...incoming];
  }
  if (!incoming.length) {
    return [...previous];
  }

  const merged = [];
  const maxLength = Math.max(previous.length, incoming.length);
  for (let index = 0; index < maxLength; index += 1) {
    const prevChange = previous[index];
    const nextChange = incoming[index];

    if (!prevChange) {
      merged.push(nextChange);
      continue;
    }

    if (!nextChange) {
      merged.push(prevChange);
      continue;
    }

    merged.push({
      ...prevChange,
      ...nextChange,
      diff: nextChange.diff || prevChange.diff || "",
      kind: nextChange.kind || prevChange.kind,
      path: nextChange.path || prevChange.path || "",
    });
  }

  return merged;
}

export function mergeTurnItem(previous, incoming) {
  if (!previous) {
    return incoming;
  }

  const merged = {
    ...previous,
    ...incoming,
  };

  if (incoming.type === "agentMessage" || previous.type === "agentMessage") {
    merged.content = mergeContentArrays(previous.content || [], incoming.content || []);
    merged.text = incoming.text || previous.text || "";
  }

  if (incoming.type === "userMessage" || previous.type === "userMessage") {
    merged.content = mergeContentArrays(previous.content || [], incoming.content || []);
  }

  if (incoming.type === "commandExecution" || previous.type === "commandExecution") {
    merged.command = incoming.command || previous.command || "";
    merged.aggregatedOutput = incoming.aggregatedOutput || previous.aggregatedOutput || "";
    merged.commandActions = incoming.commandActions || previous.commandActions || [];
    merged.cwd = incoming.cwd || previous.cwd || "";
  }

  if (incoming.type === "fileChange" || previous.type === "fileChange") {
    merged.changes = mergeFileChanges(previous.changes || [], incoming.changes || []);
  }

  if (incoming.type === "reasoning" || previous.type === "reasoning") {
    merged.content = mergeContentArrays(previous.content || [], incoming.content || []);
    merged.summary = mergeContentArrays(previous.summary || [], incoming.summary || []);
  }

  return merged;
}

export function reconcileOptimisticUserItems(items = []) {
  if (!Array.isArray(items) || !items.length) {
    return [];
  }

  const hasRealUserMessage = items.some(
    (item) => item.type === "userMessage" && !String(item.id).startsWith("local-user-"),
  );

  if (!hasRealUserMessage) {
    return [...items];
  }

  return items.filter(
    (item) => item.type !== "userMessage" || !String(item.id).startsWith("local-user-"),
  );
}

export function createThreadStateHelpers({
  getLiveThreadEntries,
  messagesFromThreadItem,
  normalizeStatus,
  saveRuntimeState,
  state,
  textFromAgentItem,
  textFromUserItem,
  normalizeMessageText,
  assistantPhaseGroup,
}) {
  function turnItemDeduplicationKey(item) {
    const [message] = messagesFromThreadItem(item);
    const text = normalizeMessageText(
      message?.kind === "terminal" ? (message.output || message.text || "") : (message?.text || ""),
    );

    if (!message || !text) {
      return null;
    }

    return [
      item.type || "unknown",
      assistantPhaseGroup(item.phase),
      message.kind || "text",
      message.meta || "",
      message.role || "",
      text,
    ].join("::");
  }

  function mergeTurnItems(previousItems = [], incomingItems = []) {
    const merged = [...previousItems];

    for (const incomingItem of incomingItems || []) {
      const sameIdIndex = merged.findIndex((item) => item.id === incomingItem.id);
      if (sameIdIndex >= 0) {
        merged[sameIdIndex] = mergeTurnItem(merged[sameIdIndex], incomingItem);
        continue;
      }

      const deduplicationKey = turnItemDeduplicationKey(incomingItem);
      const duplicateIndex = deduplicationKey
        ? merged.findIndex((item) => turnItemDeduplicationKey(item) === deduplicationKey)
        : -1;

      if (duplicateIndex >= 0) {
        merged[duplicateIndex] = {
          ...mergeTurnItem(merged[duplicateIndex], incomingItem),
          id: incomingItem.id,
        };
        continue;
      }

      merged.push(incomingItem);
    }

    return merged;
  }

  function mergeTurns(existingTurns = [], incomingTurns = []) {
    const merged = new Map();

    for (const turn of existingTurns || []) {
      merged.set(turn.id, {
        ...turn,
        items: reconcileOptimisticUserItems(turn.items || []),
      });
    }

    for (const turn of incomingTurns || []) {
      const previous = merged.get(turn.id);
      if (!previous) {
        merged.set(turn.id, {
          ...turn,
          items: reconcileOptimisticUserItems(turn.items || []),
        });
        continue;
      }

      merged.set(turn.id, {
        ...previous,
        ...turn,
        items: reconcileOptimisticUserItems(mergeTurnItems(previous.items || [], turn.items || [])),
      });
    }

    return [...merged.values()];
  }

  function reconcileOptimisticTurnId(thread, actualTurnId) {
    const turns = thread?.turns;
    if (!Array.isArray(turns) || !actualTurnId) {
      return false;
    }

    const optimisticIndex = turns.findIndex((turn) => String(turn.id).startsWith("pending-"));
    if (optimisticIndex < 0) {
      return false;
    }

    const optimisticTurn = turns[optimisticIndex];
    const remappedItems = (optimisticTurn.items || []).map((item) =>
      item.type === "userMessage" && String(item.id).startsWith("local-user-")
        ? { ...item, id: `local-user-${actualTurnId}` }
        : item,
    );

    const existingIndex = turns.findIndex(
      (turn, index) => index !== optimisticIndex && turn.id === actualTurnId,
    );

    if (existingIndex >= 0) {
      const existingTurn = turns[existingIndex];
      const items = new Map();

      for (const item of remappedItems) {
        items.set(item.id, item);
      }
      for (const item of existingTurn.items || []) {
        items.set(item.id, mergeTurnItem(items.get(item.id), item));
      }

      turns[existingIndex] = {
        ...optimisticTurn,
        ...existingTurn,
        id: actualTurnId,
        items: reconcileOptimisticUserItems([...items.values()]),
      };
      turns.splice(optimisticIndex, 1);
      return true;
    }

    turns[optimisticIndex] = {
      ...optimisticTurn,
      id: actualTurnId,
      items: reconcileOptimisticUserItems(remappedItems),
    };
    return true;
  }

  function threadTurnById(thread, turnId) {
    return thread?.turns?.find((turn) => turn.id === turnId) || null;
  }

  function threadItemById(thread, itemId) {
    for (const turn of thread?.turns || []) {
      const match = (turn.items || []).find((item) => item.id === itemId);
      if (match) {
        return match;
      }
    }

    return null;
  }

  function hasFinalTurnMessage(thread, turnId) {
    const turn = thread?.turns?.find((entry) => entry.id === turnId);
    if (!turn?.items?.length) {
      return false;
    }

    return turn.items.some((item) =>
      item.type === "agentMessage" && item.phase !== "commentary" && textFromAgentItem(item).trim(),
    );
  }

  function getRenderableTurnItems(turn, realUserTexts = null, realAssistantSignatures = null) {
    const items = [...(turn?.items || [])];
    const realMessagesInTurn = items.filter(
      (item) => item.type === "userMessage" && !String(item.id).startsWith("local-user-"),
    );
    const knownRealUserTexts = realUserTexts || new Set(
      realMessagesInTurn.map((item) => textFromUserItem(item).trim()).filter(Boolean),
    );
    const realAgentMessagesInTurn = items.filter(
      (item) => item.type === "agentMessage" && !String(item.id).startsWith("raw-response-"),
    );
    const knownRealAssistantSignatures = realAssistantSignatures || new Set(
      realAgentMessagesInTurn
        .map((item) => `${item.phase || "unknown"}::${textFromAgentItem(item).trim()}`)
        .filter((value) => !value.endsWith("::")),
    );

    if (!knownRealUserTexts.size && !knownRealAssistantSignatures.size) {
      return items;
    }

    return items.filter((item) => {
      if (item.type === "userMessage" && String(item.id).startsWith("local-user-")) {
        const optimisticText = textFromUserItem(item).trim();
        return !knownRealUserTexts.has(optimisticText);
      }

      if (item.type === "agentMessage" && String(item.id).startsWith("raw-response-")) {
        const signature = `${item.phase || "unknown"}::${textFromAgentItem(item).trim()}`;
        return !knownRealAssistantSignatures.has(signature);
      }

      return true;
    });
  }

  function finalAssistantFallbackKey(threadId, turnId) {
    return `${threadId}:${turnId}`;
  }

  function getFinalAssistantFallback(threadId, turnId) {
    if (!threadId || !turnId) {
      return null;
    }
    return state.finalAssistantFallbacks.get(finalAssistantFallbackKey(threadId, turnId)) || null;
  }

  function setFinalAssistantFallback(threadId, turnId, fallback) {
    if (!threadId || !turnId || !fallback?.id || !normalizeMessageText(fallback.text)) {
      return;
    }

    state.finalAssistantFallbacks.set(finalAssistantFallbackKey(threadId, turnId), {
      id: fallback.id,
      text: fallback.text,
    });
    saveRuntimeState();
  }

  function clearFinalAssistantFallback(threadId, turnId) {
    if (!threadId || !turnId) {
      return;
    }

    state.finalAssistantFallbacks.delete(finalAssistantFallbackKey(threadId, turnId));
    saveRuntimeState();
  }

  function clearResolvedFinalAssistantFallbacks(thread) {
    if (!thread?.id) {
      return;
    }

    for (const turn of thread.turns || []) {
      if (hasFinalTurnMessage(thread, turn.id)) {
        clearFinalAssistantFallback(thread.id, turn.id);
      }
    }
    saveRuntimeState();
  }

  function messagesFromLiveEntry(entry) {
    const pending = state.pendingLiveItems.get(entry?.item?.id);
    return messagesFromThreadItem(entry?.item).map((message) => ({
      ...message,
      meta: pending?.meta || message.meta,
      pending: pending?.pending ?? entry?.item?.status === "inProgress",
      role: pending?.role || message.role,
    }));
  }

  function flattenMessages(thread) {
    const output = [];
    const seenIds = new Set();
    const threadIsActive = normalizeStatus(thread?.status) === "active";
    const liveEntries = getLiveThreadEntries(thread?.id);
    const liveEntriesByTurn = new Map();
    const realUserTexts = new Set(
      (thread?.turns || [])
        .flatMap((turn) => turn.items || [])
        .filter((item) => item.type === "userMessage" && !String(item.id).startsWith("local-user-"))
        .map((item) => textFromUserItem(item).trim())
        .filter(Boolean),
    );
    const realAssistantSignatures = new Set(
      (thread?.turns || [])
        .flatMap((turn) => turn.items || [])
        .filter((item) => item.type === "agentMessage" && !String(item.id).startsWith("raw-response-"))
        .map((item) => `${item.phase || "unknown"}::${textFromAgentItem(item).trim()}`)
        .filter((value) => !value.endsWith("::")),
    );

    for (const entry of liveEntries) {
      const key = entry.turnId || "__unscoped__";
      const bucket = liveEntriesByTurn.get(key) || [];
      bucket.push(entry);
      liveEntriesByTurn.set(key, bucket);
    }

    for (const turn of thread?.turns || []) {
      const turnItems = getRenderableTurnItems(turn, realUserTexts, realAssistantSignatures);
      const nonFinalItems = turnItems.filter(
        (item) => item.type !== "agentMessage" || item.phase === "commentary",
      );
      const finalItems = turnItems.filter(
        (item) => item.type === "agentMessage" && item.phase !== "commentary",
      );
      const hasRenderableFinalItem = finalItems.some((item) => normalizeMessageText(textFromAgentItem(item)));

      for (const item of nonFinalItems) {
        for (const message of messagesFromThreadItem(item)) {
          output.push(message);
          seenIds.add(message.id);
        }
      }

      for (const entry of liveEntriesByTurn.get(turn.id) || []) {
        for (const message of messagesFromLiveEntry(entry)) {
          if (seenIds.has(message.id)) {
            continue;
          }
          output.push(message);
          seenIds.add(message.id);
        }
      }

      for (const item of finalItems) {
        for (const message of messagesFromThreadItem(item)) {
          output.push(message);
          seenIds.add(message.id);
        }
      }

      const finalFallback = getFinalAssistantFallback(thread?.id, turn.id);
      if (!hasRenderableFinalItem && finalFallback && !seenIds.has(finalFallback.id)) {
        output.push({
          id: finalFallback.id,
          meta: "Codex",
          role: "assistant",
          text: finalFallback.text,
        });
        seenIds.add(finalFallback.id);
      }
    }

    for (const entry of liveEntriesByTurn.get("__unscoped__") || []) {
      for (const message of messagesFromLiveEntry(entry)) {
        if (seenIds.has(message.id)) {
          continue;
        }
        output.push(message);
        seenIds.add(message.id);
      }
    }

    for (const entry of liveEntries) {
      for (const message of messagesFromLiveEntry(entry)) {
        if (seenIds.has(message.id)) {
          continue;
        }
        output.push(message);
        seenIds.add(message.id);
      }
    }

    for (const [itemId, pending] of state.pendingAssistantMessages) {
      if (pending.threadId !== thread?.id || seenIds.has(itemId)) {
        continue;
      }

      output.push({
        id: itemId,
        meta: "Codex is typing",
        pending: true,
        role: "assistant",
        text: pending.text || "",
      });
    }

    for (const [itemId, pending] of state.pendingLiveItems) {
      if (pending.threadId !== thread?.id || seenIds.has(itemId)) {
        continue;
      }

      output.push({
        id: itemId,
        meta: pending.meta,
        pending: pending.pending,
        role: pending.role,
        text: pending.text || "",
      });
    }

    const hasPendingForThread = Array.from(state.pendingAssistantMessages.values()).some(
      (pending) => pending.threadId === thread?.id,
    );

    const hasPendingLiveForThread = Array.from(state.pendingLiveItems.values()).some(
      (pending) => pending.threadId === thread?.id,
    );

    if (state.activeTurnId && threadIsActive && state.selectedThreadId === thread?.id && !hasPendingForThread && !hasPendingLiveForThread) {
      output.push({
        id: `thinking-${state.activeTurnId}`,
        meta: "Codex",
        pending: true,
        role: "commentary",
        text: state.threadActivities.get(thread?.id) || "Thinking",
        thinking: true,
      });
    }

    return output;
  }

  function hasRealFileChangeForTurn(threadId, turnId) {
    if (!threadId || !turnId) {
      return false;
    }

    const syntheticId = `diff-${turnId}`;
    const turn = threadTurnById(state.selectedThreadId === threadId ? state.selectedThread : null, turnId);
    if ((turn?.items || []).some((item) => item.type === "fileChange" && item.id !== syntheticId)) {
      return true;
    }

    return getLiveThreadEntries(threadId).some((entry) =>
      entry.turnId === turnId
      && entry.item?.type === "fileChange"
      && entry.item?.id !== syntheticId,
    );
  }

  function findAssistantMessageTarget(threadId, turnId, phase, text) {
    const turn = threadTurnById(state.selectedThreadId === threadId ? state.selectedThread : null, turnId);
    const phaseGroup = assistantPhaseGroup(phase);
    const normalizedText = normalizeMessageText(text);
    const assistantItems = (turn?.items || []).filter((item) =>
      item.type === "agentMessage"
      && !String(item.id).startsWith("raw-response-")
      && assistantPhaseGroup(item.phase) === phaseGroup,
    );

    const exactItem = assistantItems.find((item) =>
      normalizeMessageText(textFromAgentItem(item)) === normalizedText,
    );
    if (exactItem) {
      return { exact: true, itemId: exactItem.id };
    }

    const emptyItem = assistantItems.find((item) => !normalizeMessageText(textFromAgentItem(item)));
    if (emptyItem) {
      return { exact: false, itemId: emptyItem.id };
    }

    const pendingEntries = Array.from(state.pendingAssistantMessages.entries()).filter(([, pending]) =>
      pending.threadId === threadId && pending.turnId === turnId,
    );
    const exactPending = pendingEntries.find(([, pending]) =>
      normalizeMessageText(pending.text) === normalizedText,
    );
    if (exactPending) {
      return { exact: false, itemId: exactPending[0] };
    }

    if (pendingEntries.length === 1) {
      return { exact: false, itemId: pendingEntries[0][0] };
    }

    return null;
  }

  function pendingAssistantEntriesForTurn(threadId, turnId) {
    return Array.from(state.pendingAssistantMessages.entries()).filter(([, pending]) =>
      pending.threadId === threadId && pending.turnId === turnId && normalizeMessageText(pending.text),
    );
  }

  return {
    clearFinalAssistantFallback,
    clearResolvedFinalAssistantFallbacks,
    findAssistantMessageTarget,
    flattenMessages,
    getFinalAssistantFallback,
    hasFinalTurnMessage,
    hasRealFileChangeForTurn,
    mergeTurns,
    mergeTurnItem,
    pendingAssistantEntriesForTurn,
    reconcileOptimisticTurnId,
    reconcileOptimisticUserItems,
    setFinalAssistantFallback,
    threadItemById,
    threadTurnById,
  };
}
