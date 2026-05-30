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
  const HISTORY_REFRESH_DELAY_MS = 1800;
  const HISTORY_FETCH_TIMEOUT_MS = 8000;
  const JUMP_RESOLVE_TIMEOUT_MS = 2600;
  const JUMP_RESOLVE_INTERVAL_MS = 120;
  const MAX_RAIL_MARKERS = 8;

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
    isScanning: false,
    scanRunId: 0,
    isLoadingHistory: false,
    hasCompleteHistory: false,
    historyRequestId: 0,
    historyRefreshTimer: null,
    jumpRunId: 0,
    accessToken: undefined
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
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "none"
  });
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
    state.isScanning = false;
    state.isLoadingHistory = false;
    state.hasCompleteHistory = false;
    state.jumpRunId += 1;
    cancelDocumentSmoothScroll();
    if (state.historyRefreshTimer) {
      window.clearTimeout(state.historyRefreshTimer);
      state.historyRefreshTimer = null;
    }
    state.accessToken = undefined;
    if (clearQuery) {
      state.query = "";
    }
  }

  function scheduleReindexPasses(delays, { reset = false } = {}) {
    delays.forEach((delay, index) => {
      window.setTimeout(() => {
        const previousSignature = state.messageSignature;
        indexConversation({
          reset: reset && index === 0,
          force: true
        });
        if (state.messageSignature === previousSignature) {
          return;
        }
        if (state.isComposingSearch || isSearchInputActive()) {
          state.pendingIndexRender = true;
          return;
        }
        if (state.isLoadingHistory && currentConversationId() && !state.hasCompleteHistory) {
          return;
        }
        render();
      }, delay);
    });
  }

  function handleConversationRouteChange() {
    const nextKey = currentConversationKey();
    if (nextKey === state.conversationKey) {
      return;
    }

    resetConversationIndex({ clearQuery: true });
    state.scanRunId += 1;
    state.routeSettlingUntil = Date.now() + 550;
    render();
    scheduleRouteReindex(nextKey);
  }

  function scheduleRouteReindex(expectedKey) {
    window.setTimeout(() => {
      if (currentConversationKey() !== expectedKey) {
        return;
      }
      state.routeSettlingUntil = 0;
      if (currentConversationId()) {
        scheduleHistoryRefresh({ expectedKey, reset: true, delay: 250 });
        return;
      }
      indexConversation({ reset: true, force: true });
      render();
    }, 650);
  }

  function scheduleHistoryRefresh({
    expectedKey = currentConversationKey(),
    reset = false,
    delay = HISTORY_REFRESH_DELAY_MS
  } = {}) {
    if (!currentConversationId()) {
      return;
    }

    if (state.historyRefreshTimer) {
      window.clearTimeout(state.historyRefreshTimer);
    }

    state.isLoadingHistory = true;
    render();
    state.historyRefreshTimer = window.setTimeout(() => {
      state.historyRefreshTimer = null;
      runWhenIdle(() => {
        if (currentConversationKey() !== expectedKey || state.hasCompleteHistory) {
          state.isLoadingHistory = false;
          render();
          return;
        }
        refreshTimelineIndex({ reset });
      });
    }, delay);
  }

  function runWhenIdle(callback) {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(callback, { timeout: 5000 });
      return;
    }

    window.setTimeout(callback, 1200);
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

  function currentConversationId() {
    const match = window.location.pathname.match(/\/c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function fetchJsonWithTimeout(path, extraHeaders = {}) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), HISTORY_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(path, {
        credentials: "include",
        cache: "no-store",
        headers: {
          accept: "application/json",
          ...extraHeaders
        },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`History request failed: ${response.status}`);
      }

      return response.json();
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function getAccessToken() {
    if (state.accessToken !== undefined) {
      return state.accessToken;
    }

    try {
      const session = await fetchJsonWithTimeout("/api/auth/session");
      state.accessToken =
        session?.accessToken ||
        session?.access_token ||
        session?.token ||
        null;
    } catch (error) {
      state.accessToken = null;
    }

    return state.accessToken;
  }

  async function fetchConversationPayload(conversationId) {
    const encodedId = encodeURIComponent(conversationId);
    const paths = [
      `/backend-api/conversation/${encodedId}`,
      `/backend-api/f/conversation/${encodedId}`
    ];
    const accessTokenPromise = getAccessToken();

    let lastError = null;
    for (const path of paths) {
      try {
        return await fetchJsonWithTimeout(path);
      } catch (error) {
        lastError = error;
      }
    }

    const accessToken = await accessTokenPromise;
    const authHeaders = accessToken
      ? { authorization: `Bearer ${accessToken}` }
      : {};

    if (accessToken) {
      for (const path of paths) {
        try {
          return await fetchJsonWithTimeout(path, authHeaders);
        } catch (error) {
          lastError = error;
        }
      }
    }

    throw lastError || new Error("History request failed");
  }

  function conversationMappingFromPayload(payload) {
    return (
      payload?.mapping ||
      payload?.conversation?.mapping ||
      payload?.data?.mapping ||
      payload?.data?.conversation?.mapping ||
      null
    );
  }

  function currentNodeFromPayload(payload) {
    return (
      payload?.current_node ||
      payload?.conversation?.current_node ||
      payload?.data?.current_node ||
      payload?.data?.conversation?.current_node ||
      null
    );
  }

  function orderedConversationNodes(mapping, currentNodeId) {
    if (!mapping || typeof mapping !== "object") {
      return [];
    }

    if (currentNodeId && mapping[currentNodeId]) {
      const chain = [];
      const visited = new Set();
      let nodeId = currentNodeId;

      while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
        visited.add(nodeId);
        chain.push(mapping[nodeId]);
        nodeId = mapping[nodeId].parent;
      }

      return chain.reverse();
    }

    return Object.values(mapping).sort((left, right) => {
      const leftTime = left?.message?.create_time || 0;
      const rightTime = right?.message?.create_time || 0;
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return String(left?.id || "").localeCompare(String(right?.id || ""));
    });
  }

  function partToText(part) {
    if (typeof part === "string") {
      return part;
    }

    if (!part || typeof part !== "object") {
      return "";
    }

    if (typeof part.text === "string") {
      return part.text;
    }
    if (typeof part.content === "string") {
      return part.content;
    }
    if (typeof part.name === "string") {
      return part.name;
    }
    if (part.asset_pointer || part.type === "image" || part.content_type === "image_asset_pointer") {
      return "[图片]";
    }

    return "";
  }

  function contentToText(content) {
    if (!content) {
      return "";
    }

    if (Array.isArray(content.parts)) {
      return normalizeText(content.parts.map(partToText).filter(Boolean).join(" "));
    }

    if (typeof content.text === "string") {
      return normalizeText(content.text);
    }
    if (typeof content.result === "string") {
      return normalizeText(content.result);
    }

    return "";
  }

  function parseConversationMessages(payload) {
    const mapping = conversationMappingFromPayload(payload);
    const nodes = orderedConversationNodes(mapping, currentNodeFromPayload(payload));
    const messages = [];

    nodes.forEach((node, order) => {
      const sourceMessage = node?.message;
      if (!sourceMessage) {
        return;
      }

      const role = sourceMessage.author?.role || "unknown";
      if (!["user", "assistant"].includes(role)) {
        return;
      }

      const text = contentToText(sourceMessage.content);
      if (!text) {
        return;
      }

      const metadata = sourceMessage.metadata || {};
      if (metadata.is_visually_hidden_from_conversation) {
        return;
      }

      const id = sourceMessage.id || node.id || `${role}:${stableHash(text)}:${order}`;
      const textHash = stableHash(text);
      messages.push({
        id,
        domId: sourceMessage.id || null,
        index: messages.length,
        currentIndex: order,
        role,
        signature: `${role}:${textHash}:${order}`,
        stableKey: sourceMessage.id ? `dom:${sourceMessage.id}` : `history:${node.id || id}`,
        textHash,
        text,
        root: null,
        order: messages.length,
        source: "history",
        roundUserId: id,
        roundRoot: null,
        seen: true
      });
    });

    return messages;
  }

  function importConversationHistory(messages) {
    if (!messages.length) {
      return false;
    }

    const previousByKey = new Map(state.messages.map((message) => [message.stableKey, message]));
    const previousByDomId = new Map(
      state.messages
        .filter((message) => message.domId)
        .map((message) => [message.domId, message])
    );

    state.messages = messages.map((message, index) => {
      const existing = previousByKey.get(message.stableKey) || previousByDomId.get(message.domId);
      const root = existing?.root && document.documentElement.contains(existing.root)
        ? existing.root
        : null;

      return {
        ...existing,
        ...message,
        index,
        order: index,
        root,
        roundRoot: root,
        seen: true
      };
    });
    state.hasCompleteHistory = true;
    state.rounds = buildRounds();
    updateMessageSignature();
    return true;
  }

  async function refreshConversationHistory({ reset = false } = {}) {
    const conversationId = currentConversationId();
    if (!conversationId) {
      return false;
    }

    if (state.hasCompleteHistory && !reset) {
      return true;
    }

    if (reset) {
      resetConversationIndex();
    }
    const requestId = state.historyRequestId + 1;
    state.historyRequestId = requestId;
    state.isLoadingHistory = true;
    render();

    try {
      const payload = await fetchConversationPayload(conversationId);
      if (requestId !== state.historyRequestId || currentConversationId() !== conversationId) {
        return false;
      }

      const messages = parseConversationMessages(payload);
      if (!importConversationHistory(messages)) {
        state.isLoadingHistory = false;
        render();
        return false;
      }

      indexConversation({ force: true });
      state.isLoadingHistory = false;
      render();
      return true;
    } catch (error) {
      if (requestId === state.historyRequestId) {
        state.isLoadingHistory = false;
        render();
      }
      return false;
    }
  }

  async function refreshTimelineIndex({ reset = false, allowScrollScan = false } = {}) {
    const loadedFullHistory = await refreshConversationHistory({ reset });
    if (loadedFullHistory) {
      return;
    }

    if (allowScrollScan) {
      await scanOlderMessages({ reset });
      return;
    }

    indexConversation({ reset, force: true });
    render();
  }

  function updateMessageSignature() {
    state.messageSignature = state.messages
      .map((message) => `${message.id}:${message.signature}:${message.order}`)
      .join("|");
  }

  function buildRoleHashMap(messages) {
    const map = new Map();
    messages.forEach((message) => {
      const key = `${message.role}:${message.textHash}`;
      const bucket = map.get(key) || [];
      bucket.push(message);
      map.set(key, bucket);
    });
    return map;
  }

  function peekRoleHashMatch(map, role, textHash) {
    return map.get(`${role}:${textHash}`)?.[0] || null;
  }

  function takeRoleHashMatch(map, role, textHash) {
    const key = `${role}:${textHash}`;
    const bucket = map.get(key);
    if (!bucket?.length) {
      return null;
    }

    const match = bucket.shift();
    if (!bucket.length) {
      map.delete(key);
    }
    return match;
  }

  function sourcePairMatchesExisting(pair, archivedByKey, roleHashMap) {
    const role = inferRole(pair.root, pair.body);
    const text = getMessageText(pair.root, pair.body);
    const domId = pair.body.getAttribute("data-message-id") || null;
    const turnId = pair.root.getAttribute("data-testid") || null;
    const textHash = stableHash(text);
    const stableKey = domId
      ? `dom:${domId}`
      : turnId
        ? `turn:${turnId}:${role}`
        : null;

    return Boolean(
      (stableKey && archivedByKey.has(stableKey)) ||
      (domId && archivedByKey.has(`dom:${domId}`)) ||
      peekRoleHashMatch(roleHashMap, role, textHash)
    );
  }

  function hasKnownMessageAfter(source, currentIndex, archivedByKey, roleHashMap) {
    for (let index = currentIndex + 1; index < source.length; index += 1) {
      if (sourcePairMatchesExisting(source[index], archivedByKey, roleHashMap)) {
        return true;
      }
    }
    return false;
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
    const roleHashMap = buildRoleHashMap(state.messages);
    const roleHashLookup = buildRoleHashMap(state.messages);
    const previousMessages = [...state.messages];
    const previousOrderByKey = new Map(
      previousMessages.map((message, index) => [
        message.stableKey,
        Number.isFinite(message.order) ? message.order : index
      ])
    );
    const visibleMessages = [];

    source.forEach(({ root, body }, currentIndex) => {
      const role = inferRole(root, body);
      const text = getMessageText(root, body);
      const domId = body.getAttribute("data-message-id") || null;
      const turnId = root.getAttribute("data-testid") || null;
      const textHash = stableHash(text);
      const textKey = normalizeText(text).slice(0, 120);
      const occurrenceKey = `${role}:${textHash}`;
      const occurrence = occurrenceCounts.get(occurrenceKey) || 0;
      occurrenceCounts.set(occurrenceKey, occurrence + 1);
      const signature = `${role}:${textHash}:${occurrence}`;
      const stableKey = domId
        ? `dom:${domId}`
        : turnId
          ? `turn:${turnId}:${role}`
          : `text:${role}:${textHash}:${occurrence}:${textKey}`;
      const id =
        domId ||
        turnId ||
        signature;

      const existing =
        archivedByKey.get(stableKey) ||
        (domId ? archivedByKey.get(`dom:${domId}`) : null) ||
        takeRoleHashMatch(roleHashMap, role, textHash);
      if (existing) {
        markMessageRoot(root, existing.stableKey, role);
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
        visibleMessages.push(existing);
        return;
      }

      if (
        state.hasCompleteHistory &&
        hasKnownMessageAfter(source, currentIndex, archivedByKey, roleHashLookup)
      ) {
        return;
      }

      const message = {
        id,
        domId,
        index: state.messages.length + visibleMessages.length,
        currentIndex,
        role,
        signature,
        stableKey,
        textHash,
        text,
        root,
        order: null,
        roundUserId: id,
        roundRoot: root,
        seen: true
      };

      markMessageRoot(root, stableKey, role);
      visibleMessages.push(message);
      archivedByKey.set(stableKey, message);
    });

    assignVisibleMessageOrder(visibleMessages, previousOrderByKey);

    state.messages = Array.from(archivedByKey.values())
      .sort((left, right) => {
        const leftOrder = Number.isFinite(left.order) ? left.order : Number.MAX_SAFE_INTEGER;
        const rightOrder = Number.isFinite(right.order) ? right.order : Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }
        return (left.currentIndex ?? 0) - (right.currentIndex ?? 0);
      })
      .map((message, index) => {
        message.index = index;
        return message;
    });
    state.rounds = buildRounds();
    updateMessageSignature();
  }

  function assignVisibleMessageOrder(visibleMessages, previousOrderByKey) {
    if (!visibleMessages.length) {
      return;
    }

    if (!previousOrderByKey.size) {
      visibleMessages.forEach((message, index) => {
        message.order = index;
      });
      return;
    }

    const anchoredIndexes = visibleMessages
      .map((message, index) => ({
        index,
        order: previousOrderByKey.get(message.stableKey)
      }))
      .filter((entry) => Number.isFinite(entry.order));

    if (!anchoredIndexes.length) {
      const firstKnownOrder = Math.min(...previousOrderByKey.values());
      visibleMessages.forEach((message, index) => {
        message.order = firstKnownOrder - visibleMessages.length + index;
      });
      return;
    }

    const assignRange = (startIndex, endIndex, startOrder, endOrder) => {
      const count = endIndex - startIndex + 1;
      const step = (endOrder - startOrder) / (count + 1);
      for (let index = 0; index < count; index += 1) {
        visibleMessages[startIndex + index].order = startOrder + step * (index + 1);
      }
    };

    for (let anchorIndex = 0; anchorIndex < anchoredIndexes.length; anchorIndex += 1) {
      const anchor = anchoredIndexes[anchorIndex];
      visibleMessages[anchor.index].order = anchor.order;

      const nextAnchor = anchoredIndexes[anchorIndex + 1];
      if (!nextAnchor) {
        continue;
      }

      if (nextAnchor.index > anchor.index + 1) {
        assignRange(anchor.index + 1, nextAnchor.index - 1, anchor.order, nextAnchor.order);
      }
    }

    const firstAnchor = anchoredIndexes[0];
    for (let index = firstAnchor.index - 1; index >= 0; index -= 1) {
      visibleMessages[index].order = firstAnchor.order - (firstAnchor.index - index);
    }

    const lastAnchor = anchoredIndexes[anchoredIndexes.length - 1];
    for (let index = lastAnchor.index + 1; index < visibleMessages.length; index += 1) {
      visibleMessages[index].order = lastAnchor.order + (index - lastAnchor.index);
    }
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

  function displayMessages() {
    const messages = timelineMessages();
    const ordinalByKey = new Map(
      messages.map((message, index) => [message.stableKey, index + 1])
    );

    return messages.filter(matchesQuery).map((message) => ({
      message,
      ordinal: ordinalByKey.get(message.stableKey) || message.index + 1
    }));
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

  function messageButton(message, ordinal, className = "item") {
    const role = roleLabels[message.role] || roleLabels.unknown;
    const badgeClass = ["user", "assistant"].includes(message.role) ? message.role : "unknown";

    return `
      <button class="${className}" data-jump-id="${escapeHtml(message.id)}" data-jump-signature="${escapeHtml(message.signature)}" type="button">
        <span class="item-head">
          <span class="badge ${badgeClass}">${escapeHtml(role)}</span>
          <span class="ordinal">#${ordinal}</span>
        </span>
        <span class="text">${highlightQuery(snippet(message))}</span>
      </button>
    `;
  }

  function renderMessageList() {
    const matches = displayMessages();

    if (state.isLoadingHistory && currentConversationId() && !state.hasCompleteHistory) {
      return `<div class="empty">正在读取完整历史，稍后会一次性显示全部用户需求。</div>`;
    }

    if (!state.messages.length) {
      return `<div class="empty">还没有索引到消息。确认你在 ChatGPT 对话页，或点刷新按钮重新读取当前页面。</div>`;
    }

    if (!matches.length) {
      return `<div class="empty">没有找到匹配内容。可以换个关键词，或者先点“向上扫描”加载更早的会话。</div>`;
    }

    return `<div class="list">${matches.map(({ message, ordinal }) => messageButton(message, ordinal)).join("")}</div>`;
  }

  function renderRailMarkers() {
    const markers = timelineMessages();
    if (!markers.length) {
      return `<span class="rail-empty" aria-hidden="true"></span>`;
    }

    const markerIndexes = sampledMarkerIndexes(markers.length);

    return markerIndexes
      .map((messageIndex) => {
        const message = markers[messageIndex];
        const ordinal = messageIndex + 1;
        const title = `#${ordinal} ${snippet(message).slice(0, 80)}`;
        return `<button class="rail-mark ${message.role === "assistant" ? "assistant" : "user"}" data-jump-id="${escapeHtml(message.id)}" data-jump-signature="${escapeHtml(message.signature)}" type="button" title="${escapeHtml(title)}"></button>`;
      })
      .join("");
  }

  function sampledMarkerIndexes(total) {
    if (total <= MAX_RAIL_MARKERS) {
      return Array.from({ length: total }, (_, index) => index);
    }

    const indexes = new Set();
    for (let index = 0; index < MAX_RAIL_MARKERS; index += 1) {
      indexes.add(Math.round((index * (total - 1)) / (MAX_RAIL_MARKERS - 1)));
    }

    return Array.from(indexes).sort((left, right) => left - right);
  }

  function render() {
    const userCount = state.rounds.filter((round) => round.user).length;
    const indexedCount = state.includeAssistant
      ? state.messages.filter((message) => message.role === "user" || message.role === "assistant").length
      : userCount;
    const countLabel = state.includeAssistant ? "条对话已索引" : "条用户需求已索引";
    const matchCount = visibleMessages().length;
    const displayCount = timelineMessages().length;
    const pinnedClass = state.isOpen ? "is-pinned" : "";
    const isAwaitingFullHistory = state.isLoadingHistory && currentConversationId() && !state.hasCompleteHistory;
    const scanText = state.isLoadingHistory
      ? " · 正在读取完整历史"
      : state.isScanning
        ? " · 正在扫描历史对话"
        : "";
    const subtitle = isAwaitingFullHistory
      ? "正在读取完整历史"
      : `${indexedCount} ${countLabel} · 当前显示 ${displayCount} 条${state.query ? ` · ${matchCount} 条匹配` : ""}${scanText}`;

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
              <span>${subtitle}</span>
            </div>
            <button class="icon-button" data-action="refresh" type="button" title="重新扫描当前对话">
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
              ${state.isScanning ? "扫描中" : "扫描历史"}
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
          refreshTimelineIndex({ reset: true });
        }
        if (action === "scan") {
          refreshTimelineIndex({ allowScrollScan: true });
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

  async function jumpToMessage(id, signature) {
    const jumpRunId = state.jumpRunId + 1;
    state.jumpRunId = jumpRunId;
    indexConversation({ force: true });
    const sourceMessage = messageById(id) || messageBySignature(signature);
    if (!sourceMessage) {
      return;
    }

    const targetMessage = messageById(sourceMessage.roundUserId) || sourceMessage;
    let targetRoot =
      resolveMessageRoot(targetMessage) ||
      resolveMessageRoot(sourceMessage) ||
      targetMessage.roundRoot ||
      targetMessage.root;

    if (!targetRoot) {
      targetRoot = await loadMessageRootForJump(targetMessage, sourceMessage);
    }

    if (!targetRoot) {
      return;
    }

    scrollElementToConversationStart(targetRoot, "smooth");
    scheduleScrollCorrection(targetRoot, jumpRunId);

    targetRoot.setAttribute("data-gpt-timeline-search-hit", "true");
    window.setTimeout(() => {
      targetRoot.removeAttribute("data-gpt-timeline-search-hit");
    }, 1800);
  }

  async function loadMessageRootForJump(targetMessage, sourceMessage) {
    const container = findScrollContainer();
    const targetIndex = messageIndex(targetMessage, sourceMessage);
    const estimatedTop = estimateScrollTopForMessage(container, targetIndex);

    scrollContainerToTop(container, estimatedTop, "auto");

    let targetRoot = await waitForJumpTarget(targetMessage, sourceMessage);
    if (targetRoot) {
      return targetRoot;
    }

    const correctionTop = correctionScrollTopForMessage(container, targetIndex);
    if (correctionTop === null || Math.abs(correctionTop - getScrollTop(container)) < 24) {
      return null;
    }

    scrollContainerToTop(container, correctionTop, "auto");
    targetRoot = await waitForJumpTarget(targetMessage, sourceMessage);
    return targetRoot;
  }

  async function waitForJumpTarget(targetMessage, sourceMessage) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < JUMP_RESOLVE_TIMEOUT_MS) {
      await sleep(JUMP_RESOLVE_INTERVAL_MS);
      indexConversation({ force: true });

      const targetRoot =
        resolveMessageRoot(targetMessage) ||
        resolveMessageRoot(sourceMessage) ||
        targetMessage.roundRoot ||
        sourceMessage.roundRoot;
      if (targetRoot) {
        return targetRoot;
      }
    }

    return null;
  }

  function messageIndex(primaryMessage, fallbackMessage) {
    const primaryIndex = state.messages.indexOf(primaryMessage);
    if (primaryIndex >= 0) {
      return primaryIndex;
    }

    const fallbackIndex = state.messages.indexOf(fallbackMessage);
    return Math.max(0, fallbackIndex);
  }

  function estimateScrollTopForMessage(container, targetIndex) {
    const anchors = scrollAnchorsForContainer(container);
    const maxTop = maxScrollTop(container);
    const fallbackTop = maxTop * messageScrollRatio(targetIndex);

    if (!anchors.length) {
      return fallbackTop;
    }

    const before = [...anchors].reverse().find((anchor) => anchor.index <= targetIndex);
    const after = anchors.find((anchor) => anchor.index >= targetIndex);
    const offset = 92;

    if (before && after && before.index !== after.index) {
      const indexSpan = after.index - before.index;
      if (indexSpan > 2 && maxTop > visiblePageStep(container) * 2) {
        return fallbackTop;
      }
      const ratio = (targetIndex - before.index) / (after.index - before.index);
      return clampScrollTop(container, before.top + (after.top - before.top) * ratio - offset);
    }

    if (before && after) {
      return clampScrollTop(container, before.top - offset);
    }

    const nearbyAnchors = before
      ? anchors.filter((anchor) => anchor.index <= before.index).slice(-3)
      : anchors.filter((anchor) => anchor.index >= after.index).slice(0, 3);
    const pixelsPerMessage = averagePixelsPerMessage(nearbyAnchors);

    if (before && Number.isFinite(pixelsPerMessage)) {
      return clampScrollTop(container, before.top + (targetIndex - before.index) * pixelsPerMessage - offset);
    }
    if (after && Number.isFinite(pixelsPerMessage)) {
      return clampScrollTop(container, after.top - (after.index - targetIndex) * pixelsPerMessage - offset);
    }

    return fallbackTop;
  }

  function correctionScrollTopForMessage(container, targetIndex) {
    const ratio = messageScrollRatio(targetIndex);
    if (ratio >= 0.9) {
      return maxScrollTop(container);
    }
    if (ratio <= 0.1) {
      return 0;
    }

    const visibleIndexes = scrollAnchorsForContainer(container).map((anchor) => anchor.index);
    if (!visibleIndexes.length) {
      return null;
    }

    const minIndex = Math.min(...visibleIndexes);
    const maxIndex = Math.max(...visibleIndexes);
    const currentTop = getScrollTop(container);
    const pageStep = visiblePageStep(container);

    if (targetIndex < minIndex) {
      return clampScrollTop(container, currentTop - pageStep);
    }
    if (targetIndex > maxIndex) {
      return clampScrollTop(container, currentTop + pageStep);
    }

    return null;
  }

  function scrollAnchorsForContainer(container) {
    return state.messages
      .map((message, index) => {
        const root = message.root && document.documentElement.contains(message.root)
          ? message.root
          : null;
        if (!root || !containerContainsElement(container, root)) {
          return null;
        }
        return {
          index,
          top: elementTopInContainer(container, root)
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.index - right.index);
  }

  function averagePixelsPerMessage(anchors) {
    if (anchors.length < 2) {
      return NaN;
    }

    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    const indexDistance = last.index - first.index;
    if (!indexDistance) {
      return NaN;
    }

    return (last.top - first.top) / indexDistance;
  }

  function messageScrollRatio(index) {
    const count = Math.max(1, state.messages.length - 1);
    return Math.max(0, Math.min(1, index / count));
  }

  function visiblePageStep(container) {
    if (isDocumentScrollContainer(container)) {
      return Math.max(240, window.innerHeight * 0.72);
    }
    return Math.max(240, container.clientHeight * 0.72);
  }

  function maxScrollTop(element) {
    if (isDocumentScrollContainer(element)) {
      const scrollingElement = document.scrollingElement || document.documentElement;
      return Math.max(0, scrollingElement.scrollHeight - window.innerHeight);
    }
    return Math.max(0, element.scrollHeight - element.clientHeight);
  }

  function clampScrollTop(element, top) {
    return Math.max(0, Math.min(maxScrollTop(element), top));
  }

  function scrollContainerToTop(element, top, behavior = "auto") {
    const clampedTop = clampScrollTop(element, top);
    if (isDocumentScrollContainer(element)) {
      window.scrollTo({ top: clampedTop, behavior });
      return;
    }

    element.scrollTo({ top: clampedTop, behavior });
  }

  function elementTopInContainer(container, element) {
    if (isDocumentScrollContainer(container)) {
      return element.getBoundingClientRect().top + window.scrollY;
    }

    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    return container.scrollTop + elementRect.top - containerRect.top;
  }

  function containerContainsElement(container, element) {
    return isDocumentScrollContainer(container) || container.contains(element);
  }

  function isDocumentScrollContainer(element) {
    return (
      element === document.body ||
      element === document.documentElement ||
      element === document.scrollingElement
    );
  }

  function cancelDocumentSmoothScroll() {
    window.scrollTo({ top: window.scrollY, behavior: "auto" });
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

  function scheduleScrollCorrection(element, jumpRunId) {
    [80, 180, 360, 620].forEach((delay) => {
      window.setTimeout(() => {
        if (jumpRunId !== state.jumpRunId) {
          return;
        }
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

  async function scanOlderMessages({ reset = false } = {}) {
    if (state.isScanning) {
      if (!reset) {
        return;
      }
      state.scanRunId += 1;
      state.isScanning = false;
    }

    const scanRunId = state.scanRunId + 1;
    state.scanRunId = scanRunId;
    state.isScanning = true;
    if (reset) {
      indexConversation({ reset: true, force: true });
    }
    render();

    const container = findScrollContainer();
    const originalTop = getScrollTop(container);
    let previousCount = state.messages.length;
    let stableSteps = 0;

    for (let step = 0; step < MAX_SCAN_STEPS; step += 1) {
      if (scanRunId !== state.scanRunId || currentConversationKey() !== state.conversationKey) {
        break;
      }

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

    if (scanRunId === state.scanRunId && currentConversationKey() === state.conversationKey) {
      restoreScroll(container, originalTop);
      indexConversation({ force: true });
      state.isScanning = false;
      render();
    }
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
      if (state.isLoadingHistory && currentConversationId() && !state.hasCompleteHistory) {
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
      refreshTimelineIndex();
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
  if (currentConversationId()) {
    scheduleHistoryRefresh();
  }
  scheduleReindexPasses([450, 1100, 2400, 4200, 6800]);
})();
