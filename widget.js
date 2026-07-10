(function () {
  const config = window.GRANTS_CONFIG || {};
  const apiUrl    = config.apiUrl    || "/api/faq-agent";
  const assetsUrl = config.assetsUrl || "";
  const CALENDLY  = config.calendly  || "tel:01229836616";
  const BRAND      = "Grant's P & H";
  const BRAND_FULL = "Grant's Plumbing & Heating";

  const T = {
    teasers: [
      "Need a new boiler? Get a free estimate in 1 minute!",
      "Gas Safe registered - all boiler & heating work.",
      "Covering Barrow, Ulverston, Dalton & beyond.",
      "Boiler breakdown? We're here 24/7 to help.",
      "Annual boiler service - ask us for a price!",
      "Leaking tap or pipe? Tell us the problem.",
      "Cold radiators or no hot water? Ask us!",
      "Get a free plumbing & heating estimate now.",
      "Transparent fixed pricing - no hidden fees.",
    ],
    launcherAria:  "Open chat - " + BRAND_FULL,
    bubbleClose:   "Close bubble",
    chatClose:     "Close chat",
    status:        "Replies instantly",
    placeholder:   "Type your answer - or ask us anything...",
    inputAria:     "Type your answer or question",
    dialogAria:    BRAND_FULL + " quote assistant",
    greeting:      `Hi! Welcome to **${BRAND_FULL}**.\n\nDo you want an **estimate**, or do you have **questions**?`,
    estimateGreeting: "Great! Answer a few quick questions and I'll prepare your **free estimate**.",
    questionGreeting: "Of course! What would you like to know? Ask me anything about boilers, heating, plumbing or our services.",
    exampleQuestions: [],
    questionHint:  "Ask us anything - boilers, heating, plumbing...",
    kickoff:       "I'd like an estimate.",
    estLabel:      "Estimated price",
    estFinal:      "estimated range",
    approx:        "approx.",
    emailYes:      "Yes, email it to me",
    emailNo:       "No, thanks",
    declineMsg:    "Great, thanks for getting in touch! We'll be in contact soon.",
    errGeneric:    "Sorry, something went wrong. Please try again later.",
    errConnect:    "Sorry, we couldn't connect to the server.",
  };

  function t() { return T; }
  function curTeasers() { return T.teasers; }

  function track(event, props) {
    try {
      if (typeof window.va === "function") window.va("event", { name: event, ...(props || {}) });
    } catch (e) {}
  }

  let chatOpen = false;
  let chatWindow = null;
  let messagesContainer = null;
  let inputElement = null;
  let sending = false;
  let conversationHistory = [];
  let convState = {};
  let started = false;
  let thinkingEl = null;
  let progressFillEl = null, progressLabelEl = null, progressBarEl = null;
  let estimateBarEl = null;
  let lastProgress = 0, lastProgressTotal = 0;
  let quoteDone = false;
  let container = null;

  const TEASER_ROTATE_MS = 9000;
  const TEASER_DISMISS_KEY = "grantspah_teaser_dismissed";
  let teaserIdx = Math.floor(Math.random() * curTeasers().length);
  let teaserTimer = null;
  let teaserDismissed = false;
  try { teaserDismissed = localStorage.getItem(TEASER_DISMISS_KEY) === "1"; } catch (e) {}

  const ICON = {
    chat:     '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    phone:    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.4 2 2 0 0 1 3.59 1.22h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.78a16 16 0 0 0 5.32 5.32l.95-.95a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2.02z"/></svg>',
    send:     '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    close:    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  };

  function logoSrc() {
    return assetsUrl ? `${assetsUrl}/logo.jpg` : "logo.jpg";
  }

  function makeAvatar(cls) {
    const img = document.createElement("img");
    img.className = cls;
    img.src = logoSrc();
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    return img;
  }

  function injectStyles() {
    if (document.getElementById("faq-agent-styles")) return;
    const link = document.createElement("link");
    link.id = "faq-agent-styles";
    link.rel = "stylesheet";
    link.href = assetsUrl ? `${assetsUrl}/style.css` : "style.css";
    document.head.appendChild(link);
  }

  function createContainer() {
    container = document.createElement("div");
    container.id = "faq-agent-container";
    document.body.appendChild(container);
  }

  function createLauncher() {
    if (!container) createContainer();

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "faq-chat-launcher";
    btn.setAttribute("aria-label", t().launcherAria);
    btn.innerHTML = `<span class="faq-launcher-ring" aria-hidden="true"></span>${ICON.chat}<span class="faq-launcher-dot" aria-hidden="true"></span>`;
    btn.onclick = toggleChat;
    container.appendChild(btn);

    const tooltip = document.createElement("div");
    tooltip.className = "faq-chat-tooltip";
    tooltip.setAttribute("role", "button");
    tooltip.setAttribute("tabindex", "0");
    tooltip.innerHTML = `<span class="faq-tooltip-text">${curTeasers()[teaserIdx % curTeasers().length]}</span>`;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "faq-tooltip-close";
    closeBtn.setAttribute("aria-label", t().bubbleClose);
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      teaserDismissed = true;
      try { localStorage.setItem(TEASER_DISMISS_KEY, "1"); } catch (err) {}
      hideTeaser();
    };

    tooltip.appendChild(closeBtn);
    const openFromTooltip = () => { hideTeaser(); if (!chatOpen) toggleChat(); };
    tooltip.onclick = openFromTooltip;
    tooltip.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFromTooltip(); } };

    container.appendChild(tooltip);
    setTimeout(() => showTeaser(), 1600);
  }

  function teaserEl() { return document.querySelector(".faq-chat-tooltip"); }

  function rotateTeaser() {
    const tip = teaserEl();
    if (!tip || !tip.classList.contains("show")) return;
    const textEl = tip.querySelector(".faq-tooltip-text");
    if (!textEl) return;
    tip.classList.add("swapping");
    setTimeout(() => {
      teaserIdx = (teaserIdx + 1) % curTeasers().length;
      textEl.textContent = curTeasers()[teaserIdx];
      tip.classList.remove("swapping");
      tip.classList.add("attention");
      setTimeout(() => tip.classList.remove("attention"), 650);
    }, 260);
  }

  function showTeaser() {
    if (teaserDismissed || chatOpen) return;
    const tip = teaserEl();
    if (!tip) return;
    tip.classList.remove("hidden");
    void tip.offsetWidth;
    tip.classList.add("show");
    if (!teaserTimer) teaserTimer = setInterval(rotateTeaser, TEASER_ROTATE_MS);
  }

  function hideTeaser() {
    const tip = teaserEl();
    if (teaserTimer) { clearInterval(teaserTimer); teaserTimer = null; }
    if (!tip) return;
    tip.classList.remove("show");
    setTimeout(() => tip.classList.add("hidden"), 300);
  }

  function toggleChat() {
    const launcher = document.querySelector(".faq-chat-launcher");

    if (chatOpen) {
      const w = chatWindow;
      w.classList.add("closing");
      setTimeout(() => {
        if (w) { w.style.display = "none"; w.classList.remove("closing"); }
      }, 180);
      chatOpen = false;
      if (launcher) launcher.classList.remove("active");
      track("chat_closed", { answered: lastProgress, total: lastProgressTotal });
      setTimeout(() => showTeaser(), 400);
    } else {
      hideTeaser();
      if (!chatWindow) {
        openChat();
      } else {
        chatWindow.style.display = "flex";
        chatWindow.style.animation = "none";
        void chatWindow.offsetWidth;
        chatWindow.style.animation = "";
        scrollToBottom();
        setTimeout(() => inputElement && inputElement.focus(), 120);
      }
      chatOpen = true;
      if (launcher) launcher.classList.add("active");
      track("chat_opened");
    }
  }

  function openChat() {
    chatWindow = document.createElement("div");
    chatWindow.className = "faq-chat-window";
    chatWindow.setAttribute("role", "dialog");
    chatWindow.setAttribute("aria-label", t().dialogAria);

    const header = document.createElement("div");
    header.className = "faq-chat-header";

    const logo = makeAvatar("faq-header-logo");

    const textBlock = document.createElement("div");
    textBlock.className = "faq-header-text";
    textBlock.innerHTML =
      `<span class="faq-header-title">${BRAND}</span>` +
      `<span class="faq-header-status"><span class="faq-status-dot" aria-hidden="true"></span>${t().status}</span>`;

    const actions = document.createElement("div");
    actions.className = "faq-header-actions";

    const callBtn = document.createElement("a");
    callBtn.className = "faq-header-phone";
    callBtn.href = CALENDLY;
    callBtn.setAttribute("aria-label", "Call Grant's Plumbing & Heating");
    callBtn.innerHTML = `${ICON.phone}<span>Call us</span>`;
    callBtn.onclick = () => track("call_cta_clicked", { location: "widget_header" });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "faq-header-close";
    closeBtn.setAttribute("aria-label", t().chatClose);
    closeBtn.innerHTML = ICON.close;
    closeBtn.onclick = toggleChat;

    actions.appendChild(callBtn);
    actions.appendChild(closeBtn);

    header.appendChild(logo);
    header.appendChild(textBlock);
    header.appendChild(actions);

    const progress = document.createElement("div");
    progress.className = "faq-progress";
    progress.innerHTML =
      '<div class="faq-progress-track"><div class="faq-progress-fill"></div></div>' +
      '<span class="faq-progress-label"></span>';
    progressBarEl  = progress;
    progressFillEl = progress.querySelector(".faq-progress-fill");
    progressLabelEl = progress.querySelector(".faq-progress-label");

    estimateBarEl = document.createElement("div");
    estimateBarEl.className = "faq-estimate";
    estimateBarEl.style.cssText =
      "display:none;align-items:center;justify-content:space-between;gap:8px;" +
      "padding:10px 14px;background:#072B3A;color:#fff;border-bottom:2px solid #2D8FB2;" +
      "font-family:inherit;";
    estimateBarEl.innerHTML =
      `<span style="font-size:12px;color:#A0CBE0">${t().estLabel}</span>` +
      '<span class="faq-estimate-val" style="font-size:15px;font-weight:700;color:#fff"></span>' +
      `<span class="faq-estimate-note" style="font-size:10px;color:#6AAABB;text-align:right;flex:0 0 auto">${t().estFinal}</span>`;

    messagesContainer = document.createElement("div");
    messagesContainer.className = "faq-chat-messages";
    messagesContainer.setAttribute("role", "log");
    messagesContainer.setAttribute("aria-live", "polite");

    const inputBar = document.createElement("form");
    inputBar.className = "faq-chat-input";
    inputBar.onsubmit = (e) => { e.preventDefault(); sendMessage(); };

    inputElement = document.createElement("input");
    inputElement.type = "text";
    inputElement.className = "faq-input-field";
    inputElement.setAttribute("aria-label", t().inputAria);
    inputElement.placeholder = t().placeholder;
    inputElement.autocomplete = "off";

    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "faq-send-btn";
    sendBtn.setAttribute("aria-label", "Send");
    sendBtn.innerHTML = ICON.send;

    const hintBar = document.createElement("div");
    hintBar.className = "faq-question-hint";
    hintBar.textContent = t().questionHint;

    inputBar.appendChild(inputElement);
    inputBar.appendChild(sendBtn);

    chatWindow.appendChild(header);
    chatWindow.appendChild(progress);
    chatWindow.appendChild(estimateBarEl);
    chatWindow.appendChild(messagesContainer);
    chatWindow.appendChild(hintBar);
    chatWindow.appendChild(inputBar);

    container.appendChild(chatWindow);
    setTimeout(() => inputElement && inputElement.focus(), 150);

    if (!started) {
      started = true;
      track("quote_started");
      addMessage("bot", t().greeting);

      // First-contact choice: estimate vs questions
      const choiceWrap = document.createElement("div");
      choiceWrap.className = "faq-chips faq-example-questions";

      const estimateChip = makeChip("I want a free estimate");
      estimateChip.onclick = () => {
        choiceWrap.remove();
        addMessage("user", "I want a free estimate");
        addMessage("bot", t().estimateGreeting);
        sendMessage(t().kickoff, true);
        track("intent_estimate");
      };

      const questionChip = makeChip("I have a question");
      questionChip.onclick = () => {
        choiceWrap.remove();
        addMessage("user", "I have a question");
        addMessage("bot", t().questionGreeting);
        track("intent_question");
      };

      choiceWrap.appendChild(estimateChip);
      choiceWrap.appendChild(questionChip);
      messagesContainer.appendChild(choiceWrap);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  function renderMarkdown(text) {
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const safeUrl = (u) => (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(u) ? u : "#");
    const inline = (s) =>
      esc(s)
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) =>
          `<a href="${safeUrl(url.trim())}" target="_blank" rel="noopener noreferrer">${label}</a>`)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    let html = "";
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "") { html += '<div class="faq-sp"></div>'; continue; }
      if (line.startsWith("•")) { html += '<div class="faq-li">' + inline(line.replace(/^•\s*/, "")) + "</div>"; continue; }
      if (/^\*\*.*\*\*:?$/.test(line)) { html += '<div class="faq-h">' + inline(line) + "</div>"; continue; }
      html += '<div class="faq-p">' + inline(line) + "</div>";
    }
    return html;
  }

  function clearChips() {
    messagesContainer.querySelectorAll(".faq-chips").forEach((c) => c.remove());
  }

  function makeChip(label) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "faq-chip";
    chip.textContent = label;
    return chip;
  }

  function renderChips(chips) {
    clearChips();
    if (!chips || !chips.length) return;
    const wrap = document.createElement("div");
    wrap.className = "faq-chips";
    chips.forEach((label) => {
      const chip = makeChip(label);
      chip.onclick = () => { clearChips(); sendMessage(label); };
      wrap.appendChild(chip);
    });
    messagesContainer.appendChild(wrap);
    scrollToBottom();
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function addMessage(sender, text) {
    const msg = document.createElement("div");
    msg.className = "faq-msg " + sender;

    if (sender === "bot") msg.appendChild(makeAvatar("faq-avatar"));

    const bubble = document.createElement("div");
    bubble.className = "faq-bubble";
    if (sender === "bot") bubble.innerHTML = renderMarkdown(text);
    else { bubble.textContent = text; bubble.classList.add("ph-no-capture"); }

    msg.appendChild(bubble);
    messagesContainer.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function addThinking() {
    const msg = document.createElement("div");
    msg.className = "faq-msg bot";
    msg.appendChild(makeAvatar("faq-avatar"));
    const bubble = document.createElement("div");
    bubble.className = "faq-bubble faq-typing";
    bubble.innerHTML = "<span></span><span></span><span></span>";
    msg.appendChild(bubble);
    messagesContainer.appendChild(msg);
    scrollToBottom();
    thinkingEl = msg;
  }

  function removeThinking() {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  }

  function fmtGbp(n) { return "£" + Math.round(n).toLocaleString("en-GB"); }
  function fmtRange(low, high) { return `${fmtGbp(low)} - ${fmtGbp(high)}`; }

  let lastEstimateText = null;

  function updateEstimate(est) {
    if (!estimateBarEl) return;
    if (!est || est.low == null || est.high == null) { estimateBarEl.style.display = "none"; lastEstimateText = null; return; }
    const wasVisible = estimateBarEl.style.display !== "none";
    estimateBarEl.style.display = "flex";
    const val  = estimateBarEl.querySelector(".faq-estimate-val");
    const text = t().approx + " " + fmtRange(est.low, est.high);
    if (val) val.textContent = text;
    if (wasVisible && text !== lastEstimateText) {
      estimateBarEl.classList.remove("faq-estimate--pulse");
      void estimateBarEl.offsetWidth;
      estimateBarEl.classList.add("faq-estimate--pulse");
      setTimeout(() => estimateBarEl && estimateBarEl.classList.remove("faq-estimate--pulse"), 650);
    }
    lastEstimateText = text;
  }

  function updateProgress(done, total) {
    if (!progressFillEl || !total) return;
    const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    progressFillEl.style.width = pct + "%";
    if (progressLabelEl) progressLabelEl.textContent = pct + "%";
    if (progressBarEl) {
      progressBarEl.classList.add("visible");
      progressBarEl.classList.toggle("complete", done >= total);
    }
  }

  async function sendMessage(presetText, hidden) {
    if (sending) return;
    const text = (presetText !== undefined ? presetText : (inputElement.value || "")).trim();
    if (!text) return;

    clearChips();
    if (!hidden) addMessage("user", text);
    if (presetText === undefined) inputElement.value = "";
    sending = true;

    conversationHistory.push({ role: "user", content: text });
    addThinking();

    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, history: conversationHistory, state: convState }),
      });

      removeThinking();

      if (!res.ok) {
        addMessage("bot", t().errGeneric);
        sending = false;
        return;
      }

      const data = await res.json();
      if (data.state && typeof data.state === "object") convState = data.state;
      if (typeof data.progress === "number" && typeof data.progressTotal === "number") {
        updateProgress(data.progress, data.progressTotal);
        if (!hidden && data.progress > lastProgress) {
          track("question_answered", {
            answered: data.progress,
            total: data.progressTotal,
            project_type: convState && convState.projectType,
          });
        }
        lastProgress = data.progress;
        lastProgressTotal = data.progressTotal;
      }
      if ("estimate" in data) updateEstimate(data.estimate);

      if (data.lead && !quoteDone) {
        quoteDone = true;
        const s = data.lead.sel || {}, q = data.lead.quote || {};
        track("quote_completed", {
          project_type: s.projectType,
          property: s.property,
          quote_low: q.low,
          quote_high: q.high,
        });
      }

      const botResponse = data.answer || "Sorry, I couldn't find an answer.";
      const parts = botResponse.split("[[SPLIT]]").map(s => s.trim()).filter(Boolean);
      parts.forEach(p => addMessage("bot", p));
      conversationHistory.push({ role: "assistant", content: parts.join("\n\n") });

      renderChips(data.chips);
    } catch (err) {
      console.error(err);
      removeThinking();
      addMessage("bot", t().errConnect);
    } finally {
      sending = false;
    }
  }

  function injectEstimateStyles() {
    if (document.getElementById("faq-estimate-anim")) return;
    const s = document.createElement("style");
    s.id = "faq-estimate-anim";
    s.textContent =
      ".faq-estimate{transition:background-color .4s ease}" +
      ".faq-estimate .faq-estimate-val{display:inline-block;transition:transform .25s ease}" +
      ".faq-estimate--pulse{animation:faqEstFlash .65s ease}" +
      ".faq-estimate--pulse .faq-estimate-val{animation:faqEstPop .5s ease}" +
      "@keyframes faqEstFlash{0%,55%{background:#0E4B66}100%{background:#072B3A}}" +
      "@keyframes faqEstPop{0%{transform:scale(1)}40%{transform:scale(1.13)}100%{transform:scale(1)}}";
    document.head.appendChild(s);
  }

  // Expose toggle for external buttons (mobile bar, etc.)
  window.GRANTS_WIDGET_TOGGLE = function() {
    if (container) toggleChat();
  };

  function init() {
    injectStyles();
    injectEstimateStyles();
    createLauncher();
    track("widget_loaded");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
