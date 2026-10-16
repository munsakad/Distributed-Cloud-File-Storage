(async function () {
  window.STORAGE_DEMO = true;
  const $ = (id) => document.getElementById(id);
  function fatal(message) {
    $("status").className = "status status--err";
    $("statusText").textContent = message;
    $("dropzone").setAttribute("aria-disabled", "true");
    $("runVerification").disabled = true;
  }
  try {
    if (!navigator.serviceWorker || !window.indexedDB || !crypto.subtle)
      throw new Error("Service Workers, IndexedDB and WebCrypto are required.");
    const registration = await navigator.serviceWorker.register("sw.js", {
      updateViaCache: "none",
    });
    if (registration.installing) {
      await new Promise((resolve, reject) => {
        const worker = registration.installing;
        const timer = setTimeout(
          () =>
            reject(new Error("Storage update timed out. Refresh to retry.")),
          15000,
        );
        worker.addEventListener("statechange", () => {
          if (worker.state === "activated") {
            clearTimeout(timer);
            resolve();
          }
          if (worker.state === "redundant") {
            clearTimeout(timer);
            reject(new Error("Storage update failed."));
          }
        });
      });
    }
    if (!navigator.serviceWorker.controller) {
      registration.active?.postMessage("claim");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                "Storage worker did not take control. Refresh to retry.",
              ),
            ),
          10000,
        );
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    const expected = new URL("sw.js", location.href).href;
    if (navigator.serviceWorker.controller.scriptURL !== expected)
      throw new Error(
        "Another service worker controls this page. Close other tabs and refresh.",
      );
    $("modeLabel").textContent = "Browser demo";
    $("uploadLimit").textContent =
      "Up to 100 MiB per file ? Saved on this device, not uploaded to a cloud account";
    $("storageMode").textContent =
      "Two IndexedDB stores simulate storage replicas on this device. They share the browser?s storage quota; clearing site data removes files and their key.";
    $("deploymentNote").textContent =
      "GitHub Pages runs a service worker that simulates the gateway and storage node. WebCrypto performs real AES-256-GCM encryption; IndexedDB stores the encrypted chunks and versions. Express, gRPC, AWS S3, Kubernetes and Terraform are implemented in the source, but are not running on this static deployment.";
    window.refreshStorageNodes = async () => {
      const response = await fetch("api/_demo/replicas");
      if (!response.ok) throw new Error("Could not read replica status");
      const data = await response.json();
      const root = $("nodesPanel");
      root.replaceChildren();
      for (const node of data.nodes) {
        const row = document.createElement("div");
        row.className = "node" + (node.online ? "" : " off");
        const head = document.createElement("div");
        head.className = "node-header";
        const dot = document.createElement("span");
        dot.className = "dot";
        const name = document.createElement("span");
        name.textContent = node.name.toUpperCase();
        head.append(dot, name);
        const meta = document.createElement("div");
        meta.className = "node-meta";
        meta.textContent =
          (node.online ? "Online" : "Offline") +
          " ? " +
          node.chunks +
          " encrypted chunks";
        const button = document.createElement("button");
        button.textContent = node.online ? "Take offline" : "Bring online";
        button.onclick = async () => {
          button.disabled = true;
          try {
            const current = await (await fetch("api/_demo/replicas")).json();
            let offline = current.nodes
              .filter((n) => !n.online)
              .map((n) => n.name);
            offline = node.online
              ? [...offline, node.name]
              : offline.filter((n) => n !== node.name);
            const result = await fetch("api/_demo/replicas", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ offline }),
            });
            if (!result.ok) throw new Error("Could not change replica state");
            await window.refreshStorageNodes();
          } catch (e) {
            $("toast").textContent = e.message;
            $("toast").hidden = false;
            $("toast").className = "toast toast--err";
            button.disabled = false;
          }
        };
        row.append(head, meta, button);
        root.append(row);
      }
    };
    await window.refreshStorageNodes();
    const script = document.createElement("script");
    script.src = "app.js";
    document.body.append(script);
    setInterval(() => window.refreshStorageNodes().catch(() => {}), 15000);
  } catch (e) {
    fatal("Storage could not start: " + e.message);
  }
})();
