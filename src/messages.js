export function textFromUserItem(item) {
  if (!Array.isArray(item.content)) {
    return "";
  }

  return item.content
    .map((contentItem) => {
      if (contentItem.type === "text" || contentItem.type === "input_text") {
        return contentItem.text;
      }
      if (contentItem.type === "image" || contentItem.type === "input_image") {
        return `[image] ${contentItem.image_url}`;
      }
      if (contentItem.type === "local_image" || contentItem.type === "localImage") {
        return `[local image] ${contentItem.path || ""}`;
      }
      if (contentItem.type === "skill") {
        return `[skill] ${contentItem.name || contentItem.path || ""}`;
      }
      if (contentItem.type === "mention") {
        return `[mention] ${contentItem.name || contentItem.path || ""}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function textFromAgentItem(item) {
  if (item?.text) {
    return item.text;
  }

  if (!Array.isArray(item?.content)) {
    return "";
  }

  return item.content
    .map((contentItem) => {
      if (contentItem.type === "output_text" || contentItem.type === "text") {
        return contentItem.text || "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function summarizeFileChanges(changes = []) {
  if (!Array.isArray(changes) || !changes.length) {
    return "";
  }

  const header = `Changed files (${changes.length})`;
  const body = changes
    .map((change) => {
      const path = change.path || "unknown";
      const diff = change.diff || "";
      return `${path}\n${diff}`.trim();
    })
    .join("\n\n");

  return `${header}\n\n${body}`.trim();
}

export function textFromRawResponseMessage(item) {
  if (!Array.isArray(item?.content)) {
    return "";
  }

  return item.content
    .map((contentItem) => {
      if (contentItem.type === "output_text" || contentItem.type === "text") {
        return contentItem.text || "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function textFromToolResult(result) {
  if (!result) {
    return "";
  }

  if (typeof result === "string") {
    return result;
  }

  if (Array.isArray(result.content)) {
    return result.content
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (entry?.text) {
          return entry.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

export function normalizeMessageText(text) {
  return String(text || "").replaceAll("\r\n", "\n").trim();
}

export function assistantPhaseGroup(phase) {
  return phase === "commentary" ? "commentary" : "final";
}

export function messagesFromThreadItem(item) {
  if (!item?.type) {
    return [];
  }

  if (item.type === "userMessage") {
    return [{
      content: item.content || [],
      id: item.id,
      meta: "You",
      role: "user",
      text: textFromUserItem(item),
    }];
  }

  if (item.type === "agentMessage") {
    return [{
      id: item.id,
      meta: item.phase === "commentary" ? "Codex commentary" : "Codex",
      role: item.phase === "commentary" ? "commentary" : "assistant",
      text: textFromAgentItem(item),
    }];
  }

  if (item.type === "plan") {
    return item.text
      ? [{
          id: item.id,
          meta: "Plan",
          role: "commentary",
          text: item.text,
        }]
      : [];
  }

  if (item.type === "reasoning") {
    const text = [...(item.summary || []), ...(item.content || [])].filter(Boolean).join("\n");
    return text
      ? [{
          id: item.id,
          meta: "Reasoning",
          role: "commentary",
          text,
        }]
      : [];
  }

  if (item.type === "commandExecution") {
    return item.command || item.aggregatedOutput
      ? [{
          command: item.command || "",
          id: item.id,
          kind: "terminal",
          meta: "Command",
          output: item.aggregatedOutput || "",
          role: "commentary",
          status: item.status || "",
          text: item.aggregatedOutput || "",
        }]
      : [];
  }

  if (item.type === "fileChange") {
    const text = summarizeFileChanges(item.changes);
    return text
      ? [{
          id: item.id,
          kind: "diff",
          meta: "Code changes",
          role: "commentary",
          text,
        }]
      : [];
  }

  if (item.type === "mcpToolCall") {
    const details = [item.server && `${item.server}:${item.tool}`, item.status && `[${item.status}]`, textFromToolResult(item.result)]
      .filter(Boolean)
      .join("\n");
    return [{
      id: item.id,
      meta: "Tool",
      role: "commentary",
      text: details || item.tool || "Tool call",
    }];
  }

  if (item.type === "dynamicToolCall") {
    const details = [item.tool, item.status && `[${item.status}]`].filter(Boolean).join("\n");
    return [{
      id: item.id,
      meta: "Tool",
      role: "commentary",
      text: details || "Dynamic tool call",
    }];
  }

  if (item.type === "collabAgentToolCall") {
    const details = [item.tool, item.status && `[${item.status}]`, item.prompt].filter(Boolean).join("\n");
    return [{
      id: item.id,
      meta: "Agent tool",
      role: "commentary",
      text: details || "Agent collaboration",
    }];
  }

  if (item.type === "webSearch") {
    return [{
      id: item.id,
      meta: "Web search",
      role: "commentary",
      text: item.query || "Web search",
    }];
  }

  if (item.type === "imageGeneration") {
    return [{
      id: item.id,
      meta: "Image generation",
      role: "commentary",
      text: item.revisedPrompt || item.result || item.status || "Image generated",
    }];
  }

  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
    return [{
      id: item.id,
      meta: "Review mode",
      role: "commentary",
      text: item.review || item.type,
    }];
  }

  if (item.type === "contextCompaction") {
    return [{
      id: item.id,
      meta: "Context",
      role: "commentary",
      text: "Context compacted",
    }];
  }

  return [];
}

export function createMessageRenderer({
  elements,
  escapeHtml,
  renderRichTextHtml,
  toMessageHtml,
  updateScrollButton,
}) {
  function attachmentUrl(path) {
    return `/api/attachments/file?path=${encodeURIComponent(path)}`;
  }

  function parseAttachmentMarkers(text = "") {
    const lines = String(text || "").replaceAll("\r\n", "\n").split("\n");
    const attachments = [];
    const textLines = [];

    for (const line of lines) {
      const localImageMatch = line.match(/^\[local image\]\s+(.+)$/i);
      if (localImageMatch) {
        attachments.push({
          kind: "image",
          path: localImageMatch[1].trim(),
        });
        continue;
      }

      const mentionMatch = line.match(/^\[mention\]\s+(.+)$/i);
      if (mentionMatch) {
        const path = mentionMatch[1].trim();
        attachments.push({
          kind: "file",
          name: path.split("/").pop() || path,
          path,
        });
        continue;
      }

      textLines.push(line);
    }

    return {
      attachments,
      text: textLines.join("\n").trim(),
    };
  }

  function renderUserMessageHtml(message) {
    const content = Array.isArray(message.content) ? message.content : [];
    const blocks = [];
    const textParts = [];

    if (content.length) {
      for (const item of content) {
        if (item.type === "text" || item.type === "input_text") {
          if (item.text) {
            const parsed = parseAttachmentMarkers(item.text);
            if (parsed.text) {
              textParts.push(parsed.text);
            }

            for (const attachment of parsed.attachments) {
              if (attachment.kind === "image") {
                blocks.push(`
                  <a class="user-attachment-thumb-link" href="${attachmentUrl(attachment.path)}" target="_blank" rel="noreferrer">
                    <img class="user-attachment-thumb" src="${attachmentUrl(attachment.path)}" alt="Attached image" />
                  </a>
                `);
              } else {
                blocks.push(`
                  <a class="user-attachment-file" href="${attachmentUrl(attachment.path)}" target="_blank" rel="noreferrer">
                    <span class="user-attachment-file-icon">FILE</span>
                    <span class="user-attachment-file-name">${escapeHtml(attachment.name || attachment.path)}</span>
                  </a>
                `);
              }
            }
          }
          continue;
        }

        if ((item.type === "local_image" || item.type === "localImage") && item.path) {
          blocks.push(`
            <a class="user-attachment-thumb-link" href="${attachmentUrl(item.path)}" target="_blank" rel="noreferrer">
              <img class="user-attachment-thumb" src="${attachmentUrl(item.path)}" alt="Attached image" />
            </a>
          `);
          continue;
        }

        if (item.type === "mention") {
          const label = item.name || item.path || "file";
          const href = item.path ? attachmentUrl(item.path) : "#";
          blocks.push(`
            <a class="user-attachment-file" href="${href}" target="_blank" rel="noreferrer">
              <span class="user-attachment-file-icon">FILE</span>
              <span class="user-attachment-file-name">${escapeHtml(label)}</span>
            </a>
          `);
        }
      }
    } else if (message.text) {
      const parsed = parseAttachmentMarkers(message.text);
      if (parsed.text) {
        textParts.push(parsed.text);
      }

      for (const attachment of parsed.attachments) {
        if (attachment.kind === "image") {
          blocks.push(`
            <a class="user-attachment-thumb-link" href="${attachmentUrl(attachment.path)}" target="_blank" rel="noreferrer">
              <img class="user-attachment-thumb" src="${attachmentUrl(attachment.path)}" alt="Attached image" />
            </a>
          `);
        } else {
          blocks.push(`
            <a class="user-attachment-file" href="${attachmentUrl(attachment.path)}" target="_blank" rel="noreferrer">
              <span class="user-attachment-file-icon">FILE</span>
              <span class="user-attachment-file-name">${escapeHtml(attachment.name || attachment.path)}</span>
            </a>
          `);
        }
      }
    }

    const textHtml = textParts.length ? `<p>${toMessageHtml(textParts.join("\n"))}</p>` : "";
    const attachmentsHtml = blocks.length
      ? `<div class="user-attachments-grid">${blocks.join("")}</div>`
      : "";

    return `${textHtml}${attachmentsHtml}` || toMessageHtml(message.text);
  }

  function renderDiffHtml(text) {
    const lines = String(text || "").split("\n");
    const body = lines
      .map((line) => {
        let lineClass = "diff-line";
        if (line.startsWith("+") && !line.startsWith("+++")) {
          lineClass += " diff-line-add";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          lineClass += " diff-line-remove";
        } else if (line.startsWith("@@")) {
          lineClass += " diff-line-hunk";
        } else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
          lineClass += " diff-line-meta";
        }
        return `<div class="${lineClass}">${escapeHtml(line)}</div>`;
      })
      .join("");

    return `<div class="message-code message-diff">${body}</div>`;
  }

  function renderTerminalHtml(message) {
    const command = message.command || "";
    const status = message.status || "";
    const output = message.output || message.text || "";

    return `
      <div class="message-code message-terminal">
        <div class="terminal-head">
          <span class="terminal-label">$ ${escapeHtml(command || "command")}</span>
          ${status ? `<span class="terminal-status">${escapeHtml(status)}</span>` : ""}
        </div>
        ${output ? `<pre class="terminal-output">${escapeHtml(output)}</pre>` : ""}
      </div>
    `;
  }

  function renderMessageMarkup(message) {
    let body = "";
    if (message.thinking) {
      body = `<div class="thinking-row"><span class="spinner"></span><span>${escapeHtml(message.text)}</span></div>`;
    } else if (message.kind === "diff") {
      body = renderDiffHtml(message.text);
    } else if (message.kind === "terminal") {
      body = renderTerminalHtml(message);
    } else if (message.role === "user") {
      body = renderUserMessageHtml(message);
    } else if (message.role === "assistant" || message.role === "commentary") {
      body = renderRichTextHtml(message.text);
    } else {
      body = toMessageHtml(message.text);
    }

    return `
      <article class="message message-${message.role}${message.pending ? " message-pending" : ""}${message.thinking ? " message-thinking" : ""}${message.kind ? ` message-${message.kind}` : ""}" data-message-id="${escapeHtml(message.id)}">
        <div class="message-meta">
          <span>${escapeHtml(message.meta)}</span>
        </div>
        <div class="message-body">${body}</div>
      </article>
    `;
  }

  function getMessageElement(messageId) {
    return elements.messages.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  }

  function createMessageElement(message) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderMessageMarkup(message).trim();
    return wrapper.firstElementChild;
  }

  function updateMessageElement(element, message) {
    element.className = `message message-${message.role}${message.pending ? " message-pending" : ""}${message.thinking ? " message-thinking" : ""}${message.kind ? ` message-${message.kind}` : ""}`;
    const meta = element.querySelector(".message-meta span");
    const body = element.querySelector(".message-body");
    if (meta) {
      meta.textContent = message.meta;
    }
    if (body) {
      if (message.thinking) {
        body.innerHTML = `<div class="thinking-row"><span class="spinner"></span><span>${escapeHtml(message.text)}</span></div>`;
      } else if (message.kind === "diff") {
        body.innerHTML = renderDiffHtml(message.text);
      } else if (message.kind === "terminal") {
        body.innerHTML = renderTerminalHtml(message);
      } else if (message.role === "user") {
        body.innerHTML = renderUserMessageHtml(message);
      } else if (message.role === "assistant" || message.role === "commentary") {
        body.innerHTML = renderRichTextHtml(message.text);
      } else {
        body.innerHTML = toMessageHtml(message.text);
      }
    }
  }

  function upsertMessageElement(message, hasSelectedThread = true) {
    if (!hasSelectedThread) {
      return null;
    }

    const emptyState = elements.messages.querySelector(".messages-empty");
    if (emptyState) {
      emptyState.remove();
    }

    let element = getMessageElement(message.id);
    if (!element) {
      element = createMessageElement(message);
      elements.messages.appendChild(element);
    } else {
      updateMessageElement(element, message);
    }

    return element;
  }

  function removeMessageElement(messageId) {
    const element = getMessageElement(messageId);
    if (element) {
      element.remove();
    }
  }

  function renderEmptyMessagesState(text) {
    elements.messages.innerHTML = `
      <div class="empty-card messages-empty">
        <p>${escapeHtml(text)}</p>
      </div>
    `;
    updateScrollButton();
  }

  function syncRenderedMessages(messages, hasSelectedThread = true) {
    const ids = new Set(messages.map((message) => message.id));
    const children = [...elements.messages.querySelectorAll("[data-message-id]")];

    for (const child of children) {
      if (!ids.has(child.dataset.messageId)) {
        child.remove();
      }
    }

    let anchor = null;
    for (const message of messages) {
      const element = upsertMessageElement(message, hasSelectedThread);
      if (!element) {
        continue;
      }

      if (anchor === null) {
        if (elements.messages.firstElementChild !== element) {
          elements.messages.insertBefore(element, elements.messages.firstElementChild);
        }
      } else if (anchor.nextElementSibling !== element) {
        elements.messages.insertBefore(element, anchor.nextElementSibling);
      }

      anchor = element;
    }
  }

  return {
    removeMessageElement,
    renderEmptyMessagesState,
    syncRenderedMessages,
    upsertMessageElement,
  };
}
