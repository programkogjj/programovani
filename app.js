/* =====================================================================
   Test: Základy Pythonu – logika aplikace
   Třídy v DOM odpovídají BEM blokům ze style.css.
   ===================================================================== */
(function () {
  "use strict";

  /* ===================================================================
     KONFIGURACE
     =================================================================== */
  // URL nasazeného Google Apps Script Web App (končí na /exec)
  const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyAPcOpXSFKQzZn5taiehZ9-K0-Ln2eG5DsuTAdjb2r47GVdX3qb2OKeiRs4eR4ZNaUvw/exec";

  // Novější Pyodide než 0.23.4 – rychlejší start, Python 3.12
  const PYODIDE_VERSION = "0.26.4";
  const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
  const RUN_TIMEOUT_MS = 8000;               // limit běhu jednoho spuštění
  const STORAGE_KEY = "python-test-v2";      // rozpracovaný test (sessionStorage = jen do zavření karty)
  const DEVICE_KEY = "python-test-device";   // trvalé ID prohlížeče (localStorage)

  /* ===================================================================
     STAV
     Zadání úloh NENÍ v aplikaci – server ho pošle až po platném zahájení.
     =================================================================== */
  const state = {
    student: null,        // {jmeno, prijmeni, trida}
    startedAt: null,
    sessionId: null,      // ID relace přidělené serverem při zahájení
    tasks: [],            // zadání ze serveru
    answers: [],
    violations: [],       // opuštění okna, pokusy o kopírování apod.
    submitted: false,
  };

  /* ===================================================================
     POMOCNÉ FUNKCE
     =================================================================== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => root.querySelectorAll(sel);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // BEM modifikátor: setMod(el, "screen", "hidden", true) → class "screen--hidden"
  function setMod(el, block, mod, on) {
    el.classList.toggle(`${block}--${mod}`, on);
  }
  const hasMod = (el, block, mod) => el.classList.contains(`${block}--${mod}`);

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    setMod(t, "toast", "visible", true);
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => setMod(t, "toast", "visible", false), 2200);
  }

  function save() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* nedostupné */ }
  }
  function load() {
    try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null"); } catch (_) { return null; }
  }
  function clearSaved() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) { /* nedostupné */ }
  }

  function logViolation(type) {
    if (!state.student || state.submitted) return;
    state.violations.push({ type, time: new Date().toISOString() });
    save();
  }

  /* ===================================================================
     PYTHON VE WEB WORKERU
     Běží mimo hlavní vlákno: UI nezamrzá a nekonečnou smyčku lze ukončit.
     Kód workeru je tato funkce; spouští se z Blobu (není třeba další soubor).
     =================================================================== */
  function pythonWorker() {
    let pyodide = null;

    function cleanTraceback(msg) {
      // Odstraní interní řádky Pyodide, ponechá jen chybu ze studentova kódu
      const lines = String(msg).split("\n");
      const start = lines.findIndex((l) => l.includes('File "<exec>"'));
      if (start === -1) return lines.filter((l) => l.trim()).slice(-1).join("\n");
      return "Traceback (most recent call last):\n" + lines.slice(start).join("\n").trim();
    }

    self.onmessage = async (e) => {
      const m = e.data;

      if (m.type === "init") {
        try {
          importScripts(m.url);
          pyodide = await loadPyodide({ indexURL: m.indexURL });
          postMessage({ type: "ready", version: pyodide.version });
        } catch (err) {
          postMessage({ type: "init-error", error: String(err) });
        }
        return;
      }

      if (m.type === "run") {
        let out = "";
        const lines = m.stdin === "" ? [] : m.stdin.replace(/\r/g, "").split("\n");
        let i = 0;
        // Jako v terminálu: zadaná hodnota se vypíše za výzvu input() a odřádkuje se
        pyodide.setStdin({
          stdin: () => {
            if (i >= lines.length) return undefined;
            const line = lines[i++];
            out += line + "\n";
            return line;
          },
        });
        const write = (buf) => { out += new TextDecoder().decode(buf); return buf.length; };
        pyodide.setStdout({ write });
        pyodide.setStderr({ write });

        const globals = pyodide.globals.get("dict")();
        try {
          await pyodide.runPythonAsync(m.code, { globals });
          postMessage({ type: "result", id: m.id, out, error: null });
        } catch (err) {
          let msg = cleanTraceback(err.message);
          if (msg.includes("EOFError")) {
            msg += "\n\nTip: program volá input() vícekrát, než kolik řádků je v poli „Vstup programu“.";
          }
          postMessage({ type: "result", id: m.id, out, error: msg });
        } finally {
          globals.destroy();
        }
      }
    };
  }

  const WORKER_URL = URL.createObjectURL(
    new Blob([`(${pythonWorker.toString()})();`], { type: "text/javascript" })
  );

  let worker = null;
  let pyReady = false;
  let runSeq = 0;
  const pending = new Map();

  function setPyStatus(text, mod) {
    $("#py-status").textContent = text;
    const dot = $("#py-dot");
    setMod(dot, "status-dot", "ready", mod === "ready");
    setMod(dot, "status-dot", "error", mod === "error");
  }

  function setRunButtonsDisabled(disabled) {
    $$(".js-run").forEach((b) => (b.disabled = disabled));
  }

  function startWorker() {
    pyReady = false;
    setPyStatus("Načítám Python…");
    worker = new Worker(WORKER_URL);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") {
        pyReady = true;
        setPyStatus("Python připraven", "ready");
        setRunButtonsDisabled(false);
      } else if (m.type === "init-error") {
        setPyStatus("Python se nepodařilo načíst", "error");
        toast("Chyba načtení Pythonu – zkontroluj připojení a obnov stránku.");
      } else if (m.type === "result") {
        const p = pending.get(m.id);
        if (p) { clearTimeout(p.timer); pending.delete(m.id); p.resolve(m); }
      }
    };
    worker.postMessage({ type: "init", url: PYODIDE_BASE + "pyodide.js", indexURL: PYODIDE_BASE });
  }

  function runPython(code, stdin) {
    return new Promise((resolve) => {
      const id = ++runSeq;
      const timer = setTimeout(() => {
        pending.delete(id);
        worker.terminate();
        resolve({ out: "", error: `Program běžel déle než ${RUN_TIMEOUT_MS / 1000} s a byl ukončen (nekonečná smyčka?).` });
        setRunButtonsDisabled(true);
        startWorker();
      }, RUN_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      worker.postMessage({ type: "run", id, code, stdin });
    });
  }

  /* ===================================================================
     EDITOR KÓDU
     =================================================================== */
  function updateGutter(input, gutter) {
    const n = input.value.split("\n").length;
    let s = "";
    for (let i = 1; i <= n; i++) s += i + "\n";
    gutter.textContent = s;
    gutter.scrollTop = input.scrollTop;
  }

  function setupEditor(input, gutter, onChange) {
    const INDENT = "    ";
    input.addEventListener("keydown", (e) => {
      // Tab / Shift+Tab = odsazení
      if (e.key === "Tab") {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: en, value: v } = input;
        if (e.shiftKey) {
          const lineStart = v.lastIndexOf("\n", s - 1) + 1;
          const m = v.slice(lineStart).match(/^ {1,4}/);
          if (m) {
            input.setRangeText("", lineStart, lineStart + m[0].length, "end");
            input.selectionStart = input.selectionEnd = Math.max(lineStart, s - m[0].length);
          }
        } else {
          input.setRangeText(INDENT, s, en, "end");
        }
        onChange();
      }
      // Enter = zachová odsazení, za dvojtečkou přidá další úroveň
      else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: en, value: v } = input;
        const lineStart = v.lastIndexOf("\n", s - 1) + 1;
        const line = v.slice(lineStart, s);
        let indent = line.match(/^\s*/)[0];
        if (/:\s*$/.test(line)) indent += INDENT;
        input.setRangeText("\n" + indent, s, en, "end");
        onChange();
      }
    });
    input.addEventListener("input", onChange);
    input.addEventListener("scroll", () => (gutter.scrollTop = input.scrollTop));
    updateGutter(input, gutter);
  }

  /* ===================================================================
     VYKRESLENÍ ÚLOH  (blok .task + .editor + .console)
     =================================================================== */
  function taskTemplate(t, i, a) {
    return `
      <div class="task__head">
        <span class="task__number">Úloha ${i + 1} / ${state.tasks.length}</span>
        <span class="task__status${a.runs ? " task__status--ran" : ""}">${a.runs ? "✓ spuštěno" : "nespuštěno"}</span>
      </div>
      <h2 class="task__title">${esc(t.title)}</h2>
      <div class="task__text">${t.html}</div>
      <div class="editor">
        <div class="editor__gutter"></div>
        <textarea class="editor__input" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" aria-label="Kód úlohy ${i + 1}"></textarea>
      </div>
      <div class="task__stdin">
        <label class="task__stdin-label">Vstup programu pro <code class="inline-code">input()</code> (každý řádek = jedno volání)</label>
        <textarea class="task__stdin-input" rows="1" spellcheck="false"></textarea>
      </div>
      <div class="task__actions">
        <button class="button js-run" ${pyReady ? "" : "disabled"}>▶ Spustit kód</button>
        <button class="button button--secondary js-clear">Vymazat výstup</button>
      </div>
      <div class="console"><span class="console__label">Výstup</span><span class="console__output"><span class="console__info">Zatím nic nespuštěno.</span></span></div>`;
  }

  function renderTasks() {
    const root = $("#tasks");
    root.innerHTML = "";

    state.tasks.forEach((t, i) => {
      const a = state.answers[i];
      const card = document.createElement("article");
      card.className = "card task";
      card.innerHTML = taskTemplate(t, i, a);
      root.appendChild(card);

      const input = $(".editor__input", card);
      const gutter = $(".editor__gutter", card);
      const stdin = $(".task__stdin-input", card);
      const out = $(".console__output", card);
      const status = $(".task__status", card);
      const runBtn = $(".js-run", card);

      input.value = a.code;
      stdin.value = a.stdin;
      if (a.output) out.innerHTML = a.output;

      setupEditor(input, gutter, () => { a.code = input.value; updateGutter(input, gutter); save(); });
      stdin.addEventListener("input", () => { a.stdin = stdin.value; save(); });

      runBtn.addEventListener("click", async () => {
        if (!pyReady) return;
        runBtn.disabled = true;
        runBtn.textContent = "Běží…";
        out.innerHTML = `<span class="console__info">Spouštím…</span>`;

        const res = await runPython(input.value, stdin.value);
        let html = res.out ? esc(res.out) : "";
        if (res.error) {
          html += (html && !html.endsWith("\n") ? "\n" : "") + `<span class="console__error">${esc(res.error)}</span>`;
        }
        if (!html) html = `<span class="console__info">(Program nic nevypsal.)</span>`;

        out.innerHTML = html;
        a.output = html;
        a.lastResult = (res.out || "") + (res.error ? "\n[CHYBA]\n" + res.error : "");
        a.runs++;
        status.textContent = "✓ spuštěno";
        setMod(status, "task__status", "ran", true);
        runBtn.textContent = "▶ Spustit kód";
        runBtn.disabled = !pyReady;
        save();
      });

      $(".js-clear", card).addEventListener("click", () => {
        out.innerHTML = `<span class="console__info">Výstup vymazán.</span>`;
        a.output = "";
        save();
      });
    });
  }

  /* ===================================================================
     BEZPEČNOSTNÍ OPATŘENÍ
     =================================================================== */
  function showShield(title, text) {
    if (!state.student || state.submitted) return;
    $("#shield-title").textContent = title;
    $("#shield-text").textContent = text;
    setMod($("#shield"), "shield", "hidden", false);
  }

  function testActive() {
    return Boolean(state.student) && !state.submitted && !hasMod($("#screen-test"), "screen", "hidden");
  }

  function bindSecurity() {
    $("#shield-btn").addEventListener("click", () => setMod($("#shield"), "shield", "hidden", true));

    // Kopírování / vložení / vyjmutí / přetažení – blokováno v celém testu
    const names = { copy: "Kopírování", cut: "Vyjmutí", paste: "Vkládání", drop: "Přetahování", dragstart: "Přetahování" };
    Object.keys(names).forEach((ev) =>
      document.addEventListener(ev, (e) => {
        if (!testActive()) return;
        e.preventDefault();
        toast(`${names[ev]} není v testu povoleno.`);
        logViolation(ev);
      }, true)
    );

    document.addEventListener("contextmenu", (e) => {
      if (!testActive()) return;
      e.preventDefault();
      toast("Kontextová nabídka je vypnutá.");
    }, true);

    // Klávesové zkratky
    document.addEventListener("keydown", (e) => {
      if (!testActive()) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;

      // Tisk, uložení, zdrojový kód, vývojářské nástroje
      if ((mod && ["p", "s", "u"].includes(k)) || k === "f12" ||
          (mod && e.shiftKey && ["i", "j", "c"].includes(k))) {
        e.preventDefault();
        toast("Tato zkratka je v testu zakázána.");
        logViolation("shortcut:" + (mod ? "ctrl+" : "") + (e.shiftKey ? "shift+" : "") + k);
        return;
      }
      // macOS snímky obrazovky Cmd+Shift+3/4/5
      if (e.metaKey && e.shiftKey && ["3", "4", "5"].includes(e.key)) {
        e.preventDefault();
        showShield("Snímek obrazovky není povolen", "Pokus o snímek obrazovky byl zaznamenán.");
        logViolation("screenshot:mac");
        return;
      }
      // Záložní blokace Ctrl+C / V / X i v případě, že prohlížeč nevyvolá událost
      if (mod && ["c", "v", "x"].includes(k)) {
        e.preventDefault();
        toast("Kopírování a vkládání není povoleno.");
        logViolation("shortcut:ctrl+" + k);
      }
    }, true);

    // PrintScreen – prohlížeč jej hlásí až při uvolnění klávesy
    document.addEventListener("keyup", (e) => {
      if (!testActive()) return;
      if (e.key === "PrintScreen" || e.code === "PrintScreen") {
        try { if (navigator.clipboard) navigator.clipboard.writeText(""); } catch (_) { /* nepovoleno */ }
        showShield("Snímek obrazovky není povolen", "Pokus o snímek obrazovky byl zaznamenán.");
        logViolation("screenshot:printscreen");
      }
    }, true);

    // Opuštění okna (přepnutí karty, Alt+Tab, Win+Shift+S, nástroj na výstřižky…)
    window.addEventListener("blur", () => {
      if (!testActive()) return;
      showShield("Test je skrytý", "Opustil(a) jsi okno testu. Událost byla zaznamenána.");
      logViolation("blur");
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && testActive()) logViolation("tab-hidden");
    });
    window.addEventListener("beforeprint", () => logViolation("print"));

    // Varování při zavírání stránky během testu
    window.addEventListener("beforeunload", (e) => {
      if (testActive()) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  /* ===================================================================
     KOMUNIKACE SE SERVEREM (Google Apps Script)
     =================================================================== */
  // Trvalý identifikátor prohlížeče na tomto počítači (pro odhalení opakovaných startů)
  function deviceId() {
    try {
      let id = localStorage.getItem(DEVICE_KEY);
      if (!id) {
        id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
        localStorage.setItem(DEVICE_KEY, id);
      }
      return id;
    } catch (_) {
      return "";
    }
  }

  async function callServer(payload) {
    if (APPS_SCRIPT_URL.startsWith("VLOZ")) throw new Error("Není nastaven APPS_SCRIPT_URL.");
    let res;
    try {
      // text/plain = „jednoduchý“ požadavek bez CORS preflightu, který Apps Script nepodporuje
      res = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
    } catch (_) {
      throw new Error("Server nedostupný – zkontroluj připojení k internetu.");
    }
    const data = await res.json().catch(() => ({}));
    if (data.status !== "ok") throw new Error(data.message || "Server odpověděl neočekávaně.");
    return data;
  }

  /* ===================================================================
     ÚVOD → TEST
     =================================================================== */
  let timerInt = null;

  function startTimer() {
    clearInterval(timerInt);
    const tick = () => {
      const s = Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      $("#timer").textContent = `${mm}:${ss}`;
    };
    tick();
    timerInt = setInterval(tick, 1000);
  }

  function showScreen(id) {
    ["#screen-start", "#screen-test", "#screen-done"].forEach((sel) =>
      setMod($(sel), "screen", "hidden", sel !== id));
    window.scrollTo(0, 0);
  }

  function enterTest() {
    showScreen("#screen-test");
    const st = state.student;
    $("#student-label").textContent = `${st.jmeno} ${st.prijmeni} · ${st.trida}`;
    renderTasks();
    startTimer();
    if (!worker) startWorker();
  }

  function bindStart() {
    $("#start-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const jmeno = $("#jmeno").value.trim();
      const prijmeni = $("#prijmeni").value.trim();
      const trida = $("#trida").value.trim();
      const kod = $("#kod").value.trim();
      const err = $("#form-error");

      if (!jmeno || !prijmeni || !trida) {
        err.textContent = "Vyplň prosím jméno, příjmení i třídu.";
        return;
      }

      const btn = $("#btn-start");
      btn.disabled = true;
      btn.textContent = "Ověřuji…";
      err.textContent = "";

      try {
        // Zahájení se eviduje na serveru; zadání přijde až teď
        const data = await callServer({ action: "start", jmeno, prijmeni, trida, kod, zarizeni: deviceId() });
        state.tasks = data.tasks;
        state.answers = data.tasks.map((t) => ({ code: t.starter, stdin: t.stdin || "", output: "", runs: 0 }));
        state.sessionId = data.sessionId;
        state.student = { jmeno, prijmeni, trida };
        state.startedAt = data.startedAt;
        save();
        enterTest();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = "Zahájit test";
      }
    });
  }

  // Obnovení rozpracovaného testu po náhodném obnovení stránky
  function restore() {
    const saved = load();
    const valid = saved && saved.student && saved.sessionId && !saved.submitted &&
      Array.isArray(saved.tasks) && saved.tasks.length &&
      Array.isArray(saved.answers) && saved.answers.length === saved.tasks.length;
    if (!valid) return;
    Object.assign(state, saved);
    state.violations.push({ type: "page-reload", time: new Date().toISOString() });
    enterTest();
    toast("Rozpracovaný test byl obnoven.");
  }

  /* ===================================================================
     ODESLÁNÍ
     =================================================================== */
  function buildPayload() {
    const odeslano = new Date();
    return {
      action: "submit",
      sessionId: state.sessionId,
      jmeno: state.student.jmeno,
      prijmeni: state.student.prijmeni,
      trida: state.student.trida,
      zahajeno: state.startedAt,
      odeslano: odeslano.toISOString(),
      odeslano_mistni: odeslano.toLocaleString("cs-CZ", { timeZone: "Europe/Prague" }),
      doba_minut: Math.round((odeslano - new Date(state.startedAt)) / 60000),
      odpovedi: state.tasks.map((t, i) => ({
        uloha: i + 1,
        nazev: t.title,
        kod: state.answers[i].code,
        vstup: state.answers[i].stdin,
        posledni_vystup: state.answers[i].lastResult || "",
        pocet_spusteni: state.answers[i].runs,
      })),
      poruseni: state.violations,
    };
  }

  function payloadToText(p) {
    const L = [];
    L.push("TEST: ZÁKLADY PYTHONU", "=".repeat(60));
    L.push(`Student:   ${p.jmeno} ${p.prijmeni}`);
    L.push(`Třída:     ${p.trida}`);
    L.push(`Odesláno:  ${p.odeslano_mistni}`);
    L.push(`Doba:      ${p.doba_minut} min`);
    L.push(`Porušení:  ${p.poruseni.length}`);
    p.odpovedi.forEach((o) => {
      L.push("", "=".repeat(60), `ÚLOHA ${o.uloha}: ${o.nazev}  (spuštěno ${o.pocet_spusteni}×)`, "-".repeat(60));
      L.push(o.kod || "(prázdné)");
      if (o.vstup) L.push("-".repeat(60), "Vstup:", o.vstup);
      L.push("-".repeat(60), "Poslední výstup:", o.posledni_vystup || "(nespuštěno)");
    });
    if (p.poruseni.length) {
      L.push("", "=".repeat(60), "ZÁZNAM UDÁLOSTÍ");
      p.poruseni.forEach((v) => L.push(`${new Date(v.time).toLocaleTimeString("cs-CZ")}  ${v.type}`));
    }
    return L.join("\n");
  }

  let lastPayload = null;

  function downloadBackup() {
    if (!lastPayload) lastPayload = buildPayload();
    const blob = new Blob([payloadToText(lastPayload)], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${lastPayload.trida}_${lastPayload.prijmeni}_${lastPayload.jmeno}.txt`.replace(/\s+/g, "_");
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function bindSubmit() {
    $("#btn-backup").addEventListener("click", downloadBackup);

    $("#btn-submit").addEventListener("click", () => {
      const empty = state.answers
        .map((a, i) => ({ i, empty: !a.code.trim() || a.code.trim() === state.tasks[i].starter.trim() }))
        .filter((x) => x.empty)
        .map((x) => x.i + 1);
      const notRun = state.answers.map((a, i) => (a.runs ? null : i + 1)).filter(Boolean);

      let txt = "Po odeslání už nebude možné odpovědi upravit.";
      if (empty.length) txt += ` Nevyřešené úlohy: ${empty.join(", ")}.`;
      else if (notRun.length) txt += ` Nespuštěné úlohy: ${notRun.join(", ")}.`;

      $("#confirm-text").textContent = txt;
      setMod($("#confirm"), "modal", "hidden", false);
    });

    $("#confirm-no").addEventListener("click", () => setMod($("#confirm"), "modal", "hidden", true));

    $("#confirm-yes").addEventListener("click", async () => {
      setMod($("#confirm"), "modal", "hidden", true);
      const btn = $("#btn-submit");
      const msg = $("#submit-msg");
      btn.disabled = true;
      btn.textContent = "Odesílám…";
      setMod(msg, "card__message", "error", false);
      msg.textContent = "";

      lastPayload = buildPayload();
      lastPayload.text = payloadToText(lastPayload);

      try {
        await callServer(lastPayload);   // úspěch jen při potvrzení {status:"ok"} ze serveru
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Odeslat test znovu";
        setMod(msg, "card__message", "error", true);
        msg.innerHTML = `Odeslání se nezdařilo: ${esc(err.message)}<br>Zkus to znovu, nebo si stáhni kopii a předej ji učiteli.
          <br><button class="button button--secondary button--spaced js-backup">Stáhnout kopii</button>`;
        $(".js-backup", msg).addEventListener("click", downloadBackup);
        return;
      }

      state.submitted = true;
      clearSaved();
      clearInterval(timerInt);
      if (worker) worker.terminate();
      $("#done-text").textContent = "Tvé odpovědi byly uloženy učiteli. Můžeš zavřít okno.";
      showScreen("#screen-done");
    });
  }

  /* ===================================================================
     START APLIKACE
     =================================================================== */
  bindSecurity();
  bindStart();
  bindSubmit();
  startWorker();      // Python se začne načítat už na úvodní obrazovce
  restore();
})();
