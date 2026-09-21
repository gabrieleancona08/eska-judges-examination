/* ESKA Judges Examination – interface state; solutions stay on the server. */
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const cloud = Boolean(window.ESKA_SUPABASE) && !["localhost", "127.0.0.1"].includes(location.hostname);

const state = {
  language: "en",
  screen: "welcome",
  participant: null,
  admin: null,
  index: 0,
  answers: [],
  clockOffset: 0,
  polling: false,
  submitting: false,
  saving: Promise.resolve(),
  unsaved: false,
  textSaveTimer: null,
};

const labels = {
  en: {
    welcomeEyebrow: "Welcome to the digital dōjō",
    welcomeTitle: "Ready to put your<br><em>knowledge to the test?</em>",
    questions: "Exams + example", minutes: "Participant-friendly", pass: "Passing score",
    back: "Back", exam: "Karate examination", answered: "Question",
    previous: "Back", next: "Next question", finish: "Submit examination",
    complete: "Examination completed", score: "Score", correct: "Correct",
    wrong: "Errors", status: "Status", review: "Review answers",
    backResult: "Back to results", yourAnswers: "Your answers",
    reviewTitle: "Detailed review", footer: "Learn karate. Test your knowledge.",
    unlimited: "No time limit", passed: "Passed", failed: "Not passed",
  },
};

async function api(path, data) {
  if (cloud && path === "/api/login") return cloudLogin(data);
  const headers = data === undefined ? {} : { "Content-Type": "application/json" };
  let target = path;
  let body = data === undefined ? undefined : JSON.stringify(data);
  let method = data === undefined ? "GET" : "POST";
  if (cloud) {
    target = window.ESKA_SUPABASE.url + "/functions/v1/examination-api";
    method = "POST";
    body = JSON.stringify({ path, data: data || {} });
    headers["Content-Type"] = "application/json";
    headers.apikey = window.ESKA_SUPABASE.publishableKey;
    const adminToken = sessionStorage.getItem("eska_admin_token");
    const participantToken = sessionStorage.getItem("eska_participant_token");
    if (adminToken) headers.Authorization = "Bearer " + adminToken;
    if (participantToken) headers["X-Participant-Token"] = participantToken;
  }
  const response = await fetch(target, { method, credentials: cloud ? "omit" : "same-origin", headers, body });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || "The request failed. Please try again.");
    error.status = response.status;
    throw error;
  }
  if (cloud && payload.participantToken) sessionStorage.setItem("eska_participant_token", payload.participantToken);
  return payload;
}

async function cloudLogin(credentials) {
  const response = await fetch(window.ESKA_SUPABASE.url + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: window.ESKA_SUPABASE.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: credentials.username, password: credentials.password }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error_description || payload.msg || "Incorrect email or password.");
    error.status = response.status;
    throw error;
  }
  sessionStorage.setItem("eska_admin_token", payload.access_token);
  return { ok: true };
}

function csvCell(value) {
  const text = String(value ?? "");
  return '"' + (/^[=+\-@]/.test(text.trim()) ? "'" : "") + text.replaceAll('"', '""') + '"';
}

async function downloadResults() {
  const payload = await api("/api/admin/export");
  const heading = ["First name", "Last name", "Date of birth", "Nation", "Examination", "Status", "Correct", "Errors", "Percentage"];
  const lines = payload.rows.map((row) => {
    const result = row.result || {};
    const status = row.result ? (result.passed ? "Passed" : "Failed") : "Pending";
    return [row.firstName, row.lastName, row.birthDate, row.nation, row.examTitle, status,
      result.correct ?? "", result.errors ?? "", result.percent ?? ""].map(csvCell).join(";");
  });
  const blob = new Blob(["\ufeff" + [heading.map(csvCell).join(";"), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "examination-results.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function showScreen(id) {
  $$(".screen").forEach((screen) => screen.classList.toggle("active", screen.id === id));
  state.screen = id;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value);
  return element.innerHTML;
}

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 3000);
}

