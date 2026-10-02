const $ = (id) => document.getElementById(id);
const services = {
  "gmail-work-actions": "Email",
  "google-work-actions": "Google",
  "slack-actions": "Slack",
  "whatsapp-actions": "WhatsApp",
};
const tools = {
  send_email: "Send email",
  conversations_add_message: "Slack message",
  send_message: "WhatsApp message",
};
const shown = ["ready", "needs_info", "opening", "answered"];
// Card ids with unsaved input. Polling never replaces them.
const dirty = new Set();
let sender = "";
let busy = false,
  captureKey;
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text, className, handler) {
  const b = node("button", className, text);
  b.type = "button";
  b.addEventListener("click", handler);
  return b;
}
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), 6000);
}
function notice(id, error) {
  $(id).textContent = error?.message ?? "";
  $(id).hidden = !error;
}
async function api(path, method = "GET", data) {
  const response = await fetch(path, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  $("auth").hidden = response.status !== 401;
  if (!response.ok) throw Error(result.error || "Request failed.");
  return result;
}
// Hold the page still while one decision is in flight.
async function act(card, work, done) {
  if (busy) return;
  busy = true;
  for (const b of card.querySelectorAll("button")) b.disabled = true;
  try {
    await work();
    dirty.delete(card.dataset.id);
    if (done) toast(done);
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
    await refresh();
    for (const b of card.querySelectorAll("button")) b.disabled = false;
  }
}

function label(action) {
  return (
    tools[action.tool] ??
    `${services[action.server] ?? action.server} · ${action.tool.replaceAll("_", " ")}`
  );
}
// Quiet line under the title: which channel this touches, or that it is a question.
function meta(action, question) {
  return node(
    "div",
    "meta",
    question ? "Question" : action ? label(action) : "Note",
  );
}
function visibleArgs(args) {
  return Object.entries(args).filter(
    ([key, value]) =>
      !key.startsWith("secretary_") &&
      !["timeoutMs"].includes(key) &&
      value !== "" &&
      value !== null &&
      !(Array.isArray(value) && !value.length),
  );
}
const isList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
function argFields(card, args, editable) {
  const box = node("div", "fields");
  for (const [key, value] of visibleArgs(args)) {
    const name = node("div", "field-name", key.replaceAll("_", " "));
    let el;
    if (typeof value === "string" || isList(value)) {
      const text = isList(value) ? value.join(", ") : value;
      el = node(typeof value === "string" ? "textarea" : "input", "field");
      el.value = text;
      el.dataset.key = key;
      el.readOnly = !editable;
      if (el.tagName === "TEXTAREA")
        // Lines plus a rough count of soft wraps.
        el.rows = Math.min(
          14,
          text
            .split("\n")
            .reduce((n, l) => n + 1 + Math.floor(l.length / 70), 0),
        );
      el.addEventListener("input", () => {
        dirty.add(card.dataset.id);
        card.classList.add("dirty");
      });
    } else el = node("pre", "field", JSON.stringify(value, null, 2));
    box.append(name, el);
  }
  return box;
}
function editedArgs(card, args) {
  const next = { ...args };
  for (const el of card.querySelectorAll("[data-key]")) {
    const key = el.dataset.key;
    next[key] = isList(args[key])
      ? el.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : el.value;
  }
  return next;
}

function decisionButtons(card, action) {
  const decide = (decision) =>
    act(
      card,
      () =>
        api("/api/reviews/decision", "POST", {
          id: action.id,
          approvalId: action.approvalId,
          reviewToken: action.reviewToken,
          decision,
        }),
      decision === "deny" ? "Rejected." : "Approved.",
    );
  return [
    button("Approve", "primary", () => decide("allow-once")),
    button("Edit", "", () => beginRevision(card, action)),
    button("Reject", "", () => decide("deny")),
  ];
}
function itemCard(item, pending) {
  const card = node("article", "card");
  card.dataset.id = item.id;
  const url = (op) => `/api/reviews/${item.id}/${op}`;
  card.append(
    node("h3", "", item.title),
    meta(item.action, item.state === "needs_info"),
  );
  if (item.action) appendSender(card, item.action);
  if (item.error) card.append(node("p", "error", item.error));
  const buttons = node("div", "buttons");
  const reject = button("Reject", "", () =>
    act(card, () => api(url("reject"), "POST", { version: item.version })),
  );
  if (item.state === "needs_info") {
    if (item.question) card.append(node("p", "question", item.question));
    const answer = node("textarea", "field");
    answer.rows = 2;
    answer.placeholder = "Reply…";
    answer.addEventListener("input", () => dirty.add(item.id));
    buttons.append(
      button("Answer", "primary", () =>
        act(
          card,
          () =>
            api(url("answer"), "POST", {
              version: item.version,
              answer: answer.value,
            }),
          "Sent to the assistant.",
        ),
      ),
      reject,
    );
    card.append(answer, buttons);
    return card;
  }
  if (item.action)
    card.append(argFields(card, item.action.args, item.state === "ready"));
  if (item.state === "ready") {
    // Opening only asks for the native approval; nothing is sent yet.
    const open = async () => {
      let version = item.version;
      if (dirty.has(item.id))
        ({ version } = await api(url("edit"), "POST", {
          version,
          action: {
            ...item.action,
            args: editedArgs(card, item.action.args),
          },
        }));
      await api(url("open"), "POST", { version });
    };
    buttons.append(
      button("Send…", "primary", () => act(card, open)),
      reject,
    );
  } else if (pending) buttons.append(...decisionButtons(card, pending));
  else
    card.append(
      node(
        "p",
        "waiting",
        item.state === "answered"
          ? "The assistant is working on your answer."
          : "Preparing the exact approval…",
      ),
    );
  card.append(buttons);
  return card;
}
function actionCard(action) {
  const card = node("article", "card");
  card.dataset.id = action.id;
  card.append(node("h3", "", label(action)), meta(action));
  appendSender(card, action);
  card.append(argFields(card, action.args, false));
  const buttons = node("div", "buttons");
  buttons.append(...decisionButtons(card, action));
  card.append(buttons);
  return card;
}

function renderApprovals({ items, actions, sender: currentSender }) {
  sender = currentSender;
  const pending = actions.filter((a) => a.canApprove);
  const visible = items.filter((i) => shown.includes(i.state));
  const claimed = new Set(visible.map((i) => i.fingerprint));
  const cards = [
    ...pending.filter((a) => !claimed.has(a.fingerprint)).map(actionCard),
    ...visible.map((item) =>
      itemCard(
        item,
        pending.find((a) => a.fingerprint === item.fingerprint),
      ),
    ),
  ];
  const waiting =
    cards.length -
    visible.filter(
      (i) =>
        ["opening", "answered"].includes(i.state) &&
        !pending.some((a) => a.fingerprint === i.fingerprint),
    ).length;
  $("approval-count").textContent = waiting || "";
  $("summary").textContent = waiting
    ? `${waiting} ${waiting === 1 ? "thing needs" : "things need"} you.`
    : "Nothing needs you right now.";
  document.title = waiting ? `(${waiting}) Assistant` : "Assistant";
  if (!cards.length) cards.push(node("p", "empty", "Nothing to approve."));
  $("approvals").replaceChildren(...cards);
}
function renderTodos(tasks) {
  const open = tasks.filter((t) => !["done", "archived"].includes(t.status));
  const rows = open.map((task) => {
    const row = node("li", "todo");
    const check = node("input");
    check.type = "checkbox";
    check.setAttribute("aria-label", "Done: " + task.title);
    check.addEventListener("change", async () => {
      check.disabled = true;
      try {
        await api("/api/tasks/" + task.id, "PATCH", {
          version: task.version,
          patch: { status: "done" },
        });
      } catch (e) {
        check.checked = false;
        toast(e.message);
      }
      await refresh();
    });
    const text = node("div", "todo-text");
    text.append(node("span", "", task.title));
    if (task.draft) text.append(node("p", "draft", task.draft));
    row.append(check, text);
    return row;
  });
  if (!rows.length) rows.push(node("li", "empty", "Nothing to do."));
  $("todos").replaceChildren(...rows);
}
$("today").textContent = new Date().toLocaleDateString("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
});
async function refresh() {
  if (busy) return;
  const [reviews, tasks] = await Promise.allSettled([
    api("/api/reviews"),
    api("/api/tasks"),
  ]);
  notice("approvals-error", reviews.reason);
  notice("todo-error", tasks.reason);
  if (reviews.value && !dirty.size) renderApprovals(reviews.value);
  if (reviews.value) renderHistory(reviews.value);
  if (tasks.value) renderTodos(tasks.value.tasks);
}

