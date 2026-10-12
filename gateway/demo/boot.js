// Bootstrap for the static GitHub Pages build: registers sw.js (the in-browser
// gateway + storage node), waits until it controls the page, then loads the
// unmodified UI script. Also adds a small "storage nodes" panel so visitors
// can take a replica offline and watch reads fail over.
(function () {
  const REPO_URL = "https://github.com/munsakad/Distributed-Cloud-File-Storage";

  function fatal(message) {
    const text = document.getElementById("statusText");
    if (text) text.textContent = message;
    document.getElementById("status")?.classList.add("status--err");
  }

  function waitForController(timeoutMs) {
    if (navigator.serviceWorker.controller) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => resolve(Boolean(navigator.serviceWorker.controller));
      navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
      setTimeout(done, timeoutMs);
    });
  }

  async function boot() {
    if (!("serviceWorker" in navigator) || !window.indexedDB || !window.crypto?.subtle) {
      fatal("this demo needs Service Workers, IndexedDB and WebCrypto");
      return;
    }
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      let controlled = await waitForController(4000);
      if (!controlled && reg.active) {
        // e.g. after a hard reload: ask the active worker to claim this page
        reg.active.postMessage("claim");
        controlled = await waitForController(4000);
      }
      if (!controlled) throw new Error("service worker did not take control");
    } catch (err) {
      fatal("could not start in-browser backend: " + err.message);
      return;
    }
    const script = document.createElement("script");
    script.src = "app.js";
    document.body.appendChild(script);
    mountPanel();
  }

  async function mountPanel() {
    const style = document.createElement("style");
    style.textContent =
      ".demo-nodes{position:fixed;right:16px;bottom:16px;z-index:50;width:min(330px,calc(100vw - 32px));" +
      "font:12px/1.5 'IBM Plex Mono',ui-monospace,monospace;background:#0d1117;color:#c9d1d9;" +
      "border:1px solid #30363d;border-radius:6px;padding:12px 14px;box-shadow:0 8px 24px rgba(0,0,0,.4)}" +
      ".demo-nodes h2{font-size:11px;letter-spacing:.08em;margin:0 0 8px;color:#8b949e;font-weight:600}" +
      ".demo-nodes .node{display:flex;align-items:center;gap:8px;padding:3px 0}" +
      ".demo-nodes .dot{width:8px;height:8px;border-radius:50%;background:#3fb950;flex:none}" +
      ".demo-nodes .off .dot{background:#f85149}" +
      ".demo-nodes .meta{color:#8b949e;margin-left:auto}" +
      ".demo-nodes button{font:inherit;background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;" +
      "padding:2px 8px;cursor:pointer}.demo-nodes button:hover{border-color:#8b949e}" +
      ".demo-nodes p{margin:8px 0 0;color:#8b949e}.demo-nodes a{color:#58a6ff}" +
      ".demo-nodes .x{position:absolute;top:6px;right:8px;border:0;background:none;font-size:14px}";
    document.head.appendChild(style);

    const panel = document.createElement("aside");
    panel.className = "demo-nodes";
    panel.setAttribute("aria-label", "Simulated storage nodes");
    panel.innerHTML =
      '<button class="x" aria-label="Hide panel">&times;</button><h2>[ DEMO ] STORAGE NODES</h2><div class="nodes"></div>' +
      "<p>No server: a service worker runs the gateway + storage node. Chunks are AES-256-GCM encrypted with a " +
      "key that never leaves this browser and fanned out to two IndexedDB replicas. Take one offline to watch " +
      'reads fail over. <a href="' + REPO_URL + '" target="_blank" rel="noopener">source</a></p>';
    panel.querySelector(".x").onclick = () => panel.remove();
    document.body.appendChild(panel);

    let offline = [];
    async function refresh(body) {
      const res = await fetch("api/_demo/replicas", body
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : undefined);
      const { nodes } = await res.json();
      offline = nodes.filter((n) => !n.online).map((n) => n.name);
      const list = panel.querySelector(".nodes");
      list.innerHTML = "";
      for (const n of nodes) {
        const row = document.createElement("div");
        row.className = "node" + (n.online ? "" : " off");
        row.innerHTML = '<span class="dot"></span><span></span><span class="meta"></span><button></button>';
        row.children[1].textContent = n.name;
        row.children[2].textContent = n.chunks + " chunk" + (n.chunks === 1 ? "" : "s");
        const btn = row.children[3];
        btn.textContent = n.online ? "take offline" : "bring online";
        btn.onclick = () =>
          refresh({ offline: n.online ? offline.concat(n.name) : offline.filter((x) => x !== n.name) });
        list.appendChild(row);
      }
    }
    refresh();
    setInterval(refresh, 3000);
  }

  boot();
})();