function translate() {
  document.documentElement.lang = state.language;
  $$("[data-i18n]").forEach((element) => {
    const value = labels[state.language][element.dataset.i18n];
    if (value) element.innerHTML = value;
  });
  if (state.screen === "quiz") renderQuestion();
  if (state.screen === "result") renderResult();
  if (state.screen === "review") renderReview();
}

function receiveParticipant(payload, restore = false) {
  state.participant = payload;
  state.clockOffset = payload.serverTime * 1000 - Date.now();
  if (restore) state.answers = payload.answers.slice();
  if (payload.needsSelection) {
    showScreen("examChoice");
    $("#choiceError").textContent = payload.status === "waiting" ? "" : "This session is closed. Please contact the administrator.";
    return;
  }
  if (payload.result) {
    if (!["result", "review"].includes(state.screen)) showScreen("result");
    renderResult();
    if (state.screen === "review") renderReview();
    return;
  }
  if (payload.status === "waiting") {
    $("#lobbyName").textContent = payload.name;
    $("#lobbyExam").textContent = payload.title;
    $("#lobbyTiming").textContent = payload.minutes ? payload.minutes + " minutes from the examination start" : "No time limit";
    $("#lobbyConnection").textContent = "● Connected – waiting for the administrator to start.";
    if (state.screen !== "lobby") showScreen("lobby");
  } else if (payload.status === "running" && state.screen !== "quiz") {
    showScreen("quiz");
    renderQuestion();
  }
  updateClock();
}

function renderQuestion() {
  const participant = state.participant;
  const total = participant.questions.length;
  const question = participant.questions[state.index][state.language];
  const metadata = participant.questions[state.index];
  $("#greeting").textContent = participant.name;
  $("#quiz [data-i18n=exam]").textContent = participant.title;
  $("#progressText").textContent = (state.index + 1) + " / " + total;
  $("#progressBar").style.width = ((state.index + 1) / total * 100) + "%";
  $("#questionNumber").textContent = String(state.index + 1).padStart(2, "0");
  $("#questionType").textContent = (metadata.type === "text" ? "WRITTEN ANSWER" : metadata.multiple ? "MULTIPLE CHOICE" : "SINGLE CHOICE") + " · SOURCE Q" + metadata.sourceNumber;
  $("#questionText").textContent = question.text;
  if (metadata.type === "text") {
    $("#answers").innerHTML = '<label class="answer-hint" for="writtenAnswer">Write ' + metadata.required +
      ' distinct items in English, one per line. Automatically marked; minor spelling errors and supported wording variants are accepted.</label><textarea id="writtenAnswer" rows="8" maxlength="4000" placeholder="Write one item per line…"></textarea>';
    $("#writtenAnswer").value = state.answers[state.index] || "";
  } else {
    const chosen = state.answers[state.index];
    const selectedAnswers = Array.isArray(chosen) ? chosen : (chosen === null ? [] : [chosen]);
    const hint = metadata.multiple ? (metadata.id === "eska-24" ? "Select at least one valid answer." : "Select " + metadata.minimumCorrect + " answers.") : "Select one answer.";
    $("#answers").innerHTML = '<p class="answer-hint">' + hint + '</p>' + question.options.map((option, index) => {
    const selected = selectedAnswers.includes(index);
    return '<button class="answer ' + (selected ? "selected" : "") + '" data-answer="' + index +
      '" aria-pressed="' + selected + '"><span class="letter">' + String.fromCharCode(65 + index) +
      '</span><span>' + escapeHtml(option) + '</span></button>';
  }).join("");
  }
  $("#prevBtn").disabled = state.index === 0;
  $("#nextBtn span:first-child").textContent = labels[state.language][state.index === total - 1 ? "finish" : "next"];
  updateClock();
}

