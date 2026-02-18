const state = {
  token: localStorage.getItem("wms_token") || "",
  me: null,
  manualInboundSkuId: null,
  manualOutboundSkuId: null,
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

function parseMaybeNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const isFormData = options.body instanceof FormData;
  if (!isFormData && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(`/api${path}`, { ...options, headers });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text || "Request failed" };
  }
  if (!res.ok || payload.code !== 0) {
    throw new Error(payload.message || `HTTP ${res.status}`);
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
  $("usersBody").innerHTML = users
    .map(
      (u) => `
    <tr>
      <td>${escapeHtml(u.id)}</td>
      <td>${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.role)}</td>
      <td>${u.status === 1 ? "启用" : "停用"}</td>
      <td>${formatDate(u.updatedAt)}</td>
    </tr>
  `,
    )
    .join("");
}

async function loadSkus() {
  const skus = await request("/skus");
  $("statSkus").textContent = skus.length;
  $("skusBody").innerHTML = skus
    .map(
      (s) => `
    <tr>
      <td>${escapeHtml(s.id)}</td>
      <td>${escapeHtml(s.sku)}</td>
      <td>${escapeHtml(s.erpSku)}</td>
      <td>${escapeHtml(s.asin)}</td>
      <td>${escapeHtml(s.fnsku)}</td>
      <td>${s.status === 1 ? "启用" : "停用"}</td>
    </tr>
  `,
    )
    .join("");
}

async function loadShelves() {
  const shelves = await request("/shelves");
  $("statShelves").textContent = shelves.length;
  $("shelvesBody").innerHTML = shelves
    .map(
      (s) => `
    <tr>
      <td>${escapeHtml(s.id)}</td>
      <td>${escapeHtml(s.shelfCode)}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${s.status === 1 ? "启用" : "停用"}</td>
    </tr>
  `,
    )
    .join("");
}

async function loadBoxes() {
  const boxes = await request("/boxes");
  $("statBoxes").textContent = boxes.length;
  $("boxesBody").innerHTML = boxes
    .map(
      (b) => `
    <tr>
      <td>${escapeHtml(b.id)}</td>
      <td>${escapeHtml(b.boxCode)}</td>
      <td>${escapeHtml(b.shelf?.shelfCode)} (#${escapeHtml(b.shelfId)})</td>
      <td>${b.status === 1 ? "启用" : "停用"}</td>
    </tr>
  `,
    )
    .join("");
}

async function loadInboundOrders() {
  const orders = await request("/inbound/orders");
  $("statInboundDraft").textContent = orders.filter((o) => o.status === "draft").length;
  $("inboundBody").innerHTML = orders
    .map((order) => {
      const actions = [];
      if (order.status === "draft") {
        actions.push(
          `<button class="tiny-btn" data-action="confirmInbound" data-id="${escapeHtml(order.id)}">确认</button>`,
        );
        actions.push(
          `<button class="tiny-btn ghost" data-action="voidInbound" data-id="${escapeHtml(order.id)}">作废</button>`,
        );
      } else if (order.status === "confirmed") {
        actions.push('<span class="tag">已确认</span>');
      } else {
        actions.push('<span class="tag">已作废</span>');
      }

      return `
      <tr>
        <td>${escapeHtml(order.id)}</td>
        <td>${escapeHtml(order.orderNo)}</td>
        <td>${escapeHtml(order.status)}</td>
        <td>${escapeHtml(order.orderType)}</td>
        <td>${escapeHtml(order.items?.length ?? 0)}</td>
        <td>${formatDate(order.createdAt)}</td>
        <td>${actions.join(" ")}</td>
      </tr>
    `;
    })
    .join("");
}

async function loadAudit() {
  const result = await request("/audit-logs?page=1&pageSize=20");
  const items = result.items || [];
  $("auditBody").innerHTML = items
    .map(
      (item) => `
    <tr>
      <td>${formatDate(item.createdAt)}</td>
      <td>${escapeHtml(item.entityType)}#${escapeHtml(item.entityId)}</td>
      <td>${escapeHtml(item.action)}</td>
      <td>${escapeHtml(item.eventType)}</td>
      <td>${escapeHtml(item.operator?.username)}</td>
      <td>${escapeHtml(item.requestId)}</td>
    </tr>
  `,
    )
    .join("");
}

