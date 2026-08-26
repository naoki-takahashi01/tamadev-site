(function () {
  "use strict";

  const DAILY_DEVICE_LIMIT = 10;
  const LIMIT_MESSAGE = "本日の案内を終了しました。また明日、たまナビに聞いてください！";
  const script = document.currentScript;
  const endpoint = script?.dataset.apiEndpoint || "";
  const launcher = document.getElementById("tamanaviLauncher");
  const panel = document.getElementById("tamanaviPanel");
  const closeButton = document.getElementById("tamanaviClose");
  const form = document.getElementById("tamanaviForm");
  const input = document.getElementById("tamanaviInput");
  const sendButton = document.getElementById("tamanaviSend");
  const messages = document.getElementById("tamanaviMessages");
  const suggestions = Array.from(document.querySelectorAll(".tamanavi-suggestion"));
  const conversation = [];

  function todayKey() {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  }

  function loadUsage() {
    try {
      const usage = JSON.parse(localStorage.getItem("tamanavi-usage") || "null");
      if (usage?.date === todayKey() && Number.isInteger(usage.count)) return usage;
    } catch (_) {
      // 壊れたローカル値は破棄して当日分を作り直す。
    }
    return { date: todayKey(), count: 0 };
  }

  function saveUsage(usage) {
    localStorage.setItem("tamanavi-usage", JSON.stringify(usage));
  }

  function hasReachedDeviceLimit() {
    return loadUsage().count >= DAILY_DEVICE_LIMIT;
  }

  function incrementUsage() {
    const usage = loadUsage();
    usage.count += 1;
    saveUsage(usage);
  }

  function setDisabled(disabled) {
    input.disabled = disabled;
    sendButton.disabled = disabled;
    suggestions.forEach((button) => { button.disabled = disabled; });
  }

  function appendLinkedText(container, text) {
    const linkPattern = /\[([^\]]+)]\s*\((https:\/\/[^\s)]+)\)/g;
    let cursor = 0;
    let match;

    while ((match = linkPattern.exec(text)) !== null) {
      container.append(document.createTextNode(text.slice(cursor, match.index)));
      const link = document.createElement("a");
      link.href = match[2];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = match[1];
      container.append(link);
      cursor = linkPattern.lastIndex;
    }
    container.append(document.createTextNode(text.slice(cursor)));
  }

  function addMessage(role, text, extraClass = "") {
    const message = document.createElement("div");
    message.className = `tamanavi-message is-${role}${extraClass ? ` ${extraClass}` : ""}`;
    message.setAttribute("role", "listitem");
    appendLinkedText(message, text);
    messages.append(message);
    messages.scrollTop = messages.scrollHeight;
    return message;
  }

  function showLimit() {
    addMessage("assistant", LIMIT_MESSAGE);
    setDisabled(true);
  }

  function togglePanel(open) {
    const shouldOpen = typeof open === "boolean" ? open : panel.hidden;
    panel.hidden = !shouldOpen;
    launcher.setAttribute("aria-expanded", String(shouldOpen));
    if (shouldOpen) {
      window.setTimeout(() => input.focus(), 0);
    } else {
      launcher.focus();
    }
  }

  async function ask(question) {
    if (!question || sendButton.disabled) return;
    if (hasReachedDeviceLimit()) {
      showLimit();
      return;
    }
    if (!endpoint || endpoint.includes("YOUR-SUBDOMAIN")) {
      addMessage("assistant", "たまナビは現在準備中です。APIの公開設定後にご利用いただけます。");
      return;
    }

    addMessage("user", question);
    conversation.push({ role: "user", content: question });
    input.value = "";
    setDisabled(true);
    const loading = addMessage("assistant", "調べています", "tamanavi-loading");

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          history: conversation.slice(-5, -1)
        })
      });
      const data = await response.json().catch(() => ({}));
      loading.remove();

      if (response.status === 429 || data.code === "DAILY_LIMIT_REACHED") {
        saveUsage({ date: todayKey(), count: DAILY_DEVICE_LIMIT });
        showLimit();
        return;
      }
      if (!response.ok) throw new Error(data.message || "案内を取得できませんでした。");

      incrementUsage();
      const answer = data.answer || "回答を取得できませんでした。";
      addMessage("assistant", answer);
      conversation.push({ role: "assistant", content: answer });
      setDisabled(hasReachedDeviceLimit());
      if (hasReachedDeviceLimit()) addMessage("assistant", LIMIT_MESSAGE);
    } catch (error) {
      loading.remove();
      addMessage("assistant", `${error.message || "案内を取得できませんでした。"}\n時間をおいて、もう一度お試しください。`);
      setDisabled(false);
    }
  }

  launcher.addEventListener("click", () => togglePanel());
  closeButton.addEventListener("click", () => togglePanel(false));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    ask(input.value.trim());
  });
  suggestions.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.action === "choose-talk-search") {
        const question = "過去の登壇を探したい";
        const answer = "何回目のイベント、またはどなたの登壇を探しますか？\n「#1の登壇」「第4回の登壇」「スティーブさんの登壇」のように入力してください！";
      
        addMessage("user", question);
        addMessage("assistant", answer);
        conversation.push(
          { role: "user", content: question },
          { role: "assistant", content: answer }
        );
        input.focus();
        return;
      }
      if (button.dataset.action === "choose-spot-area") {
        const question = "おすすめスポットを探したい";
        const answer = "どの地域で探しますか？\n聖蹟桜ヶ丘、多摩センター、永山、立川、府中などを指定してください！";
  
        addMessage("user", question);
        addMessage("assistant", answer);
        conversation.push(
          { role: "user", content: question },
          { role: "assistant", content: answer }
        );
        input.focus();
        return;
      }
  
      ask(button.dataset.question || button.textContent.trim());
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) togglePanel(false);
  });

  if (hasReachedDeviceLimit()) setDisabled(true);
}());
