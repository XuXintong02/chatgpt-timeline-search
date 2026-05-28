import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const projectRoot = resolve(import.meta.dirname, "..");
const extensionPath = process.env.EXTENSION_PATH || projectRoot;
const chromePath = findChromePath();

const failures = [];

function createConversationPayload(items) {
  const mapping = {};
  let parent = "root";

  mapping.root = {
    id: "root",
    parent: null,
    children: [],
    message: null
  };

  items.forEach((item, index) => {
    const nodeId = `node-${index + 1}`;
    mapping[parent].children.push(nodeId);
    mapping[nodeId] = {
      id: nodeId,
      parent,
      children: [],
      message: {
        id: item.id,
        author: { role: item.role },
        create_time: 1700000000 + index,
        content: {
          content_type: "text",
          parts: [item.text]
        },
        metadata: {}
      }
    };
    parent = nodeId;
  });

  return {
    current_node: parent,
    mapping
  };
}

const fullHistoryPayload = createConversationPayload([
  {
    id: "fixture-user-1",
    role: "user",
    text: "我需要一个网页插件，在超长 ChatGPT 会话中搜索关键内容。"
  },
  {
    id: "fixture-assistant-1",
    role: "assistant",
    text: "可以做一个时间轴面板，按消息顺序建立 timeline anchors，并支持关键词查找。"
  },
  {
    id: "fixture-user-2",
    role: "user",
    text: "搜索结果最好可以区分我和 ChatGPT 的回复。"
  },
  {
    id: "fixture-assistant-2",
    role: "assistant",
    text: "第一版加入角色过滤、刷新索引、向上扫描和快捷键。"
  },
  {
    id: "history-user-missing-middle",
    role: "user",
    text: "这是完整历史接口里的中间用户需求，当前页面 DOM 没有加载出来，但时间轴必须显示。"
  },
  {
    id: "history-assistant-missing-middle",
    role: "assistant",
    text: "这是中间用户需求对应的回复。"
  },
  {
    id: "fixture-user-3",
    role: "user",
    text: "第二版需要默认显示全部用户需求，而不是只显示最近几条。"
  },
  {
    id: "fixture-assistant-3",
    role: "assistant",
    text: "面板内部应该使用独立滚动区域，用户可以像翻网页一样上下查找。"
  },
  {
    id: "fixture-user-4",
    role: "user",
    text: "点击时间轴时，请准确跳转到本轮对话的用户需求起始处。"
  },
  {
    id: "fixture-assistant-4",
    role: "assistant",
    text: "即使点击的是 ChatGPT 回复，也应该定位到这一轮最开始的用户问题。"
  },
  {
    id: "history-user-tail",
    role: "user",
    text: "这是完整历史接口里的最后一个用户需求，也应该在没有滚动网页时出现在索引末尾。"
  },
  {
    id: "history-assistant-tail",
    role: "assistant",
    text: "这是最后一个用户需求对应的回复。"
  }
]);

const largeHistoryPayload = createConversationPayload(
  Array.from({ length: 60 }, (_, index) => {
    const ordinal = index + 1;
    return [
      {
        id: `large-user-${ordinal}`,
        role: "user",
        text: `大型会话第 ${ordinal} 条用户需求，用于验证超过 50 条索引时头部、中部和尾部都可以跳转。`
      },
      {
        id: `large-assistant-${ordinal}`,
        role: "assistant",
        text: `大型会话第 ${ordinal} 条回复。`
      }
    ];
  }).flat()
);

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function findChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);

  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error("Chrome executable not found. Set CHROME_PATH to run E2E tests.");
  }
  return match;
}

function waitForProcessExit(childProcess, timeoutMs = 3000) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolveExit) => {
    const timeoutId = setTimeout(resolveExit, timeoutMs);
    childProcess.once("exit", () => {
      clearTimeout(timeoutId);
      resolveExit();
    });
  });
}

function createStaticServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://chatgpt.com");
    if (url.pathname === "/backend-api/conversation/full-history") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(fullHistoryPayload));
      return;
    }
    if (url.pathname === "/backend-api/conversation/large-history") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(largeHistoryPayload));
      return;
    }

    const safePath =
      url.pathname === "/" || url.pathname === "/c/full-history" || url.pathname === "/c/large-history"
        ? "/tests/fixtures/chatgpt-like.html"
        : url.pathname;
    const filePath = resolve(projectRoot, `.${safePath}`);

    if (!filePath.startsWith(projectRoot)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    try {
      const file = await readFile(filePath);
      const contentType = filePath.endsWith(".html")
        ? "text/html; charset=utf-8"
        : filePath.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "text/plain; charset=utf-8";
      response.writeHead(200, { "content-type": contentType });
      response.end(file);
    } catch (error) {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({ server, port: address.port });
    });
  });
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();

    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id && this.pending.has(payload.id)) {
        const { resolveMessage, rejectMessage } = this.pending.get(payload.id);
        this.pending.delete(payload.id);
        if (payload.error) {
          rejectMessage(new Error(payload.error.message));
        } else {
          resolveMessage(payload.result);
        }
        return;
      }

      const callbacks = this.events.get(payload.method) || [];
      callbacks.forEach((callback) => callback(payload.params));
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveMessage, rejectMessage) => {
      this.pending.set(id, { resolveMessage, rejectMessage });
    });
  }

  on(method, callback) {
    const callbacks = this.events.get(method) || [];
    callbacks.push(callback);
    this.events.set(method, callbacks);
  }

  close() {
    this.socket.close();
  }
}

async function waitForDevTools(port) {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  for (let index = 0; index < 80; index += 1) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        return response.json();
      }
    } catch (error) {
      await delay(150);
    }
  }
  throw new Error("Chrome DevTools endpoint did not start");
}