async function loadManualBoxes(skuId, tbodyId) {
  if (!skuId) {
    $(tbodyId).innerHTML = '<tr><td colspan="4">请先选择 SKU</td></tr>';
    return;
  }
  const rows = await request(`/inventory/product-boxes?skuId=${skuId}`);
  $(tbodyId).innerHTML =
    rows
      .map(
        (row) => `
    <tr>
      <td>${escapeHtml(row.box?.id)}</td>
      <td>${escapeHtml(row.box?.boxCode)}</td>
      <td>${escapeHtml(row.box?.shelf?.shelfCode)}</td>
      <td>${escapeHtml(row.qty)}</td>
    </tr>
  `,
      )
      .join("") || '<tr><td colspan="4">该 SKU 当前没有箱内库存</td></tr>';
}

async function searchManualSkus(keyword, resultId, action) {
  if (!keyword) {
    $(resultId).innerHTML = "-";
    return;
  }
  const skus = await request(`/inventory/search?keyword=${encodeURIComponent(keyword)}`);
  if (skus.length === 0) {
    $(resultId).innerHTML = "未找到产品";
    return;
  }

  const locationEntries = await Promise.all(
    skus.map(async (sku) => {
      try {
        const rows = await request(`/inventory/product-boxes?skuId=${sku.id}`);
        return [String(sku.id), rows];
      } catch {
        return [String(sku.id), []];
      }
    }),
  );
  const locationMap = new Map(locationEntries);

  $(resultId).innerHTML = skus
    .map(
      (s) => `
    <button class="tiny-btn ghost sku-result-btn" data-action="${action}" data-id="${escapeHtml(s.id)}">
      <span>#${escapeHtml(s.id)} ${escapeHtml(s.sku)} / ${escapeHtml(s.erpSku || "")}</span>
      <span class="sku-location">${renderLocationText(locationMap.get(String(s.id)) || [])}</span>
    </button>
  `,
    )
    .join(" ");
}

function renderLocationText(rows) {
  if (!rows || rows.length === 0) {
    return "在库箱位：无";
  }
  const parts = rows.map((row) => {
    const boxCode = row.box?.boxCode || "-";
    const shelfCode = row.box?.shelf?.shelfCode || "-";
    return `${boxCode}/${shelfCode}`;
  });
  return `在库箱位：${parts.join("，")}`;
}

