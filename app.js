const FIREBASE_API_ROOT = "https://hacker-news.firebaseio.com/v0/item";
const ALGOLIA_API_ROOT = "https://hn.algolia.com/api/v1/items";
const DEFAULT_ITEM_ID = "48537641";
const MAX_COMMENTS = 280;
const FETCH_CONCURRENCY = 10;

const itemCache = new Map();
const threadCache = new Map();
let activeAbort = null;
let currentThread = null;
let currentView = "all";

const form = document.querySelector("#reader-form");
const urlInput = document.querySelector("#hn-url");
const statusLine = document.querySelector("#status-line");
const storyEl = document.querySelector("#story");
const commentsEl = document.querySelector("#comments");
const commentSummary = document.querySelector("#comment-summary");
const metaList = document.querySelector("#meta-list");
const themeToggle = document.querySelector("#theme-toggle");
const focusButton = document.querySelector("#focus-button");
const densityToggle = document.querySelector("#density-toggle");
const focusToggle = document.querySelector("#focus-toggle");
const commentView = document.querySelector("#comment-view");

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});
const numberFormatter = new Intl.NumberFormat();
const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const icons = {
  collapse: `
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m6 9 6 6 6-6"></path>
    </svg>
  `,
  link: `
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
    </svg>
  `
};

init();

function init() {
  const savedDensity = localStorage.getItem("readable-hn-density") === "compact";
  const savedFocus = localStorage.getItem("readable-hn-focus") === "on";
  densityToggle.checked = savedDensity;
  document.documentElement.classList.toggle("is-compact", savedDensity);
  setFocus(savedFocus);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    loadThread(urlInput.value);
  });

  themeToggle.addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
  });

  focusButton.addEventListener("click", () => {
    setFocus(!document.documentElement.classList.contains("is-focus"));
  });

  densityToggle.addEventListener("change", () => {
    document.documentElement.classList.toggle("is-compact", densityToggle.checked);
    localStorage.setItem("readable-hn-density", densityToggle.checked ? "compact" : "comfortable");
  });

  focusToggle.addEventListener("change", () => {
    setFocus(focusToggle.checked);
  });

  commentView.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button) return;
    currentView = button.dataset.view;
    updateCommentViewButtons();
    renderComments();
  });

  commentsEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-collapse-comment]");
    if (!button) return;

    const comment = button.closest(".comment");
    const isCollapsed = comment.classList.toggle("is-collapsed");
    button.setAttribute("aria-expanded", String(!isCollapsed));
    button.title = isCollapsed ? "Expand replies" : "Collapse replies";
  });

  const initialId = getInitialItemId();
  urlInput.value = toHnUrl(initialId);
  setTheme(document.documentElement.dataset.theme || "light");
  renderLoading();
  loadThread(initialId);
}