function saveAnswers() {
  const snapshot = state.answers.map((answer) => Array.isArray(answer) ? answer.slice() : answer);
  state.unsaved = true;
  // Save sequentially so older answers cannot overwrite newer ones.
  state.saving = state.saving.catch(() => {}).then(async () => {
    const payload = await api("/api/answers", { answers: snapshot });
    state.unsaved = JSON.stringify(snapshot) !== JSON.stringify(state.answers);
    receiveParticipant(payload);
  });
  state.saving.catch(() => toast("Your answer has not been saved yet. Please check your connection."));
}

function updateClock() {
  const participant = state.participant;
  if (!participant || participant.result || state.screen !== "quiz") return;
  const timer = $("#timer");
  if (!participant.deadline) {
    timer.textContent = labels[state.language].unlimited;
    timer.classList.remove("urgent");
    return;
  }
  const seconds = Math.max(0, Math.ceil((participant.deadline * 1000 - Date.now() - state.clockOffset) / 1000));
  timer.textContent = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  timer.classList.toggle("urgent", seconds <= 60);
  if (seconds === 0 && !state.polling) poll();
}

async function submit() {
  if (state.submitting) return;
  state.submitting = true;
  clearTimeout(state.textSaveTimer);
  $("#nextBtn").disabled = true;
  try {
    await state.saving.catch(() => {});
    receiveParticipant(await api("/api/submit", { answers: state.answers }));
    state.unsaved = false;
  } catch (error) {
    toast(error.message + " Your submission has not been confirmed yet.");
  } finally {
    state.submitting = false;
    $("#nextBtn").disabled = false;
  }
}

function renderResult() {
  const { result, name } = state.participant;
  const words = labels[state.language];
  $("#resultTitle").textContent = "Examination completed, " + name + ".";
  const pending = result.pending > 0;
  $("#resultMessage").textContent = pending ? "Submitted. " + result.pending + " written responses are awaiting administrator review." : result.passed ? words.passed : words.failed;
  $("#scorePercent").textContent = pending ? "—" : result.percent + "%";
  $("#scoreRing").style.setProperty("--score", pending ? 0 : result.percent);
  $("#correctCount").textContent = result.correct + " / " + result.total;
  $("#wrongCount").textContent = result.errors + " / " + result.total;
  $("#statusText").textContent = pending ? "Awaiting review" : result.passed ? words.passed : words.failed;
  $("#statusText").style.color = pending ? "var(--muted)" : result.passed ? "var(--green)" : "var(--red)";
  $(".result-icon").textContent = pending ? "◎" : result.passed ? "✓" : "×";
}

function renderReview() {
  const participant = state.participant;
  $("#reviewList").innerHTML = participant.questions.map((entry, index) => {
    const question = entry[state.language];
    const solution = participant.result.solutions[index];
    const answer = participant.answers[index];
    const metadata = participant.questions[index];
    const selected = Array.isArray(answer) ? answer : (answer === null ? [] : [answer]);
    const accepted = Array.isArray(solution) ? solution : [solution];
    const mark = participant.result.marks ? participant.result.marks[index] : answer === solution;
    const responseText = metadata.type === "text" ? (answer || "—") : selected.map((item) => question.options[item]).join("; ") || "—";
    const solutionText = metadata.type === "text" ? accepted.join("; ") : accepted.map((item) => question.options[item]).join("; ");
    return '<article class="review-item ' + (mark === false ? "wrong" : "") + '">' +
      '<span class="eyebrow">' + (index + 1) + ' · ' + (mark === null ? "AWAITING REVIEW" : mark ? "✓" : "×") + '</span>' +
      '<h3>' + escapeHtml(question.text) + '</h3><p>' +
      "Your answer: " +
      escapeHtml(responseText) + '</p><p>' +
      (metadata.type === "text" ? "Accepted examples: " : "Correct answer: ") +
      '<strong>' + escapeHtml(solutionText) + '</strong></p></article>';
  }).join("");
}

