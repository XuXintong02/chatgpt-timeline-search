const URL_PATTERNS = [
  /^https:\/\/chatgpt\.com\//,
  /^https:\/\/chat\.openai\.com\//
];

function canInject(url = "") {
  return URL_PATTERNS.some((pattern) => pattern.test(url));
}

async function ensureContentScript(tabId, url) {
  if (!tabId || !canInject(url)) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content.js"]
    });
  } catch (error) {
    // The tab may be gone, protected by Chrome, or still navigating.
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) {
    return;
  }

  ensureContentScript(tabId, tab.url);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  await ensureContentScript(tab.id, tab.url);

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "GPT_TIMELINE_TOGGLE"
    });
  } catch (error) {
    // The content script is only available on ChatGPT conversation pages.
  }
});