function getInitialItemId() {
  const hashMatch = window.location.hash.match(/(?:item|id)=([0-9]+)/);
  if (hashMatch) return hashMatch[1];

  const queryId = new URLSearchParams(window.location.search).get("id");
  if (queryId && /^[0-9]+$/.test(queryId)) return queryId;

  return DEFAULT_ITEM_ID;
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("readable-hn-theme", theme);
  themeToggle.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
  themeToggle.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

function setFocus(isEnabled) {
  document.documentElement.classList.toggle("is-focus", isEnabled);
  focusToggle.checked = isEnabled;
  focusButton.setAttribute("aria-pressed", String(isEnabled));
  focusButton.setAttribute("aria-label", isEnabled ? "Exit focus mode" : "Enter focus mode");
  focusButton.title = isEnabled ? "Exit focus mode" : "Enter focus mode";
  localStorage.setItem("readable-hn-focus", isEnabled ? "on" : "off");
}

async function loadThread(rawInput) {
  const itemId = extractItemId(rawInput);
  if (!itemId) {
    showError("That does not look like a Hacker News item URL.");
    return;
  }

  if (activeAbort) activeAbort.abort();
  activeAbort = new AbortController();
  const { signal } = activeAbort;

  window.history.replaceState(null, "", `#item=${itemId}`);
  urlInput.value = toHnUrl(itemId);
  currentThread = null;
  renderLoading();
  setStatus("Loading thread snapshot...");

  try {
    const thread = await fetchThreadViaAlgolia(itemId, signal);
    if (signal.aborted) return;

    currentThread = thread;
    renderStory(thread.story);
    renderMeta();
    renderComments();
    setStatus(
      `Ready: ${formatCount(thread.loadedComments)}${thread.truncated ? "+" : ""} comments`,
      "ready"
    );
  } catch (snapshotError) {
    if (snapshotError.name === "AbortError") return;
    await loadThreadViaFirebase(itemId, signal);
  }
}

async function loadThreadViaFirebase(itemId, signal) {
  setStatus("Snapshot unavailable. Reading live HN tree...");

  try {
    const story = await fetchItem(itemId, signal);
    if (signal.aborted) return;

    renderStory(story);
    setStatus("Reading the conversation...");

    const fetchState = {
      count: 0,
      total: story.descendants || 0,
      truncated: false,
      lastUpdate: 0
    };

    const comments = await loadComments(story.kids || [], 0, fetchState, signal);
    if (signal.aborted) return;

    currentThread = {
      story,
      comments,
      loadedComments: fetchState.count,
      truncated: fetchState.truncated
    };

    renderMeta();
    renderComments();
    setStatus(
      `Ready: ${formatCount(fetchState.count)}${fetchState.truncated ? "+" : ""} comments`,
      "ready"
    );
  } catch (error) {
    if (error.name === "AbortError") return;
    showError(error.message || "Something went wrong while loading that thread.");
  }
}

function extractItemId(rawInput) {
  const value = String(rawInput || "").trim();
  if (/^[0-9]+$/.test(value)) return value;

  try {
    const parsed = new URL(value);
    const id = parsed.searchParams.get("id");
    if (id && /^[0-9]+$/.test(id)) return id;
  } catch {
    const match = value.match(/(?:item\?id=|[?&]id=|#(?:item|id)=)([0-9]+)/);
    if (match) return match[1];
  }

  return null;
}

function toHnUrl(itemId) {
  return `https://news.ycombinator.com/item?id=${itemId}`;
}

async function fetchItem(itemId, signal) {
  const key = String(itemId);
  if (itemCache.has(key)) return itemCache.get(key);

  const request = fetch(`${FIREBASE_API_ROOT}/${key}.json`, { signal })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Hacker News returned ${response.status} for item ${key}.`);
      }
      return response.json();
    })
    .then((item) => {
      if (!item) {
        throw new Error(`Hacker News item ${key} was not found.`);
      }
      return item;
    })
    .catch((error) => {
      itemCache.delete(key);
      throw error;
    });

  itemCache.set(key, request);
  return request;
}

async function fetchThreadViaAlgolia(itemId, signal) {
  const key = String(itemId);
  if (threadCache.has(key)) return threadCache.get(key);

  const snapshotRequest = fetch(`${ALGOLIA_API_ROOT}/${key}`, { signal })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HN snapshot returned ${response.status} for item ${key}.`);
      }
      return response.json();
    });
  const liveStoryRequest = fetchItem(key, signal).catch((error) => {
    if (error.name === "AbortError") throw error;
    return null;
  });

  const request = Promise.all([snapshotRequest, liveStoryRequest])
    .then(([item, liveStory]) => {
      if (!item || !item.id) {
        throw new Error(`HN snapshot item ${key} was not found.`);
      }

      const totalComments = countAlgoliaNodes(item.children || []);
      const state = { count: 0, truncated: false };
      const comments = sortByKnownOrder(
        normalizeAlgoliaComments(item.children || [], 0, state),
        liveStory?.kids || []
      );

      return {
        story: {
          id: Number(liveStory?.id || item.id),
          by: liveStory?.by || item.author || "unknown",
          descendants: liveStory?.descendants ?? totalComments,
          score: liveStory?.score ?? item.points ?? 0,
          time: liveStory?.time || item.created_at_i || toUnixSeconds(item.created_at),
          title: liveStory?.title || item.title || "Untitled Hacker News item",
          type: liveStory?.type || item.type || "story",
          url: liveStory?.url || item.url || "",
          text: liveStory?.text || item.text || ""
        },
        comments,
        loadedComments: state.count,
        truncated: state.truncated,
        source: "snapshot"
      };
    })
    .catch((error) => {
      threadCache.delete(key);
      throw error;
    });

  threadCache.set(key, request);
  return request;
}