function renderAdmin(payload) {
  state.admin = payload;
  const session = payload.session;
  const active = session && session.status !== "closed";
  const selection = $("#examSelect");
  const selectedKey = active ? session.exam_key : selection.value;
  selection.innerHTML = payload.exams.map((exam) =>
    '<option value="' + exam.id + '" ' + (exam.available ? "" : "disabled") + '>' + escapeHtml(exam.title) + '</option>'
  ).join("");
  if (selectedKey) selection.value = selectedKey;
  $("#examNotice").textContent = payload.exams.find((exam) => exam.id === selection.value)?.notice || "";
  selection.disabled = Boolean(active);
  $("#timeLimit").disabled = Boolean(active);
  if (active) $("#timeLimit").value = String(session.minutes);
  $("#activateBtn").disabled = Boolean(active);
  $("#qrPanel").hidden = !active;
  if (!active && $("#qrDialog").open) $("#qrDialog").close();
  $("#sessionCode").textContent = active ? "Session active" : "New session";
  $("#sessionBtn").disabled = !session || session.status !== "waiting";
  if (active) {
    if (cloud) {
      const qrKey = session.id + "@" + location.origin;
      if ($("#adminQr").dataset.qrKey !== qrKey) loadCloudQr(session.id, qrKey);
    } else {
      const qrUrl = "/api/admin/qr?exam=" + encodeURIComponent(session.id);
      if ($("#adminQr").getAttribute("src") !== qrUrl) $("#adminQr").src = qrUrl;
      if ($("#qrDialog").open && $("#largeQr").getAttribute("src") !== qrUrl) $("#largeQr").src = qrUrl;
    }
  }
  const rows = payload.participants;
  const completed = rows.filter((row) => row.result && !row.result.pending);
  const passed = completed.filter((row) => row.result.passed).length;
  $("#adminTotal").textContent = rows.length;
  $("#adminPassed").textContent = passed;
  $("#adminFailed").textContent = completed.length - passed;
  $("#adminAverage").textContent = completed.length ?
    Math.round(completed.reduce((sum, row) => sum + row.result.percent, 0) / completed.length) + "%" : "—";
  $("#sessionStatus").textContent = !session ? "No examination session yet" : {
    waiting: "● Registration open – participants are waiting in the lobby",
    running: "● Examination in progress – registration closed",
    closed: "Examination session closed",
  }[session.status];
  $("#resultsBody").innerHTML = rows.map((row) => {
    const result = row.result;
    const status = result ? (result.pending ? "AWAITING REVIEW" : result.passed ? "PASSED" : "FAILED") :
      (session.status === "waiting" ? "WAITING" : "IN PROGRESS");
    return '<tr><td><strong>' + escapeHtml(row.firstName + " " + row.lastName) + '</strong></td><td>' +
      escapeHtml(row.birthDate) + '</td><td>' + escapeHtml(row.nation) + '</td><td>' + escapeHtml(row.examTitle) + '</td><td><span class="badge ' +
      (result && !result.pending && !result.passed ? "fail" : "") + '">' + status + '</span>' +
      (result && result.pending ? '<button class="review-button" data-review="' + row.id + '">Review written answers</button>' : '') + '</td><td>' +
      (result ? result.correct + " / " + result.total : "—") + '</td><td>' +
      (result ? result.errors : "—") + '</td><td>' + (result && !result.pending ? result.percent + "%" : "—") + '</td></tr>';
  }).join("");
  $("#emptyResults").style.display = rows.length ? "none" : "block";
}

async function loadCloudQr(examId, qrKey) {
  try {
    const payload = await api("/api/admin/qr", { examId, publicOrigin: location.origin });
    $("#adminQr").src = payload.dataUrl;
    $("#adminQr").dataset.qrKey = qrKey;
    if ($("#qrDialog").open) $("#largeQr").src = payload.dataUrl;
  } catch (error) {
    $("#adminError").textContent = error.message;
  }
}

async function openAdmin() {
  try {
    renderAdmin(await api("/api/admin/state"));
    showScreen("admin");
  } catch (error) {
    showScreen("adminLogin");
    if (error.status !== 401) $("#loginError").textContent = error.message;
  }
}

