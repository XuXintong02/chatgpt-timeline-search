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
    const safePath = url.pathname === "/" ? "/tests/fixtures/chatgpt-like.html" : url.pathname;
    const filePath = resolve(projectRoot, `.${safePath}`);

    if (!filePath.startsWith(projectRoot)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    try {
      const file = await readFile(filePath);
      response.writeHead(200, {
        "content-type": filePath.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain"
      });
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
        pinned: root.querySelector('.dock')?.classList.contains('is-pinned')
      };
    })()`);

    assert(initial.title === "时间轴", "Panel title should render");
    assert(initial.subtitle.includes("8 条已索引"), "Should index 8 fixture messages");
    assert(initial.subtitle.includes("当前显示 4 条"), "Default view should show all loaded user messages");
    assert(initial.cards === 4, "Default list should contain all 4 user cards");
    assert(initial.railMarks === 4, "Default rail should contain all 4 user markers");
    assert(initial.pinned === false, "Panel should not be pinned open by default");

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

    assert(routeSwitchState.subtitle.includes("2 条已索引"), "Route switch should rebuild the index for the new conversation");
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