function sortByKnownOrder(nodes, orderedIds) {
  if (!orderedIds.length) return nodes;

  const order = new Map(orderedIds.map((id, index) => [Number(id), index]));
  return [...nodes].sort((first, second) => {
    const firstOrder = order.get(first.id) ?? Number.MAX_SAFE_INTEGER;
    const secondOrder = order.get(second.id) ?? Number.MAX_SAFE_INTEGER;
    return firstOrder - secondOrder;
  });
}

function normalizeAlgoliaComments(items, depth, state) {
  const nodes = [];

  for (const item of items) {
    if (state.count >= MAX_COMMENTS) {
      state.truncated = true;
      break;
    }

    if (!item || item.type !== "comment") continue;

    state.count += 1;
    const children = normalizeAlgoliaComments(item.children || [], depth + 1, state);
    nodes.push({
      id: Number(item.id),
      by: item.author || "unknown",
      time: item.created_at_i || toUnixSeconds(item.created_at),
      text: item.text || "",
      depth,
      children
    });
  }

  return nodes;
}

function countAlgoliaNodes(items) {
  return items.reduce((total, item) => {
    if (!item || item.type !== "comment") return total;
    return total + 1 + countAlgoliaNodes(item.children || []);
  }, 0);
}

async function loadComments(ids, depth, state, signal) {
  if (!ids.length || state.count >= MAX_COMMENTS) return [];

  const remaining = Math.max(0, MAX_COMMENTS - state.count);
  const idsToFetch = ids.slice(0, remaining + 20);
  if (idsToFetch.length < ids.length) state.truncated = true;

  const rawItems = await mapLimit(idsToFetch, FETCH_CONCURRENCY, async (id) => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fetchItem(id, signal);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      return null;
    }
  });

  const nodes = [];
  for (const item of rawItems) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (state.count >= MAX_COMMENTS) {
      state.truncated = true;
      break;
    }

    const node = await normalizeComment(item, depth, state, signal);
    if (node) nodes.push(node);
  }

  return nodes;
}

async function normalizeComment(item, depth, state, signal) {
  if (!item || item.type !== "comment" || item.deleted || item.dead) {
    return null;
  }

  state.count += 1;
  notifyProgress(state);

  const children = item.kids && state.count < MAX_COMMENTS
    ? await loadComments(item.kids, depth + 1, state, signal)
    : [];

  if (item.kids && item.kids.length && state.count >= MAX_COMMENTS) {
    state.truncated = true;
  }

  return {
    id: item.id,
    by: item.by || "unknown",
    time: item.time,
    text: item.text || "",
    depth,
    children
  };
}