async function openPage(port, targetUrl) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`, {
    method: "PUT"
  });
  if (!response.ok) {
    throw new Error(`Failed to create tab: ${response.status}`);
  }
  return response.json();
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  }

  return result.result.value;
}

async function waitFor(client, expression, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await evaluate(client, expression);
    if (value) {
      return value;
    }
    await delay(120);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function main() {
  const { server, port: fixturePort } = await createStaticServer();
  const tmpRoot = join(projectRoot, ".tmp");
  await mkdir(tmpRoot, { recursive: true });
  const profileDir = await mkdtemp(join(tmpRoot, "chrome-profile-"));
  const debugPort = 43000 + Math.floor(Math.random() * 1000);
  const testUrl = `http://127.0.0.1:${fixturePort}/tests/fixtures/chatgpt-like.html`;

  const chromeArgs = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--window-size=1360,900",
    testUrl
  ];

  if (process.env.CI) {
    chromeArgs.unshift("--headless=new", "--disable-gpu");
  }

  const chrome = spawn(chromePath, chromeArgs, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let chromeOutput = "";
  chrome.stdout.on("data", (chunk) => {
    chromeOutput += chunk.toString();
  });
  chrome.stderr.on("data", (chunk) => {
    chromeOutput += chunk.toString();
  });

  let client;
  let injectionMode = "extension";

  try {
    await waitForDevTools(debugPort);
    const targetsBeforePage = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
    const page = await openPage(debugPort, testUrl);
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolveSocket, rejectSocket) => {
      socket.addEventListener("open", resolveSocket, { once: true });
      socket.addEventListener("error", rejectSocket, { once: true });
    });

    client = new CdpClient(socket);
    const pageErrors = [];
    client.on("Runtime.exceptionThrown", (params) => {
      pageErrors.push(params.exceptionDetails?.text || "Unknown runtime exception");
    });

    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Page.reload", { ignoreCache: true });
    await delay(800);
    const injectedByContentScript = await evaluate(client, "Boolean(document.querySelector('#chatgpt-timeline-search')?.shadowRoot)");
    if (!injectedByContentScript) {
      injectionMode = "test-runner";
      const contentScript = await readFile(join(projectRoot, "src/content.js"), "utf8");
      await client.send("Runtime.evaluate", {
        expression: contentScript,
        awaitPromise: true,
        returnByValue: true
      });
    }
    try {
      await waitFor(client, "Boolean(document.querySelector('#chatgpt-timeline-search')?.shadowRoot)");
    } catch (error) {
      const debugState = await evaluate(client, `(() => ({
        href: location.href,
        marker: document.documentElement.hasAttribute('data-gpt-timeline-test-page'),
        hasHost: Boolean(document.querySelector('#chatgpt-timeline-search')),
        title: document.title
      }))()`);
      const targetsAfterPage = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      console.error(JSON.stringify({
        debugState,
        targetTypes: targetsAfterPage.map((target) => `${target.type}:${target.url}`).slice(0, 8),
        initialTargetTypes: targetsBeforePage.map((target) => `${target.type}:${target.url}`).slice(0, 8),
        injectionMode,
        failures,
        chromeOutput: chromeOutput.slice(-2400)
      }, null, 2));
      throw error;
    }

    const initial = await evaluate(client, `(() => {
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
      return {
        title: root.querySelector('.title strong')?.textContent,
        subtitle: root.querySelector('.title span')?.textContent,
        cards: root.querySelectorAll('.panel [data-jump-id]').length,
        railMarks: root.querySelectorAll('.rail-mark').length,
        ordinals: Array.from(root.querySelectorAll('.ordinal')).map((node) => node.textContent),
        pinned: root.querySelector('.dock')?.classList.contains('is-pinned')
      };
    })()`);

    assert(initial.title === "时间轴", "Panel title should render");
    assert(initial.subtitle.includes("4 条用户需求已索引"), "Default title should count indexed user requests");
    assert(initial.subtitle.includes("当前显示 4 条"), "Default view should show all loaded user messages");
    assert(initial.cards === 4, "Default list should contain all 4 user cards");
    assert(initial.railMarks === 4, "Default rail should contain all 4 user markers");
    assert(initial.ordinals.join(",") === "#1,#2,#3,#4", "Default user-request ordinals should be continuous");
    assert(initial.pinned === false, "Panel should not be pinned open by default");

    const dockGeometry = await evaluate(client, `(() => {
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
      const rect = root.querySelector('.dock').getBoundingClientRect();
      return {
        heightRatio: rect.height / window.innerHeight,
        centerDelta: Math.abs((rect.top + rect.height / 2) - window.innerHeight / 2)
      };
    })()`);

    assert(dockGeometry.heightRatio > 0.25 && dockGeometry.heightRatio < 0.42, "Collapsed rail should stay near one third of the viewport height");
    assert(dockGeometry.centerDelta < 2, "Collapsed rail should be vertically centered");

    const staleReferenceJumpState = await evaluate(client, `(() => {
      const articles = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
      articles.forEach((article) => {
        article.replaceWith(article.cloneNode(true));
      });
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
      root.querySelector('.panel [data-jump-id]').click();
      const userTarget = document.querySelector('[data-testid="conversation-turn-1"]');
      return userTarget.getAttribute('data-gpt-timeline-search-hit');
    })()`);

    assert(staleReferenceJumpState === "true", "Jump should refresh stale DOM references after the page rerenders with the same messages");

    const imeState = await evaluate(client, `new Promise((resolve) => {
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
      const input = root.querySelector('.search-input');
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'huihua' }));
      input.value = 'huihua';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'huihua', isComposing: true }));
      const duringComposition = {
        value: root.querySelector('.search-input').value,
        cards: root.querySelectorAll('.panel [data-jump-id]').length
      };
      input.value = '超长';
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '超长' }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '超长' }));
      setTimeout(() => {
        resolve({
          duringComposition,
          value: root.querySelector('.search-input').value,
          cards: root.querySelectorAll('.panel [data-jump-id]').length,
          text: root.querySelector('.text')?.textContent || ''
        });
      }, 260);
    })`);

    assert(imeState.duringComposition.value === "huihua", "IME composition should keep the composing pinyin in the input");
    assert(imeState.duringComposition.cards === 4, "IME composition should not rerender/filter while composing");
    assert(imeState.value === "超长", "IME composition should commit the final Chinese text");
    assert(imeState.cards === 1, "Committed Chinese search should filter results");
    assert(imeState.text.includes("超长"), "Committed Chinese search should show a Chinese match");

    await evaluate(client, `new Promise((resolve) => {
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
      const input = root.querySelector('.search-input');
      input.value = '';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '' }));
      setTimeout(resolve, 220);
    })`);

    const hiddenAssistantSearchState = await evaluate(client, `new Promise((resolve) => {
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
      const input = root.querySelector('.search-input');
      input.value = 'timeline anchors';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        resolve({
          subtitle: root.querySelector('.title span')?.textContent,
          cards: root.querySelectorAll('.panel [data-jump-id]').length,
          empty: root.querySelector('.empty')?.textContent || '',
          text: root.querySelector('.text')?.textContent || ''
        });
      }, 220);
    })`);

    assert(hiddenAssistantSearchState.subtitle.includes("0 条匹配"), "Assistant-only text should not match in default user-only mode");
    assert(hiddenAssistantSearchState.cards === 0, "Default search should hide assistant-only matches");
    assert(hiddenAssistantSearchState.empty.includes("没有找到匹配内容"), "Default assistant-only search should show empty state");

    const searchState = await evaluate(client, `new Promise((resolve) => {
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
      root.querySelector('[data-action="toggle-assistant"]').click();
      const input = root.querySelector('.search-input');
      input.value = 'timeline anchors';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        resolve({
          subtitle: root.querySelector('.title span')?.textContent,
          cards: root.querySelectorAll('.panel [data-jump-id]').length,
          railMarks: root.querySelectorAll('.rail-mark').length,
          text: root.querySelector('.text')?.textContent
        });
      }, 220);
    })`);

    assert(searchState.subtitle.includes("1 条匹配"), "Search should find exactly one timeline anchors match after assistant toggle");
    assert(searchState.cards === 1, "Search result list should reduce to one card after assistant toggle");
    assert(searchState.railMarks === 8, "Rail should include all user and assistant markers after assistant toggle");
    assert(searchState.text.includes("timeline anchors"), "Search result should show matching snippet");

    const jumpState = await evaluate(client, `(() => {
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
      root.querySelector('.panel [data-jump-id]').click();
      const userTarget = document.querySelector('[data-testid="conversation-turn-1"]');
      const assistantTarget = document.querySelector('[data-testid="conversation-turn-2"]');
      return {
        userHit: userTarget.getAttribute('data-gpt-timeline-search-hit'),
        assistantHit: assistantTarget.getAttribute('data-gpt-timeline-search-hit')
      };
    })()`);

    assert(jumpState.userHit === "true", "Clicking an assistant result should jump to the round's user message");
    assert(jumpState.assistantHit !== "true", "Assistant result should not highlight the assistant answer as the round start");

    const userJumpState = await evaluate(client, `new Promise((resolve) => {
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
      const input = root.querySelector('.search-input');
      input.value = '区分我';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        root.querySelector('.panel [data-jump-id]').click();
        const target = document.querySelector('[data-testid="conversation-turn-2"]');
        const userTarget = document.querySelector('[data-testid="conversation-turn-3"]');
        resolve({
          previousAssistantHit: target.getAttribute('data-gpt-timeline-search-hit'),
          userHit: userTarget.getAttribute('data-gpt-timeline-search-hit')
        });
      }, 220);
    })`);

    assert(userJumpState.userHit === "true", "Clicking a user result should jump to that exact user message");

    const filterState = await evaluate(client, `new Promise((resolve) => {
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
      root.querySelector('[data-action="toggle-assistant"]').click();
      const input = root.querySelector('.search-input');
      input.value = '搜索';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => {
        resolve({
          subtitle: root.querySelector('.title span')?.textContent,
          badges: Array.from(root.querySelectorAll('.badge')).map((badge) => badge.textContent)
        });
      }, 220);
    })`);

    assert(filterState.subtitle.includes("2 条匹配"), "User-only mode should show two matching user messages");
    assert(filterState.badges.every((badge) => badge === "我"), "Default cards should all be user messages");

    const timelineState = await evaluate(client, `(() => {
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
      return {
        timelineItems: root.querySelectorAll('.panel [data-jump-id]').length,
        railMarks: root.querySelectorAll('.rail-mark').length
      };
    })()`);

    assert(timelineState.timelineItems === 2, "Search result list should include all matching user messages");
    assert(timelineState.railMarks === 4, "Rail should stay all-user by default");

    const prependedOrderState = await evaluate(client, `new Promise((resolve) => {
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
      root.querySelector('[data-action="clear"]').click();
      const main = document.querySelector('main');
      main.insertAdjacentHTML('afterbegin', \`
        <article data-testid="conversation-turn-prepended">
          <div data-message-author-role="user">
            更早加载出来的用户需求，应该显示在时间轴最前面。
          </div>
        </article>
      \`);
      root.querySelector('[data-action="refresh"]').click();
      setTimeout(() => {
        resolve({
          subtitle: root.querySelector('.title span')?.textContent,
          firstText: root.querySelector('.text')?.textContent || '',
          ordinals: Array.from(root.querySelectorAll('.ordinal')).slice(0, 3).map((node) => node.textContent)
        });
      }, 1800);
    })`);

    assert(prependedOrderState.subtitle.includes("5 条用户需求已索引"), "Late prepended user messages should be added to the default index count");
    assert(prependedOrderState.firstText.includes("更早加载出来的用户需求"), "Late prepended messages should appear before the original conversation turns");
    assert(prependedOrderState.ordinals.join(",") === "#1,#2,#3", "Timeline ordinals should be recalculated continuously after prepending older messages");

    const longListScrollState = await evaluate(client, `new Promise((resolve) => {
      const main = document.querySelector('main');
      main.insertAdjacentHTML('beforeend', Array.from({ length: 12 }, (_, index) => \`
        <article data-testid="conversation-turn-scroll-\${index + 1}">
          <div data-message-author-role="user">
            滚动测试第 \${index + 1} 条用户需求，用于确认弹出小框可以完整滚动查询。
          </div>
        </article>
      \`).join(''));
      document.querySelector('#chatgpt-timeline-search').shadowRoot.querySelector('[data-action="refresh"]').click();
      setTimeout(() => {
        const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
        const content = root.querySelector('.content');
        content.scrollTop = content.scrollHeight;
        resolve({
          cards: root.querySelectorAll('.panel [data-jump-id]').length,
          railMarks: root.querySelectorAll('.rail-mark').length,
          canScroll: content.scrollHeight > content.clientHeight,
          scrollTop: content.scrollTop,
          lastText: Array.from(root.querySelectorAll('.text')).at(-1)?.textContent || ''
        });
      }, 1800);
    })`);

    assert(longListScrollState.cards >= 17, "Panel list should render more than ten user-request indexes");
    assert(longListScrollState.railMarks === 8, "Collapsed rail should cap visual markers at eight for long conversations");
    assert(longListScrollState.canScroll, "Panel content should expose an internal scroll area for long indexes");
    assert(longListScrollState.scrollTop > 0, "Panel content should allow scrolling through the full index");
    assert(longListScrollState.lastText.includes("滚动测试第 12 条用户需求"), "Panel should keep later indexes reachable after scrolling");

    const fullHistoryState = await evaluate(client, `new Promise((resolve) => {
      history.pushState({}, '', '/c/full-history');
      const main = document.querySelector('main');
      main.innerHTML = \`
        <article data-testid="conversation-turn-1">
          <div data-message-author-role="user" data-message-id="fixture-user-1">
            我需要一个网页插件，在超长 ChatGPT 会话中搜索关键内容。
          </div>
        </article>
        <article data-testid="conversation-turn-2">
          <div data-message-author-role="assistant" data-message-id="fixture-assistant-1">
            <div class="markdown"><p>可以做一个时间轴面板，按消息顺序建立 timeline anchors，并支持关键词查找。</p></div>
          </div>
        </article>
        <article data-testid="conversation-turn-7">
          <div data-message-author-role="user" data-message-id="fixture-user-4">
            点击时间轴时，请准确跳转到本轮对话的用户需求起始处。
          </div>
        </article>
        <article data-testid="conversation-turn-8">
          <div data-message-author-role="assistant" data-message-id="fixture-assistant-4">
            <div class="markdown"><p>即使点击的是 ChatGPT 回复，也应该定位到这一轮最开始的用户问题。</p></div>
          </div>
        </article>
      \`;
      setTimeout(() => {
        const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
        const texts = Array.from(root.querySelectorAll('.text')).map((node) => node.textContent);
        resolve({
          subtitle: root.querySelector('.title span')?.textContent,
          cards: root.querySelectorAll('.panel [data-jump-id]').length,
          railMarks: root.querySelectorAll('.rail-mark').length,
          ordinals: Array.from(root.querySelectorAll('.ordinal')).map((node) => node.textContent),
          texts
        });
      }, 3200);
    })`);

    assert(fullHistoryState.subtitle.includes("6 条用户需求已索引"), "Full history fetch should index every user request before page scrolling");
    assert(fullHistoryState.subtitle.includes("当前显示 6 条"), "Default full history view should show every indexed user request");
    assert(fullHistoryState.cards === 6, "Full history view should render all user-request cards, not only visible DOM messages");
    assert(fullHistoryState.railMarks === 6, "Full history rail should include every user request");
    assert(fullHistoryState.ordinals.join(",") === "#1,#2,#3,#4,#5,#6", "Full history ordinals should be continuous from start to end");
    assert(fullHistoryState.texts.some((text) => text.includes("中间用户需求")), "Full history should include user requests missing from the current DOM");
    assert(fullHistoryState.texts.at(-1)?.includes("最后一个用户需求"), "Full history should include tail user requests before manual page scrolling");

    const middleJumpState = await evaluate(client, `new Promise((resolve) => {
      const main = document.querySelector('main');
      main.insertAdjacentHTML('beforeend', '<div data-testid="virtual-scroll-space" style="height: 5200px;"></div>');
      let inserted = false;
      const scrollPositions = [];
      const trackScroll = () => scrollPositions.push(window.scrollY);
      const insertTarget = () => {
        trackScroll();
        if (inserted || window.scrollY < 900) {
          return;
        }
        inserted = true;
        const anchor = document.querySelector('[data-testid="conversation-turn-7"]');
        anchor.insertAdjacentHTML('beforebegin', \`
          <article data-testid="conversation-turn-history-middle">
            <div data-message-author-role="user" data-message-id="history-user-missing-middle">
              这是完整历史接口里的中间用户需求，当前页面 DOM 没有加载出来，但时间轴必须显示。
            </div>
          </article>
        \`);
        window.removeEventListener('scroll', insertTarget);
        window.addEventListener('scroll', trackScroll);
      };
      window.addEventListener('scroll', insertTarget);
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
      const button = Array.from(root.querySelectorAll('.panel [data-jump-id]')).find((node) => node.getAttribute('data-jump-id') === 'history-user-missing-middle');
      button.click();
      setTimeout(() => {
        window.removeEventListener('scroll', insertTarget);
        window.removeEventListener('scroll', trackScroll);
        const target = document.querySelector('[data-testid="conversation-turn-history-middle"]');
        const directionChanges = scrollPositions.reduce((changes, value, index, list) => {
          if (index < 2) {
            return changes;
          }
          const previousDelta = list[index - 1] - list[index - 2];
          const currentDelta = value - list[index - 1];
          if (Math.abs(previousDelta) < 5 || Math.abs(currentDelta) < 5) {
            return changes;
          }
          return Math.sign(previousDelta) === Math.sign(currentDelta) ? changes : changes + 1;
        }, 0);
        resolve({
          exists: Boolean(target),
          hit: target?.getAttribute('data-gpt-timeline-search-hit') || null,
          scrollY: window.scrollY,
          directionChanges
        });
      }, 1400);
    })`);

    assert(middleJumpState.exists, "Clicking a middle full-history index should scroll until the missing DOM message is rendered");
    assert(middleJumpState.hit === "true", "Clicking a middle full-history index should highlight the loaded target message");
    assert(middleJumpState.scrollY > 100, "Middle index jump should move away from the top when the target is not initially rendered");
    assert(middleJumpState.directionChanges <= 1, "Middle index jump should avoid visible up-down probing");

    const stableFullHistoryState = await evaluate(client, `new Promise((resolve) => {
      const main = document.querySelector('main');
      const anchor = document.querySelector('[data-testid="conversation-turn-7"]');
      anchor.insertAdjacentHTML('beforebegin', \`
        <article data-testid="conversation-turn-late-middle">
          <div data-message-author-role="user">
            这是 DOM 后来才出现的中间历史用户需求，不应该被当作新增消息插进完整索引。
          </div>
        </article>
      \`);
      main.insertAdjacentHTML('beforeend', \`
        <article data-testid="conversation-turn-new-user">
          <div data-message-author-role="user" data-message-id="new-user-after-history">
            这是用户刚刚新发送的消息，应该追加到完整索引末尾。
          </div>
        </article>
      \`);
      setTimeout(() => {
        const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
        const texts = Array.from(root.querySelectorAll('.text')).map((node) => node.textContent);
        resolve({
          subtitle: root.querySelector('.title span')?.textContent,
          cards: root.querySelectorAll('.panel [data-jump-id]').length,
          ordinals: Array.from(root.querySelectorAll('.ordinal')).map((node) => node.textContent),
          texts
        });
      }, 1200);
    })`);

    assert(stableFullHistoryState.subtitle.includes("7 条用户需求已索引"), "Only true new user messages should append after a complete history index");
    assert(stableFullHistoryState.cards === 7, "Middle DOM-only historical messages should not create extra timeline cards");
    assert(stableFullHistoryState.ordinals.join(",") === "#1,#2,#3,#4,#5,#6,#7", "Appended new user messages should keep continuous ordinals");
    assert(stableFullHistoryState.texts.some((text) => text.includes("刚刚新发送的消息")), "New user messages should append to the end of the timeline");
    assert(!stableFullHistoryState.texts.some((text) => text.includes("后来才出现的中间历史用户需求")), "DOM-only middle history should not disturb a complete history index");

    const largeHistoryState = await evaluate(client, `new Promise((resolve) => {
      history.pushState({}, '', '/c/large-history');
      const main = document.querySelector('main');
      main.style.position = 'relative';
      main.innerHTML = '<div id="large-virtual-space" style="height: 24000px;"></div>';

      const targetUsers = [1, 30, 60];
      const rendered = new Set();
      const articleFor = (ordinal) => {
        const maxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const top = Math.round(maxTop * (((ordinal - 1) * 2) / 119)) + 120;
        return \`
          <article data-testid="conversation-turn-large-\${ordinal}" style="position:absolute;left:0;right:0;top:\${top}px;">
            <div data-message-author-role="user" data-message-id="large-user-\${ordinal}">
              大型会话第 \${ordinal} 条用户需求，用于验证超过 50 条索引时头部、中部和尾部都可以跳转。
            </div>
          </article>
        \`;
      };

      const renderNearby = () => {
        const maxTop = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        targetUsers.forEach((ordinal) => {
          if (rendered.has(ordinal)) {
            return;
          }
          const expectedTop = maxTop * (((ordinal - 1) * 2) / 119);
          if (Math.abs(window.scrollY - expectedTop) < 2500 || (ordinal === 1 && window.scrollY < 300)) {
            rendered.add(ordinal);
            main.insertAdjacentHTML('beforeend', articleFor(ordinal));
          }
        });
      };

      window.__renderLargeTarget = (ordinal) => {
        const maxTop = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        const expectedTop = maxTop * (((ordinal - 1) * 2) / 119);
        const nearTailFallback = ordinal === 60 && window.scrollY > maxTop * 0.88;
        if (!rendered.has(ordinal) && (Math.abs(window.scrollY - expectedTop) < 2500 || nearTailFallback)) {
          rendered.add(ordinal);
          main.insertAdjacentHTML('beforeend', articleFor(ordinal));
        }
      };
      window.addEventListener('scroll', renderNearby);
      window.__largeHistoryCleanup = () => {
        window.removeEventListener('scroll', renderNearby);
        delete window.__renderLargeTarget;
      };
      renderNearby();

      setTimeout(() => {
        const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
        resolve({
          subtitle: root.querySelector('.title span')?.textContent,
          cards: root.querySelectorAll('.panel [data-jump-id]').length,
          railMarks: root.querySelectorAll('.rail-mark').length,
          ordinals: Array.from(root.querySelectorAll('.ordinal')).slice(0, 5).map((node) => node.textContent),
          lastOrdinal: Array.from(root.querySelectorAll('.ordinal')).at(-1)?.textContent || ''
        });
      }, 3600);
    })`);

    assert(largeHistoryState.subtitle.includes("60 条用户需求已索引"), "Large full history should index more than 50 user requests");
    assert(largeHistoryState.subtitle.includes("当前显示 60 条"), "Large full history should show every indexed user request in the panel");
    assert(largeHistoryState.cards === 60, "Large full history should render all 60 user-request cards");
    assert(largeHistoryState.railMarks === 8, "Large full history should keep the rail capped at eight markers");
    assert(largeHistoryState.ordinals.join(",") === "#1,#2,#3,#4,#5", "Large full history should start with continuous ordinals");
    assert(largeHistoryState.lastOrdinal === "#60", "Large full history should end at the correct ordinal");

    const largeJumpState = await evaluate(client, `new Promise(async (resolve) => {
      const results = [];
      const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;

      async function clickAndWait(ordinal) {
        const button = Array.from(root.querySelectorAll('.panel [data-jump-id]')).find((node) => node.getAttribute('data-jump-id') === 'large-user-' + ordinal);
        const positions = [];
        const trackScroll = () => positions.push(window.scrollY);
        window.addEventListener('scroll', trackScroll);
        button.click();
        let target = null;
        let hit = null;
        const startedAt = Date.now();
        while (Date.now() - startedAt < 3000) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
          window.__renderLargeTarget?.(ordinal);
          target = document.querySelector('[data-testid="conversation-turn-large-' + ordinal + '"]');
          hit = target?.getAttribute('data-gpt-timeline-search-hit') || null;
          if (target && hit === 'true') {
            break;
          }
        }
        window.removeEventListener('scroll', trackScroll);
        const directionChanges = positions.reduce((changes, value, index, list) => {
          if (index < 2) {
            return changes;
          }
          const previousDelta = list[index - 1] - list[index - 2];
          const currentDelta = value - list[index - 1];
          if (Math.abs(previousDelta) < 5 || Math.abs(currentDelta) < 5) {
            return changes;
          }
          return Math.sign(previousDelta) === Math.sign(currentDelta) ? changes : changes + 1;
        }, 0);
        results.push({
          ordinal,
          exists: Boolean(target),
          hit,
          scrollY: window.scrollY,
          directionChanges
        });
      }

      await clickAndWait(1);
      await clickAndWait(30);
      await clickAndWait(60);
      window.__largeHistoryCleanup?.();
      resolve(results);
    })`);

    const largeJumpHead = largeJumpState.find((result) => result.ordinal === 1);
    const largeJumpMiddle = largeJumpState.find((result) => result.ordinal === 30);
    const largeJumpTail = largeJumpState.find((result) => result.ordinal === 60);

    assert(largeJumpHead?.exists && largeJumpHead.hit === "true", "Large history head index should jump and highlight correctly");
    assert(largeJumpMiddle?.exists && largeJumpMiddle.hit === "true", "Large history middle index should jump and highlight correctly");
    assert(largeJumpTail?.exists && largeJumpTail.hit === "true", "Large history tail index should jump and highlight correctly");
    assert(largeJumpMiddle.directionChanges <= 1, "Large history middle jump should avoid visible up-down probing");
    assert(largeJumpTail.scrollY > largeJumpMiddle.scrollY, "Large history tail jump should land after the middle jump");

    const noAutoScrollState = await evaluate(client, `new Promise((resolve) => {
      history.pushState({}, '', '/c/no-history-endpoint');
      const main = document.querySelector('main');
      main.innerHTML = Array.from({ length: 30 }, (_, index) => \`
        <article data-testid="conversation-turn-no-history-\${index + 1}">
          <div data-message-author-role="user" data-message-id="no-history-user-\${index + 1}">
            没有完整历史接口时的当前 DOM 用户需求 \${index + 1}。
          </div>
        </article>
      \`).join('');
      window.scrollTo({ top: 640, behavior: 'auto' });
      const before = window.scrollY;
      setTimeout(() => {
        const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
        resolve({
          before,
          after: window.scrollY,
          cards: root.querySelectorAll('.panel [data-jump-id]').length,
          railMarks: root.querySelectorAll('.rail-mark').length
        });
      }, 2600);
    })`);

    assert(Math.abs(noAutoScrollState.after - noAutoScrollState.before) < 4, "Automatic indexing should not scroll the page when full history fetch fails");
    assert(noAutoScrollState.cards === 30, "Fallback DOM indexing should still read currently loaded user messages");
    assert(noAutoScrollState.railMarks === 8, "Rail marker cap should also apply to fallback DOM indexes");

    const routeSwitchState = await evaluate(client, `new Promise((resolve) => {
      history.pushState({}, '', '/tests/fixtures/chatgpt-like.html?conversation=second');
      const main = document.querySelector('main');
      main.innerHTML = \`
        <article data-testid="conversation-turn-second-1">
          <div data-message-author-role="user" data-message-id="second-user-1">
            第二个会话里的第一个用户需求，需要重新抓取。
          </div>
        </article>
        <article data-testid="conversation-turn-second-2">
          <div data-message-author-role="assistant" data-message-id="second-assistant-1">
            <div class="markdown">
              <p>第二个会话里的 GPT 回复，不应该混入上一个会话的内容。</p>
            </div>
          </div>
        </article>
      \`;
      setTimeout(() => {
        const root = document.querySelector('#chatgpt-timeline-search').shadowRoot;
        const texts = Array.from(root.querySelectorAll('.text')).map((node) => node.textContent);
        resolve({
          subtitle: root.querySelector('.title span')?.textContent,
          cards: root.querySelectorAll('.panel [data-jump-id]').length,
          railMarks: root.querySelectorAll('.rail-mark').length,
          texts,
          hasOldConversationText: texts.some((text) => text.includes('超长 ChatGPT 会话') || text.includes('区分我和 ChatGPT'))
        });
      }, 1400);
    })`);

    assert(routeSwitchState.subtitle.includes("1 条用户需求已索引"), "Route switch should rebuild the user-request index for the new conversation");
    assert(routeSwitchState.subtitle.includes("当前显示 1 条"), "Route switch should default to the new conversation's user messages");
    assert(routeSwitchState.cards === 1, "Route switch should remove old conversation cards");
    assert(routeSwitchState.railMarks === 1, "Route switch should remove old conversation rail markers");
    assert(routeSwitchState.texts[0]?.includes("第二个会话里的第一个用户需求"), "Route switch should show the new conversation user request");
    assert(routeSwitchState.hasOldConversationText === false, "Route switch should not mix old conversation content into the new timeline");

    assert(pageErrors.length === 0, `Page should not throw runtime errors: ${pageErrors.join("; ")}`);

    if (failures.length) {
      console.error(failures.map((failure) => `- ${failure}`).join("\n"));
      process.exitCode = 1;
      return;
    }

    console.log(`Chrome extension E2E passed (${injectionMode})`);
  } finally {
    if (client) {
      client.close();
    }
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome);
    server.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