async function poll() {
  if (state.polling) return;
  state.polling = true;
  try {
    if (state.screen === "admin") {
      renderAdmin(await api("/api/admin/state"));
    } else if (state.participant && (["lobby", "quiz"].includes(state.screen) || state.participant.result?.pending && ["result", "review"].includes(state.screen))) {
      if (state.unsaved && !state.submitting) {
        await state.saving.catch(() => {});
        const payload = await api("/api/answers", { answers: state.answers });
        state.unsaved = false;
        receiveParticipant(payload);
      } else {
        receiveParticipant(await api("/api/participant"));
      }
    }
  } catch (error) {
    if (error.status === 401 && state.screen === "admin") showScreen("adminLogin");
    if (state.screen === "lobby") $("#lobbyConnection").textContent = "Connection lost – trying to reconnect automatically.";
    if (state.screen === "quiz") $("#greeting").textContent = "Connection lost – please check your Wi-Fi.";
  } finally {
    state.polling = false;
  }
}

async function handleAction(action) {
  $("#adminError").textContent = "";
  try {
    if (action === "home") showScreen("welcome");
    if (action === "teacher") await openAdmin();
    if (action === "enlarge-qr") {
      $("#largeQr").src = $("#adminQr").getAttribute("src");
      $("#qrDialog").showModal();
    }
    if (action === "close-qr") $("#qrDialog").close();
    if (action === "close-grading") $("#gradingDialog").close();
    if (action === "activate") {
      await api("/api/admin/activate", { examKey: $("#examSelect").value, minutes: Number($("#timeLimit").value) });
      renderAdmin(await api("/api/admin/state"));
    }
    if (action === "session" || action === "close") {
      if (action === "close" && !confirm("Close this examination session? Unfinished examinations will be graded using the saved answers.")) return;
      await api(action === "session" ? "/api/admin/start" : "/api/admin/close", { examId: state.admin.session.id });
      renderAdmin(await api("/api/admin/state"));
    }
    if (action === "copy") {
      await navigator.clipboard.writeText(location.origin + "/?join=" + encodeURIComponent(state.admin.session.id));
      toast("Participant link copied.");
    }
    if (action === "download") cloud ? await downloadResults() : window.location.assign("/api/admin/export");
    if (action === "logout") {
      await api("/api/admin/logout", {});
      if (cloud) sessionStorage.removeItem("eska_admin_token");
      state.admin = null;
      showScreen("welcome");
    }
    if (action === "prev" && state.index > 0) {
      state.index--;
      renderQuestion();
    }
    if (action === "next") {
      if (state.index < state.participant.questions.length - 1) {
        state.index++;
        renderQuestion();
      } else if (confirm("Submit examination? Unanswered questions count as errors.")) {
        await submit();
      }
    }
    if (action === "review") {
      renderReview();
      showScreen("review");
    }
    if (action === "result") showScreen("result");
  } catch (error) {
    if (state.screen === "admin") $("#adminError").textContent = error.message;
    else toast(error.message);
  }
}

document.addEventListener("click", (event) => {
  const answer = event.target.closest("[data-answer]");
  if (answer && !state.submitting) {
    const index = Number(answer.dataset.answer);
    const question = state.participant.questions[state.index];
    const current = state.answers[state.index];
    const selected = Array.isArray(current) ? current : (current === null ? [] : [current]);
    state.answers[state.index] = question.multiple ?
      (selected.includes(index) ? selected.filter((item) => item !== index) : [...selected, index]) : [index];
    renderQuestion();
    saveAnswers();
  }
  const button = event.target.closest("[data-action]");
  if (button) handleAction(button.dataset.action);
  const review = event.target.closest("[data-review]");
  if (review) openGrading(review.dataset.review);
});

