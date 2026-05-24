(() => {
  const chromeRuntime = globalThis.chrome?.runtime;
  const CHATGPT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
  const isChatGptPage = CHATGPT_HOSTS.has(window.location.hostname);
  const isTestFixture = document.documentElement.hasAttribute("data-gpt-timeline-test-page");

  if (!isChatGptPage && !isTestFixture) {
    return;
  }

  if (window.__chatgptTimelineSearchLoaded) {
    return;
  }

  window.__chatgptTimelineSearchLoaded = true;

  const EXTENSION_ID = "chatgpt-timeline-search";
  const STORAGE_KEY = "chatgptTimelineSearchPrefs";
  const MAX_SCAN_STEPS = 26;
  const SCAN_WAIT_MS = 380;

  const state = {
    messages: [],
    rounds: [],
    messageSignature: "",
    conversationKey: currentConversationKey(),
    routeSettlingUntil: 0,
    query: "",
    isComposingSearch: false,
    pendingIndexRender: false,
    searchRenderTimer: null,
    includeAssistant: false,
    isOpen: false,
    isScanning: false
  };

  const pageStyle = document.createElement("style");
  pageStyle.textContent = `
    [data-gpt-timeline-search-hit="true"] {
      outline: 3px solid #14b8a6 !important;
      outline-offset: 6px !important;
      border-radius: 10px !important;
      transition: outline-color 180ms ease;
    }
  `;
  document.documentElement.appendChild(pageStyle);

  const host = document.createElement("div");
  host.id = EXTENSION_ID;
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chromeRuntime?.getURL
    ? chromeRuntime.getURL("src/content.css")
    : new URL("/src/content.css", window.location.origin).toString();
  shadow.appendChild(stylesheet);

  const app = document.createElement("div");
  shadow.appendChild(app);

  const roleLabels = {
    user: "我",
    assistant: "ChatGPT",
    system: "系统",
    tool: "工具",
    unknown: "消息"
  };

  loadPreferences();

  function loadPreferences() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
      if (typeof saved.isOpen === "boolean") {
        state.isOpen = saved.isOpen;
      }
      if (typeof saved.includeAssistant === "boolean") {
        state.includeAssistant = saved.includeAssistant;
      }
    } catch (error) {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }

  function savePreferences() {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          isOpen: state.isOpen,
          includeAssistant: state.includeAssistant
        })
      );
    } catch (error) {
      // Ignore storage errors from strict browser privacy modes.
    }
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      };
      return entities[char];
    });
  }

  function normalizeText(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function stableHash(value) {
    let hash = 5381;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 33) ^ value.charCodeAt(index);
    }
    return (hash >>> 0).toString(36);
  }

  function debounce(callback, delay) {
    let timeoutId;
    return (...args) => {
      clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => callback(...args), delay);
    };
  }

  function currentConversationKey() {
    return `${window.location.origin}${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  function resetConversationIndex({ clearQuery = false } = {}) {
    state.messages = [];
    state.rounds = [];
    state.messageSignature = "";
    state.conversationKey = currentConversationKey();
    if (clearQuery) {
      state.query = "";
    }
  }

  function handleConversationRouteChange() {
    const nextKey = currentConversationKey();
    if (nextKey === state.conversationKey) {
      return;
    }

    resetConversationIndex({ clearQuery: true });
    state.routeSettlingUntil = Date.now() + 550;
    render();
    scheduleRouteReindex(nextKey);
  }

  function scheduleRouteReindex(expectedKey) {
    [650, 1200, 2200].forEach((delay) => {
      window.setTimeout(() => {
        if (currentConversationKey() !== expectedKey) {
          return;
        }
        state.routeSettlingUntil = 0;
        indexConversation({ reset: true, force: true });
        render();
      }, delay);
    });
  }

  function installRouteChangeListeners() {
    const notifyRouteChange = () => window.setTimeout(handleConversationRouteChange, 0);
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function patchedPushState(...args) {
      const result = originalPushState.apply(this, args);
      notifyRouteChange();
      return result;
    };

    history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      notifyRouteChange();
      return result;
    };

    window.addEventListener("popstate", notifyRouteChange);
    window.addEventListener("hashchange", notifyRouteChange);
  }

  function getMessageRoot(element) {
    return (
      element.closest("[data-testid^='conversation-turn-']") ||
      element.closest("article") ||
      element.closest("[class*='group/conversation-turn']") ||
      element
    );
  }

  function getMessageText(root, body) {
    const candidate =
      body.querySelector(".markdown") ||
      body.querySelector("[data-message-id]") ||
      body;

    return normalizeText(candidate.innerText || candidate.textContent || "");
  }

  function inferRole(root, body) {
    const role =
      body.getAttribute("data-message-author-role") ||
      root.getAttribute("data-message-author-role");

    if (role) {
      return role;
    }

    const label = normalizeText(root.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("assistant") || label.includes("chatgpt")) {
      return "assistant";
    }
    if (label.includes("user") || label.includes("you")) {
      return "user";
    }

    return "unknown";
  }

  function collectMessageNodes() {
    const nodes = Array.from(document.querySelectorAll("[data-message-author-role]"));
    const seen = new Set();

    return nodes
      .map((body) => {
        const root = getMessageRoot(body);
        return { root, body };
      })
      .filter(({ root, body }) => {
        if (!root || seen.has(root) || host.contains(root)) {
          return false;
        }
        seen.add(root);
        return getMessageText(root, body).length > 0;
      });
  }

  function collectFallbackNodes() {
    const candidates = Array.from(
      document.querySelectorAll("[data-testid^='conversation-turn-'], article")
    );
    const seen = new Set();

    return candidates
      .map((root) => ({ root, body: root.querySelector("[data-message-author-role]") || root }))
      .filter(({ root, body }) => {
        if (!root || seen.has(root) || host.contains(root)) {
          return false;
        }
        const text = getMessageText(root, body);
        if (text.length < 2) {
          return false;
        }
        seen.add(root);
        return true;
      });
  }

  function indexConversation({ reset = false, force = false } = {}) {
    if (currentConversationKey() !== state.conversationKey) {
      handleConversationRouteChange();
      return;
    }

    if (!force && Date.now() < state.routeSettlingUntil) {
      return;
    }

    if (reset) {
      resetConversationIndex();
    }

    const pairs = collectMessageNodes();
    const source = pairs.length > 0 ? pairs : collectFallbackNodes();
    const occurrenceCounts = new Map();
    const archivedByKey = new Map(state.messages.map((message) => [message.stableKey, message]));

    source.forEach(({ root, body }, currentIndex) => {
      const role = inferRole(root, body);
      const text = getMessageText(root, body);
      const domId = body.getAttribute("data-message-id") || null;
      const textHash = stableHash(text);
      const textKey = normalizeText(text).slice(0, 120);
      const occurrenceKey = `${role}:${textHash}`;
      const occurrence = occurrenceCounts.get(occurrenceKey) || 0;
      occurrenceCounts.set(occurrenceKey, occurrence + 1);
      const signature = `${role}:${textHash}:${occurrence}`;
      const stableKey = domId ? `dom:${domId}` : `text:${role}:${textHash}:${textKey}`;
      const id =
        domId ||
        root.getAttribute("data-testid") ||
        signature;

      const existing = archivedByKey.get(stableKey);
      if (existing) {
        markMessageRoot(root, stableKey, role);
        Object.assign(existing, {
          id,
          domId,
          currentIndex,
          role,
          signature,
          textHash,
          text,
          root,
          seen: true
        });
        return;
      }

      const message = {
        id,
        domId,
        index: state.messages.length,
        currentIndex,
        role,
        signature,
        stableKey,
        textHash,
        text,
        root,
        roundUserId: id,
        roundRoot: root,
        seen: true
      };

      markMessageRoot(root, stableKey, role);
      state.messages.push(message);
      archivedByKey.set(stableKey, message);
    });

    state.rounds = buildRounds();
    state.messageSignature = state.messages
      .map((message) => `${message.id}:${message.signature}`)
      .join("|");
  }

  function markMessageRoot(root, stableKey, role) {
    if (!root) {
      return;
    }

    root.setAttribute("data-gpt-timeline-message-key", stableKey);
    if (role === "user") {
      root.setAttribute("data-gpt-timeline-round-start", "true");
    }
  }

  function buildRounds() {
    const rounds = [];
    let currentRound = null;

    state.messages.forEach((message) => {
      if (message.role === "user" || !currentRound) {
        currentRound = {
          id: message.role === "user" ? message.id : `round-${message.index}`,
          user: message.role === "user" ? message : null,
          messages: []
        };
        rounds.push(currentRound);
      }

      if (!currentRound.user && message.role === "user") {
        currentRound.user = message;
      }

      message.roundUserId = currentRound.user?.id || message.id;
      message.roundRoot = currentRound.user?.root || message.root;
      currentRound.messages.push(message);
    });

    return rounds;
  }

  function matchesQuery(message) {
    const terms = searchTerms();
    if (!terms.length) {
      return true;
    }
    const text = message.text.toLowerCase();
    return terms.every((term) => text.includes(term));
  }

  function matchesRole(message) {
    if (message.role === "user") {
      return true;
    }
    return state.includeAssistant && message.role === "assistant";
  }

  function visibleMessages() {
    return timelineMessages().filter(matchesQuery);
  }

  function timelineMessages() {
    return state.rounds.flatMap((round) => {
      const userMessages = round.user ? [round.user] : [];
      if (!state.includeAssistant) {
        return userMessages;
      }
      return round.messages.filter((message) => message.role === "user" || message.role === "assistant");
    });
  }

  function searchTerms() {
    return state.query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  function highlightQuery(text) {
    const escaped = escapeHtml(text);
    const terms = searchTerms();
    if (!terms.length) {
      return escaped;
    }

    const escapedTerms = terms
      .map((term) => escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    return escaped.replace(new RegExp(escapedTerms, "gi"), (match) => `<mark>${match}</mark>`);
  }

  function snippet(message) {
    const terms = searchTerms();
    if (!terms.length) {
      return message.text.slice(0, 220);
    }

    const lowerText = message.text.toLowerCase();
    const matchIndex = terms.reduce((nearest, term) => {
      const index = lowerText.indexOf(term);
      if (index < 0) {
        return nearest;
      }
      return nearest < 0 ? index : Math.min(nearest, index);
    }, -1);
    if (matchIndex < 0) {
      return message.text.slice(0, 220);
    }

    const start = Math.max(0, matchIndex - 72);
    const end = Math.min(message.text.length, matchIndex + 160);
    const prefix = start > 0 ? "... " : "";
    const suffix = end < message.text.length ? " ..." : "";
    return `${prefix}${message.text.slice(start, end)}${suffix}`;
  }

  function messageButton(message, className = "item") {
    const role = roleLabels[message.role] || roleLabels.unknown;
    const badgeClass = ["user", "assistant"].includes(message.role) ? message.role : "unknown";

    return `
      <button class="${className}" data-jump-id="${escapeHtml(message.id)}" data-jump-signature="${escapeHtml(message.signature)}" type="button">
        <span class="item-head">
          <span class="badge ${badgeClass}">${escapeHtml(role)}</span>
          <span class="ordinal">#${message.index + 1}</span>
        </span>
        <span class="text">${highlightQuery(snippet(message))}</span>
      </button>
    `;
  }

  function renderMessageList() {
    const matches = visibleMessages();

    if (!state.messages.length) {
      return `<div class="empty">还没有索引到消息。确认你在 ChatGPT 对话页，或点刷新按钮重新读取当前页面。</div>`;
    }

    if (!matches.length) {
      return `<div class="empty">没有找到匹配内容。可以换个关键词，或者先点“向上扫描”加载更早的会话。</div>`;
    }

    return `<div class="list">${matches.map((message) => messageButton(message)).join("")}</div>`;
  }

  function renderRailMarkers() {
    const markers = timelineMessages();
    if (!markers.length) {
      return `<span class="rail-empty" aria-hidden="true"></span>`;
    }

    return markers
      .map(
        (message) =>
          `<button class="rail-mark ${message.role === "assistant" ? "assistant" : "user"}" data-jump-id="${escapeHtml(message.id)}" data-jump-signature="${escapeHtml(message.signature)}" type="button" title="${escapeHtml(snippet(message).slice(0, 80))}"></button>`
      )
      .join("");
  }

  function render() {
    const count = state.messages.length;
    const matchCount = visibleMessages().length;
    const userCount = state.rounds.filter((round) => round.user).length;
    const displayCount = timelineMessages().length;
    const pinnedClass = state.isOpen ? "is-pinned" : "";

    app.innerHTML = `
      <div class="dock ${pinnedClass}">
        <div class="rail-hitbox" aria-label="打开时间轴搜索">
          <div class="rail" aria-hidden="false">
            ${renderRailMarkers()}
          </div>
        </div>
        <aside class="panel" aria-label="ChatGPT 时间轴搜索">
          <div class="topbar">
            <div class="title">
              <strong>时间轴</strong>
              <span>${count} 条已索引 · 当前显示 ${displayCount} 条${state.query ? ` · ${matchCount} 条匹配` : ""}</span>
            </div>
            <button class="icon-button" data-action="refresh" type="button" title="刷新索引">
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button class="icon-button" data-action="close" type="button" title="收起">
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
          <div class="search-row">
            <input class="search-input" type="search" placeholder="搜索用户需求" value="${escapeHtml(state.query)}" />
            <button class="icon-button clear-button" data-action="clear" type="button" title="清空搜索">
              <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none">
                <path d="m18 6-12 12M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
          <div class="controls">
            <label class="toggle">
              <input type="checkbox" data-action="toggle-assistant" ${state.includeAssistant ? "checked" : ""} />
              <span>显示 ChatGPT 回复</span>
            </label>
            <button class="scan-button" data-action="scan" type="button" ${state.isScanning ? "disabled" : ""}>
              ${state.isScanning ? "扫描中" : "向上扫描"}
            </button>
          </div>
          <div class="content">
            <div class="timeline">
              ${renderMessageList()}
            </div>
          </div>
          <div class="footer">${userCount} 条用户需求 · 快捷键 Ctrl/Command + Shift + F</div>
        </aside>
      </div>
    `;

    bindUiEvents();
  }

  function isSearchInputActive() {
    return shadow.activeElement?.classList.contains("search-input");
  }

  function scheduleSearchRender(delay = 180) {
    if (state.searchRenderTimer) {
      window.clearTimeout(state.searchRenderTimer);
    }

    state.searchRenderTimer = window.setTimeout(() => {
      state.searchRenderTimer = null;
      state.pendingIndexRender = false;
      render();
      focusSearch();
    }, delay);
  }

  function bindUiEvents() {
    const searchInput = shadow.querySelector(".search-input");
    const activeElement = shadow.activeElement;

    shadow.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.getAttribute("data-action");
        if (action === "open") {
          state.isOpen = true;
          savePreferences();
          render();
          focusSearch();
        }
        if (action === "close") {
          state.isOpen = false;
          savePreferences();
          render();
        }
        if (action === "clear") {
          state.query = "";
          render();
          focusSearch();
        }
        if (action === "toggle-assistant") {
          state.includeAssistant = button.checked;
          savePreferences();
          render();
        }
        if (action === "refresh") {
          indexConversation({ reset: true, force: true });
          render();
        }
        if (action === "scan") {
          scanOlderMessages();
        }
      });
    });

    shadow.querySelectorAll("[data-jump-id]").forEach((button) => {
      button.addEventListener("click", () => {
        jumpToMessage(
          button.getAttribute("data-jump-id"),
          button.getAttribute("data-jump-signature")
        );
      });
    });

    if (searchInput) {
      searchInput.addEventListener("compositionstart", () => {
        state.isComposingSearch = true;
        if (state.searchRenderTimer) {
          window.clearTimeout(state.searchRenderTimer);
          state.searchRenderTimer = null;
        }
      });

      searchInput.addEventListener("compositionend", (event) => {
        state.isComposingSearch = false;
        state.query = event.target.value;
        scheduleSearchRender(0);
      });

      searchInput.addEventListener("input", (event) => {
        state.query = event.target.value;
        if (state.isComposingSearch || event.isComposing) {
          return;
        }
        scheduleSearchRender();
      });

      searchInput.addEventListener("blur", () => {
        if (state.pendingIndexRender) {
          state.pendingIndexRender = false;
          render();
        }
      });

      if (activeElement && activeElement.classList.contains("search-input")) {
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
      }
    }
  }

  function focusSearch() {
    requestAnimationFrame(() => {
      const input = shadow.querySelector(".search-input");
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
  }

  function messageById(id) {
    return state.messages.find((message) => message.id === id);
  }

  function jumpToMessage(id, signature) {
    indexConversation({ force: true });
    const sourceMessage = messageById(id) || messageBySignature(signature);
    if (!sourceMessage) {
      return;
    }

    const targetMessage = messageById(sourceMessage.roundUserId) || sourceMessage;
    const targetRoot =
      resolveMessageRoot(targetMessage) ||
      resolveMessageRoot(sourceMessage) ||
      targetMessage.roundRoot ||
      targetMessage.root;
    if (!targetRoot) {
      return;
    }

    scrollElementToConversationStart(targetRoot, "smooth");
    scheduleScrollCorrection(targetRoot);

    targetRoot.setAttribute("data-gpt-timeline-search-hit", "true");
    window.setTimeout(() => {
      targetRoot.removeAttribute("data-gpt-timeline-search-hit");
    }, 1800);
  }

  function messageBySignature(signature) {
    return state.messages.find((message) => message.signature === signature);
  }

  function resolveMessageRoot(message) {
    if (!message) {
      return null;
    }

    if (message.root && document.documentElement.contains(message.root)) {
      return message.root;
    }

    if (message.stableKey && typeof CSS !== "undefined" && CSS.escape) {
      const root = document.querySelector(
        `[data-gpt-timeline-message-key="${CSS.escape(message.stableKey)}"]`
      );
      if (root) {
        return root;
      }
    }

    if (message.domId && typeof CSS !== "undefined" && CSS.escape) {
      const body = document.querySelector(`[data-message-id="${CSS.escape(message.domId)}"]`);
      if (body) {
        return getMessageRoot(body);
      }
    }

    const candidates = collectMessageNodes();
    const fallbackCandidates = candidates.length > 0 ? candidates : collectFallbackNodes();
    for (const { root, body } of fallbackCandidates) {
      const role = inferRole(root, body);
      const text = getMessageText(root, body);
      if (role === message.role && stableHash(text) === message.textHash) {
        return root;
      }
    }

    return null;
  }

  function scrollElementToConversationStart(element, behavior = "auto") {
    const container = findScrollContainerForElement(element);
    const offset = 92;

    if (
      container === document.body ||
      container === document.documentElement ||
      container === document.scrollingElement
    ) {
      const top = element.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({
        top: Math.max(0, top),
        behavior
      });
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const top = container.scrollTop + elementRect.top - containerRect.top - offset;
    container.scrollTo({
      top: Math.max(0, top),
      behavior
    });
  }

  function scheduleScrollCorrection(element) {
    [80, 180, 360, 620].forEach((delay) => {
      window.setTimeout(() => {
        if (!document.documentElement.contains(element)) {
          return;
        }
        scrollElementToConversationStart(element, "auto");
      }, delay);
    });
  }

  function findScrollContainerForElement(element) {
    let current = element.parentElement;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      const canScroll = /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`);
      if (canScroll && current.scrollHeight > current.clientHeight) {
        return current;
      }
      current = current.parentElement;
    }

    return document.scrollingElement || document.documentElement;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function findScrollContainer() {
    const messages = state.messages.map((message) => message.root).filter(Boolean);
    const candidates = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll("main, [role='main'], div"))
    ].filter(Boolean);

    let best = document.scrollingElement || document.documentElement;
    let bestScrollableDistance = 0;

    for (const element of candidates) {
      const scrollableDistance = element.scrollHeight - element.clientHeight;
      if (scrollableDistance <= bestScrollableDistance) {
        continue;
      }

      if (messages.length && !messages.some((message) => element.contains(message))) {
        continue;
      }

      const style = window.getComputedStyle(element);
      const canScroll = /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`);
      if (canScroll || element === document.scrollingElement || element === document.body) {
        best = element;
        bestScrollableDistance = scrollableDistance;
      }
    }

    return best;
  }

  function scrollToTop(element) {
    if (element === document.body || element === document.documentElement || element === document.scrollingElement) {
      window.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    element.scrollTo({ top: 0, behavior: "auto" });
  }

  function restoreScroll(element, top) {
    if (element === document.body || element === document.documentElement || element === document.scrollingElement) {
      window.scrollTo({ top, behavior: "auto" });
      return;
    }
    element.scrollTo({ top, behavior: "auto" });
  }

  function getScrollTop(element) {
    if (element === document.body || element === document.documentElement || element === document.scrollingElement) {
      return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }
    return element.scrollTop;
  }

  async function scanOlderMessages() {
    if (state.isScanning) {
      return;
    }

    state.isScanning = true;
    render();

    const container = findScrollContainer();
    const originalTop = getScrollTop(container);
    let previousCount = state.messages.length;
    let stableSteps = 0;

    for (let step = 0; step < MAX_SCAN_STEPS; step += 1) {
      scrollToTop(container);
      await sleep(SCAN_WAIT_MS);
      indexConversation({ force: true });

      if (state.messages.length === previousCount) {
        stableSteps += 1;
      } else {
        previousCount = state.messages.length;
        stableSteps = 0;
      }

      if (getScrollTop(container) <= 2 && stableSteps >= 3) {
        break;
      }
    }

    restoreScroll(container, originalTop);
    state.isScanning = false;
    render();
  }

  const debouncedReindex = debounce(() => {
    if (currentConversationKey() !== state.conversationKey) {
      handleConversationRouteChange();
      return;
    }

    if (Date.now() < state.routeSettlingUntil) {
      return;
    }

    const previousSignature = state.messageSignature;
    indexConversation();
    if (state.messageSignature !== previousSignature) {
      if (state.isComposingSearch || isSearchInputActive()) {
        state.pendingIndexRender = true;
        return;
      }
      render();
    }
  }, 600);

  const observer = new MutationObserver(debouncedReindex);
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  window.addEventListener("keydown", (event) => {
    const isSearchShortcut = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f";
    if (!isSearchShortcut) {
      return;
    }

    event.preventDefault();
    state.isOpen = true;
    savePreferences();
    render();
    focusSearch();
  });

  if (chromeRuntime?.onMessage) {
    chromeRuntime.onMessage.addListener((message) => {
      if (!message || message.type !== "GPT_TIMELINE_TOGGLE") {
        return;
      }

    state.isOpen = !state.isOpen;
    if (state.isOpen) {
      indexConversation({ force: true });
    }
      savePreferences();
      render();
      if (state.isOpen) {
        focusSearch();
      }
    });
  }

  installRouteChangeListeners();
  indexConversation({ force: true });
  render();
})();
