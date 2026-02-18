const state = {
  token: localStorage.getItem("wms_token") || "",
  me: null,
};

const $ = (id) => document.getElementById(id);

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.classList.toggle("error", isError);
  setTimeout(() => toast.classList.add("hidden"), 3000);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString();
}

async function request(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, { ...options, headers });
  const payload = await res.json();
  if (!res.ok || payload.code !== 0) {
    throw new Error(payload.message || "Request failed");
  }
  return payload.data;
}

function bindTabs() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $(btn.dataset.target).classList.add("active");
    });
  });
}

async function loadMe() {
  if (!state.token) {
    state.me = null;
    $("sessionInfo").textContent = "未登录";
    $("meCard").textContent = "-";
    return;
  }
  try {
    state.me = await request("/auth/me");
    $("sessionInfo").textContent = `${state.me.username} (${state.me.role})`;
    $("meCard").textContent = JSON.stringify(state.me, null, 2);
  } catch {
    state.token = "";
    localStorage.removeItem("wms_token");
    state.me = null;
    $("sessionInfo").textContent = "登录失效";
    $("meCard").textContent = "-";
  }
}

async function loadUsers() {
  const users = await request("/users");
  $("statUsers").textContent = users.length;
  $("usersBody").innerHTML = users.map((u) => `
    <tr>
      <td>${escapeHtml(u.id)}</td>
      <td>${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.role)}</td>
      <td>${u.status === 1 ? "启用" : "停用"}</td>
      <td>${formatDate(u.updatedAt)}</td>
    </tr>
  `).join("");
}

async function loadSkus() {
  const skus = await request("/skus");
  $("statSkus").textContent = skus.length;
  $("skusBody").innerHTML = skus.map((s) => `
    <tr>
      <td>${escapeHtml(s.id)}</td>
      <td>${escapeHtml(s.sku)}</td>
      <td>${escapeHtml(s.erpSku)}</td>
      <td>${escapeHtml(s.asin)}</td>
      <td>${escapeHtml(s.fnsku)}</td>
      <td>${s.status === 1 ? "启用" : "停用"}</td>
    </tr>
  `).join("");
}

async function loadShelves() {
  const shelves = await request("/shelves");
  $("statShelves").textContent = shelves.length;
  $("shelvesBody").innerHTML = shelves.map((s) => `
    <tr>
      <td>${escapeHtml(s.id)}</td>
      <td>${escapeHtml(s.shelfCode)}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${s.status === 1 ? "启用" : "停用"}</td>
    </tr>
  `).join("");
}

async function loadBoxes() {
  const boxes = await request("/boxes");
  $("statBoxes").textContent = boxes.length;
  $("boxesBody").innerHTML = boxes.map((b) => `
    <tr>
      <td>${escapeHtml(b.id)}</td>
      <td>${escapeHtml(b.boxCode)}</td>
      <td>${escapeHtml(b.shelf?.shelfCode)} (#${escapeHtml(b.shelfId)})</td>
      <td>${b.status === 1 ? "启用" : "停用"}</td>
    </tr>
  `).join("");
}

async function loadAudit() {
  const result = await request("/audit-logs?page=1&pageSize=20");
  const items = result.items || [];
  $("auditBody").innerHTML = items.map((item) => `
    <tr>
      <td>${formatDate(item.createdAt)}</td>
      <td>${escapeHtml(item.entityType)}#${escapeHtml(item.entityId)}</td>
      <td>${escapeHtml(item.action)}</td>
      <td>${escapeHtml(item.eventType)}</td>
      <td>${escapeHtml(item.operator?.username)}</td>
      <td>${escapeHtml(item.requestId)}</td>
    </tr>
  `).join("");
}

async function reloadAll() {
  await loadMe();
  if (!state.token) return;
  await Promise.all([loadUsers(), loadSkus(), loadShelves(), loadBoxes(), loadAudit()]);
}

function bindForms() {
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const data = await request("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: $("username").value.trim(),
          password: $("password").value,
        }),
      });
      state.token = data.accessToken;
      localStorage.setItem("wms_token", state.token);
      showToast("登录成功");
      await reloadAll();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $("logoutBtn").addEventListener("click", () => {
    state.token = "";
    state.me = null;
    localStorage.removeItem("wms_token");
    showToast("已退出登录");
    reloadAll();
  });

  $("createUserForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await request("/users", {
        method: "POST",
        body: JSON.stringify({
          username: $("newUsername").value.trim(),
          password: $("newPassword").value,
          role: $("newRole").value,
        }),
      });
      e.target.reset();
      showToast("员工已创建");
      await loadUsers();
      await loadAudit();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $("createSkuForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await request("/skus", {
        method: "POST",
        body: JSON.stringify({
          sku: $("newSku").value.trim(),
          erpSku: $("newErpSku").value.trim() || undefined,
          asin: $("newAsin").value.trim() || undefined,
          fnsku: $("newFnsku").value.trim() || undefined,
        }),
      });
      e.target.reset();
      showToast("SKU 已创建");
      await loadSkus();
      await loadAudit();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $("createShelfForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await request("/shelves", {
        method: "POST",
        body: JSON.stringify({
          shelfCode: $("newShelfCode").value.trim(),
          name: $("newShelfName").value.trim() || undefined,
        }),
      });
      e.target.reset();
      showToast("货架已创建");
      await loadShelves();
      await loadAudit();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $("createBoxForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await request("/boxes", {
        method: "POST",
        body: JSON.stringify({
          boxCode: $("newBoxCode").value.trim(),
          shelfId: Number($("newBoxShelfId").value),
        }),
      });
      e.target.reset();
      showToast("箱子已创建");
      await loadBoxes();
      await loadAudit();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

function bindRefresh() {
  $("refreshUsers").addEventListener("click", () => loadUsers().catch((e) => showToast(e.message, true)));
  $("refreshSkus").addEventListener("click", () => loadSkus().catch((e) => showToast(e.message, true)));
  $("refreshShelves").addEventListener("click", () => loadShelves().catch((e) => showToast(e.message, true)));
  $("refreshBoxes").addEventListener("click", () => loadBoxes().catch((e) => showToast(e.message, true)));
  $("refreshAudit").addEventListener("click", () => loadAudit().catch((e) => showToast(e.message, true)));
}

bindTabs();
bindForms();
bindRefresh();
reloadAll().catch((err) => showToast(err.message, true));