document.addEventListener("input", (event) => {
  if (event.target.id === "writtenAnswer" && !state.submitting) {
    state.answers[state.index] = event.target.value;
    state.unsaved = true;
    clearTimeout(state.textSaveTimer);
    state.textSaveTimer = setTimeout(saveAnswers, 350);
  }
});

async function openGrading(participantId) {
  try {
    const payload = await api("/api/admin/review?participant=" + encodeURIComponent(participantId));
    state.review = payload;
    $("#gradingTitle").textContent = "Review: " + payload.name;
    $("#gradingError").textContent = "";
    $("#gradingQuestions").innerHTML = payload.questions.map((question) =>
      '<article class="grading-item"><h3>Source Q' + question.sourceNumber + ': ' + escapeHtml(question.text) +
      '</h3><p class="answer-hint">Requires ' + question.required + ' valid items. One point for a complete correct response.</p>' +
      '<h4>Participant response</h4><p class="written-response">' + escapeHtml(question.answer) +
      '</p><h4>Accepted answers from the supplied document</h4><ul>' + question.rubric.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') +
      '</ul><div class="grading-options"><label><input type="radio" name="' + question.id + '" value="true" required /> Correct</label>' +
      '<label><input type="radio" name="' + question.id + '" value="false" required /> Incorrect / incomplete</label></div></article>'
    ).join("");
    $("#gradingDialog").showModal();
  } catch (error) {
    $("#adminError").textContent = error.message;
  }
}

$("#gradingForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const values = new FormData(event.target);
    const decisions = Object.fromEntries(state.review.questions.map((question) => [question.id, values.get(question.id) === "true"]));
    await api("/api/admin/review", { participantId: state.review.participantId, decisions });
    $("#gradingDialog").close();
    renderAdmin(await api("/api/admin/state"));
  } catch (error) {
    $("#gradingError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#adminLoginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("#loginError").textContent = "";
  try {
    await api("/api/login", { username: $("#username").value.trim(), password: $("#password").value });
    $("#password").value = "";
    await openAdmin();
  } catch (error) {
    $("#loginError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#nameForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("#joinError").textContent = "";
  try {
    await api("/api/join", {
      examId: new URLSearchParams(location.search).get("join"),
      firstName: $("#firstName").value.trim(), lastName: $("#lastName").value.trim(),
      birthDate: $("#birthDate").value, nation: $("#nation").value,
    });
    receiveParticipant(await api("/api/participant"), true);
  } catch (error) {
    $("#joinError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#examChoiceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("#choiceError").textContent = "";
  try {
    await api("/api/select-exam", { examKey: $("#participantExam").value });
    receiveParticipant(await api("/api/participant"), true);
  } catch (error) {
    $("#choiceError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#examSelect").addEventListener("change", () => {
  $("#examNotice").textContent = state.admin.exams.find((exam) => exam.id === $("#examSelect").value)?.notice || "";
});

async function initialize() {
  if (cloud) {
    $("#adminIdentityLabel").textContent = "Email address";
    $("#username").type = "email";
  }
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const countries = [];
  for (let first = 65; first <= 90; first++) {
    for (let second = 65; second <= 90; second++) {
      const code = String.fromCharCode(first, second);
      const name = names.of(code);
      if (name !== code && !["EU", "EZ", "UN", "XA", "XB"].includes(code)) countries.push({ code, name });
    }
  }
  countries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  $("#nation").insertAdjacentHTML("beforeend", countries.map(({ code, name }) =>
    '<option value="' + code + '">' + escapeHtml(name) + '</option>'
  ).join(""));
  $("#birthDate").max = new Date().toLocaleDateString("en-CA");
  translate();
  const examId = new URLSearchParams(location.search).get("join");
  if (examId) {
    try {
      const payload = await api("/api/participant");
      if (payload.examId === examId) receiveParticipant(payload, true);
      else showScreen("login");
    } catch {
      showScreen("login");
    }
  }
  setInterval(poll, 2000);
  setInterval(updateClock, 1000);
}

initialize();