$("capture-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("capture").value;
  if (!text.trim()) return $("capture").focus();
  captureKey ??= crypto.randomUUID();
  $("capture-submit").disabled = true;
  try {
    await api("/api/tasks", "POST", { text, key: captureKey });
    if ($("capture").value === text) $("capture").value = "";
    captureKey = undefined;
    await refresh();
  } catch (e) {
    toast(e.message);
  } finally {
    $("capture-submit").disabled = false;
    $("capture").focus();
  }
});
$("capture").addEventListener("input", () => (captureKey = undefined));
$("capture").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!$("capture-submit").disabled) $("capture-form").requestSubmit();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (dirty.size || $("capture").value.trim()) e.preventDefault();
});
const token = new URLSearchParams(location.hash.slice(1)).get("token");
if (token) {
  history.replaceState(null, "", "/");
  try {
    await api("/api/session", "POST", { token });
  } catch (e) {
    toast(e.message);
  }
}
await refresh();
setInterval(refresh, 5000);

function appendSender(card, action) {
  if (action.server === "gmail-work-actions")
    card.append(node("p", "kind", "From: " + (action.args.from || sender)));
}
function beginRevision(card, action) {
  dirty.add(card.dataset.id);
  card.querySelector(".fields")?.remove();
  card.querySelector(".buttons")?.remove();
  card.append(argFields(card, action.args, true));
  const controls = node("div", "buttons");
  controls.append(
    button("Save revision", "primary", () =>
      act(
        card,
        () =>
          api("/api/reviews/revise", "POST", {
            id: action.id,
            approvalId: action.approvalId,
            reviewToken: action.reviewToken,
            title: action.args.subject || label(action),
            action: {
              server: action.server,
              tool: action.tool,
              args: editedArgs(card, action.args),
            },
          }),
        "Saved. The revised action needs a fresh approval.",
      ),
    ),
    button("Cancel", "", () => {
      dirty.delete(card.dataset.id);
      refresh();
    }),
  );
  card.append(controls);
}
function renderHistory({ items, actions }) {
  const states = new Set([
    "completed",
    "failed",
    "unknown",
    "blocked",
    "expired",
    "rejected",
  ]);
  const finished = actions.filter((a) => states.has(a.state));
  const linked = new Set(finished.map((a) => a.id));
  const rejected = items.filter(
    (i) => i.state === "rejected" && !linked.has(i.actionId),
  );
  const rows = finished.map(historyRow);
  for (const item of rejected)
    rows.push(node("p", "kind", item.title + " · Rejected"));
  if (!rows.length) rows.push(node("p", "empty", "No finished actions yet."));
  $("history").replaceChildren(...rows);
}
function historyRow(action) {
  const row = node("details", "history-row");
  row.append(
    node(
      "summary",
      "",
      `${action.args.subject || label(action)} · ${action.state}`,
    ),
  );
  const result = action.outcome?.result;
  const receipt =
    action.outcome?.message ||
    (result?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n") ||
    "No execution receipt recorded.";
  row.append(node("pre", "field", receipt));
  return row;
}