async function mapLimit(items, limit, iterator) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await iterator(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function notifyProgress(state) {
  const now = performance.now();
  if (now - state.lastUpdate < 180 && state.count % 20 !== 0) return;

  const target = state.total ? ` of ${formatCount(Math.min(state.total, MAX_COMMENTS))}` : "";
  setStatus(`Reading comments: ${formatCount(state.count)}${target}`);
  state.lastUpdate = now;
}

function renderLoading() {
  storyEl.replaceChildren();

  const storySkeleton = document.createElement("div");
  storySkeleton.className = "skeleton-stack";
  storySkeleton.append(
    skeletonLine("28%"),
    skeletonLine("78%"),
    skeletonLine("54%"),
    skeletonLine("36%")
  );
  storyEl.append(storySkeleton);

  metaList.replaceChildren(
    metaItem("Source", "Loading"),
    metaItem("Score", "Loading"),
    metaItem("Comments", "Loading")
  );

  commentSummary.textContent = "";
  commentsEl.replaceChildren();
  const skeletons = document.createDocumentFragment();
  for (let index = 0; index < 4; index += 1) {
    const card = document.createElement("div");
    card.className = "skeleton-card";
    skeletons.append(card);
  }
  commentsEl.append(skeletons);
}

function renderStory(story) {
  storyEl.replaceChildren();

  const domain = story.url ? getDomain(story.url) : "news.ycombinator.com";
  const kicker = document.createElement("div");
  kicker.className = "story-kicker";
  kicker.textContent = domain;

  const title = document.createElement("h1");
  title.id = "story-title";
  title.textContent = story.title || "Untitled Hacker News item";

  const meta = document.createElement("div");
  meta.className = "story-meta";
  meta.append(
    chip(`${formatCount(story.score || 0)} points`),
    chip(`${formatCount(story.descendants || 0)} comments`),
    chip(story.by ? `by ${story.by}` : "unknown author"),
    chip(story.time ? `${relativeTime(story.time)} (${formatDate(story.time)})` : "unknown time")
  );

  const actions = document.createElement("div");
  actions.className = "story-actions";
  if (story.url) {
    actions.append(linkButton("Open article", story.url));
  }
  actions.append(linkButton("Open on HN", toHnUrl(story.id)));

  storyEl.append(kicker, title, meta, actions);

  if (story.text) {
    const storyText = document.createElement("section");
    storyText.className = "story-text";
    storyText.append(sanitizeHtml(story.text));
    storyEl.append(storyText);
  }
}

function renderMeta() {
  if (!currentThread) return;

  const { story, loadedComments, truncated } = currentThread;
  const domain = story.url ? getDomain(story.url) : "HN text post";
  const wordCount = estimateWordCount(currentThread);
  const minutes = Math.max(1, Math.round(wordCount / 230));

  metaList.replaceChildren(
    metaItem("Source", domain),
    metaItem("Score", `${formatCount(story.score || 0)} points`),
    metaItem("Comments", `${formatCount(loadedComments)}${truncated ? "+" : ""} loaded`),
    metaItem("Reading", `${minutes} min`),
    metaItem("Posted", story.time ? formatDate(story.time) : "Unknown")
  );
}

function renderComments() {
  if (!currentThread) return;

  commentsEl.replaceChildren();
  const { comments, loadedComments, truncated } = currentThread;
  const summaryLabel = `${formatCount(loadedComments)}${truncated ? "+" : ""} comments`;
  commentSummary.textContent = currentView === "top"
    ? `${summaryLabel}, top-level only`
    : summaryLabel;

  if (!comments.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No comments loaded for this item.";
    commentsEl.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const comment of comments) {
    fragment.append(renderComment(comment, { includeChildren: currentView === "all" }));
  }
  commentsEl.append(fragment);
}

function renderComment(comment, options) {
  const article = document.createElement("article");
  article.className = "comment";
  article.dataset.depth = String(Math.min(comment.depth, 5));
  article.style.setProperty("--depth", String(Math.min(comment.depth, 6)));

  const header = document.createElement("header");
  header.className = "comment-header";

  const avatar = document.createElement("div");
  avatar.className = "comment-avatar";
  avatar.textContent = getInitial(comment.by);

  const meta = document.createElement("div");
  meta.className = "comment-meta";

  const author = document.createElement("span");
  author.className = "comment-author";
  author.textContent = comment.by;

  const time = document.createElement("span");
  time.className = "comment-time";
  time.textContent = comment.time ? `${relativeTime(comment.time)} - ${formatDate(comment.time)}` : "Unknown time";

  meta.append(author, time);

  const actions = document.createElement("div");
  actions.className = "comment-actions";

  if (comment.children.length && options.includeChildren) {
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "comment-action";
    collapse.dataset.collapseComment = "";
    collapse.title = "Collapse replies";
    collapse.setAttribute("aria-label", "Collapse replies");
    collapse.setAttribute("aria-expanded", "true");
    collapse.innerHTML = icons.collapse;
    actions.append(collapse);
  }

  const permalink = document.createElement("a");
  permalink.className = "comment-action";
  permalink.href = toHnUrl(comment.id);
  permalink.target = "_blank";
  permalink.rel = "noopener noreferrer";
  permalink.title = "Open comment on HN";
  permalink.setAttribute("aria-label", "Open comment on HN");
  permalink.innerHTML = icons.link;
  actions.append(permalink);

  header.append(avatar, meta, actions);

  const body = document.createElement("div");
  body.className = "comment-body";
  body.append(sanitizeHtml(comment.text));

  article.append(header, body);

  if (options.includeChildren && comment.children.length) {
    const children = document.createElement("div");
    children.className = "comment-children";
    for (const child of comment.children) {
      children.append(renderComment(child, options));
    }
    article.append(children);
  }

  if (!options.includeChildren && comment.children.length) {
    const replyCount = document.createElement("span");
    replyCount.className = "reply-count";
    replyCount.textContent = `${formatCount(countNodes(comment.children))} replies`;
    article.append(replyCount);
  }

  return article;
}

function sanitizeHtml(rawHtml) {
  const allowedTags = new Set([
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "em",
    "i",
    "li",
    "ol",
    "p",
    "pre",
    "strong",
    "ul"
  ]);

  const parsed = new DOMParser().parseFromString(String(rawHtml || ""), "text/html");
  const fragment = document.createDocumentFragment();

  for (const child of parsed.body.childNodes) {
    fragment.append(cleanNode(child, allowedTags));
  }

  return fragment;
}

function cleanNode(node, allowedTags) {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.textContent || "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return document.createDocumentFragment();
  }

  const tag = node.tagName.toLowerCase();
  if (!allowedTags.has(tag)) {
    const fragment = document.createDocumentFragment();
    for (const child of node.childNodes) {
      fragment.append(cleanNode(child, allowedTags));
    }
    return fragment;
  }

  const clean = document.createElement(tag);
  if (tag === "a") {
    const href = node.getAttribute("href") || "";
    if (isSafeHref(href)) {
      clean.href = href;
      clean.target = "_blank";
      clean.rel = "noopener noreferrer";
    }
  }

  for (const child of node.childNodes) {
    clean.append(cleanNode(child, allowedTags));
  }

  return clean;
}