async function submitManualAdjust({
  skuInputId,
  keywordInputId,
  boxIdInputId,
  boxCodeInputId,
  qtyInputId,
  reasonInputId,
  outbound,
  tbodyId,
  selectedSkuStateKey,
}) {
  const skuId = parseMaybeNumber($(skuInputId).value);
  const absQty = Math.abs(Number($(qtyInputId).value));
  if (!Number.isFinite(absQty) || absQty <= 0) {
    throw new Error("数量必须大于 0");
  }
  const payload = {
    skuId,
    keyword: skuId ? undefined : $(keywordInputId).value.trim() || undefined,
    boxId: parseMaybeNumber($(boxIdInputId).value),
    boxCode: $(boxCodeInputId).value.trim() || undefined,
    qtyDelta: outbound ? -absQty : absQty,
    reason: $(reasonInputId).value.trim() || undefined,
  };
  await request("/inventory/manual-adjust", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (skuId) {
    state[selectedSkuStateKey] = skuId;
    await loadManualBoxes(skuId, tbodyId);
  }
  await loadBoxes();
  await loadAudit();
}

async function reloadAll() {
  await loadMe();
  if (!state.token) return;
  await Promise.all([
    loadUsers(),
    loadSkus(),
    loadShelves(),
    loadBoxes(),
    loadInboundOrders(),
    loadAudit(),
  ]);
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

  $("importInboundForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("inboundFile").files?.[0];
    if (!file) {
      showToast("请选择 Excel 文件", true);
      return;
    }
    try {
      const formData = new FormData();
      formData.append("file", file);
      await request("/inbound/import-excel", {
        method: "POST",
        body: formData,
      });
      $("importInboundForm").reset();
      showToast("导入成功，已生成待确认入库单");
      await loadInboundOrders();
      await loadBoxes();
      await loadSkus();
      await loadAudit();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $("manualInboundSearchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await searchManualSkus(
        $("manualInboundKeyword").value.trim(),
        "manualInboundSkuResults",
        "pickManualInboundSku",
      );
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $("manualOutboundSearchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await searchManualSkus(
        $("manualOutboundKeyword").value.trim(),
        "manualOutboundSkuResults",
        "pickManualOutboundSku",
      );
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $("manualInboundForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await submitManualAdjust({
        skuInputId: "manualInboundSkuId",
        keywordInputId: "manualInboundKeyword",
        boxIdInputId: "manualInboundBoxId",
        boxCodeInputId: "manualInboundBoxCode",
        qtyInputId: "manualInboundQty",
        reasonInputId: "manualInboundReason",
        outbound: false,
        tbodyId: "manualInboundBoxesBody",
        selectedSkuStateKey: "manualInboundSkuId",
      });
      showToast("手动入库成功");
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $("manualOutboundForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await submitManualAdjust({
        skuInputId: "manualOutboundSkuId",
        keywordInputId: "manualOutboundKeyword",
        boxIdInputId: "manualOutboundBoxId",
        boxCodeInputId: "manualOutboundBoxCode",
        qtyInputId: "manualOutboundQty",
        reasonInputId: "manualOutboundReason",
        outbound: true,
        tbodyId: "manualOutboundBoxesBody",
        selectedSkuStateKey: "manualOutboundSkuId",
      });
      showToast("手动出库成功");
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $("manualInboundSkuId").addEventListener("change", async () => {
    state.manualInboundSkuId = parseMaybeNumber($("manualInboundSkuId").value) || null;
    await loadManualBoxes(state.manualInboundSkuId, "manualInboundBoxesBody").catch((err) =>
      showToast(err.message, true),
    );
  });

  $("manualOutboundSkuId").addEventListener("change", async () => {
    state.manualOutboundSkuId = parseMaybeNumber($("manualOutboundSkuId").value) || null;
    await loadManualBoxes(state.manualOutboundSkuId, "manualOutboundBoxesBody").catch((err) =>
      showToast(err.message, true),
    );
  });
}

function bindDelegates() {
  $("inboundBody").addEventListener("click", async (e) => {
    const target = e.target.closest("button[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    const id = target.dataset.id;
    if (!id) return;
    try {
      if (action === "confirmInbound") {
        await request(`/inbound/orders/${id}/confirm`, { method: "POST", body: "{}" });
        showToast(`入库单 #${id} 已确认`);
      } else if (action === "voidInbound") {
        await request(`/inbound/orders/${id}/void`, { method: "POST", body: "{}" });
        showToast(`入库单 #${id} 已作废`);
      }
      await loadInboundOrders();
      await loadAudit();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $("manualInboundSkuResults").addEventListener("click", async (e) => {
    const target = e.target.closest("button[data-action='pickManualInboundSku']");
    if (!target) return;
    const id = Number(target.dataset.id);
    if (!Number.isFinite(id)) return;
    $("manualInboundSkuId").value = String(id);
    state.manualInboundSkuId = id;
    await loadManualBoxes(state.manualInboundSkuId, "manualInboundBoxesBody").catch((err) =>
      showToast(err.message, true),
    );
  });

  $("manualOutboundSkuResults").addEventListener("click", async (e) => {
    const target = e.target.closest("button[data-action='pickManualOutboundSku']");
    if (!target) return;
    const id = Number(target.dataset.id);
    if (!Number.isFinite(id)) return;
    $("manualOutboundSkuId").value = String(id);
    state.manualOutboundSkuId = id;
    await loadManualBoxes(state.manualOutboundSkuId, "manualOutboundBoxesBody").catch((err) =>
      showToast(err.message, true),
    );
  });
}

function bindRefresh() {
  $("refreshUsers").addEventListener("click", () => loadUsers().catch((e) => showToast(e.message, true)));
  $("refreshSkus").addEventListener("click", () => loadSkus().catch((e) => showToast(e.message, true)));
  $("refreshShelves").addEventListener("click", () => loadShelves().catch((e) => showToast(e.message, true)));
  $("refreshBoxes").addEventListener("click", () => loadBoxes().catch((e) => showToast(e.message, true)));
  $("refreshInbound").addEventListener("click", () => loadInboundOrders().catch((e) => showToast(e.message, true)));
  $("refreshManualInbound").addEventListener("click", () => {
    searchManualSkus($("manualInboundKeyword").value.trim(), "manualInboundSkuResults", "pickManualInboundSku").catch(
      (e) => showToast(e.message, true),
    );
    loadManualBoxes(state.manualInboundSkuId, "manualInboundBoxesBody").catch((e) =>
      showToast(e.message, true),
    );
  });
  $("refreshManualOutbound").addEventListener("click", () => {
    searchManualSkus($("manualOutboundKeyword").value.trim(), "manualOutboundSkuResults", "pickManualOutboundSku").catch(
      (e) => showToast(e.message, true),
    );
    loadManualBoxes(state.manualOutboundSkuId, "manualOutboundBoxesBody").catch((e) =>
      showToast(e.message, true),
    );
  });
  $("refreshAudit").addEventListener("click", () => loadAudit().catch((e) => showToast(e.message, true)));
}

bindTabs();
bindForms();
bindDelegates();
bindRefresh();
reloadAll().catch((err) => showToast(err.message, true));