function isSafeHref(href) {
  try {
    const parsed = new URL(href, window.location.href);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function showError(message) {
  currentThread = null;
  setStatus(message, "error");

  storyEl.replaceChildren();
  const error = document.createElement("div");
  error.className = "error-state";
  error.textContent = message;
  storyEl.append(error);

  commentsEl.replaceChildren();
  commentSummary.textContent = "";
}

function setStatus(message, tone = "") {
  statusLine.textContent = message;
  if (tone) {
    statusLine.dataset.tone = tone;
  } else {
    delete statusLine.dataset.tone;
  }
}

function updateCommentViewButtons() {
  for (const button of commentView.querySelectorAll("button[data-view]")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === currentView));
  }
}

function skeletonLine(width) {
  const line = document.createElement("div");
  line.className = "skeleton-line";
  line.style.width = width;
  return line;
}

function chip(text) {
  const element = document.createElement("span");
  element.className = "meta-chip";
  element.textContent = text;
  return element;
}

function linkButton(label, href) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = label;
  return anchor;
}

function metaItem(label, value) {
  const row = document.createElement("div");
  const term = document.createElement("dt");
  const description = document.createElement("dd");

  term.textContent = label;
  description.textContent = value;
  row.append(term, description);
  return row;
}

function countNodes(nodes) {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

function estimateWordCount(thread) {
  const storyWords = `${thread.story.title || ""} ${htmlToText(thread.story.text || "")}`;
  const commentWords = flattenComments(thread.comments)
    .map((comment) => htmlToText(comment.text))
    .join(" ");
  return `${storyWords} ${commentWords}`.trim().split(/\s+/).filter(Boolean).length;
}

function flattenComments(nodes) {
  const output = [];
  for (const node of nodes) {
    output.push(node, ...flattenComments(node.children));
  }
  return output;
}

function htmlToText(html) {
  return new DOMParser().parseFromString(String(html || ""), "text/html").body.textContent || "";
}

function getInitial(value) {
  return String(value || "?").trim().charAt(0).toUpperCase() || "?";
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown source";
  }
}

function formatDate(timestampSeconds) {
  return dateFormatter.format(new Date(timestampSeconds * 1000));
}

function toUnixSeconds(value) {
  const parsed = Date.parse(value || "");
  return Number.isNaN(parsed) ? 0 : Math.round(parsed / 1000);
}

function relativeTime(timestampSeconds) {
  const diffSeconds = Math.round(timestampSeconds - Date.now() / 1000);
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1]
  ];

  for (const [unit, seconds] of units) {
    if (Math.abs(diffSeconds) >= seconds || unit === "second") {
      return relativeFormatter.format(Math.round(diffSeconds / seconds), unit);
    }
  }

  return "just now";
}

function formatCount(value) {
  return numberFormatter.format(value || 0);
}
