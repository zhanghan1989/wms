const state = {
  token: localStorage.getItem("wms_token") || "",
  me: null,
  manualInboundSkuId: null,
  manualOutboundSkuId: null,
};

const $ = (id) => document.getElementById(id);

function showToast(message, isError = false) {
  const toast = $("toast");
  if (!toast) return;
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
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function getStatusText(status) {
  return Number(status) === 1 ? "启用" : "禁用";
}

function clearStats() {
  $("statUsers").textContent = "-";
  $("statSkus").textContent = "-";
  $("statShelves").textContent = "-";
  $("statBoxes").textContent = "-";
  $("statInboundDraft").textContent = "-";
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const isFormData = options.body instanceof FormData;

  if (!isFormData && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

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
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
      button.classList.add("active");
      const target = $(button.dataset.target);
      if (target) {
        target.classList.add("active");
      }
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
    state.me = null;
    localStorage.removeItem("wms_token");
    $("sessionInfo").textContent = "登录失效";
    $("meCard").textContent = "-";
  }
}

async function loadUsers() {
  const users = await request("/users");
  $("statUsers").textContent = users.length;
  $("usersBody").innerHTML = users
    .map(
      (user) => `
      <tr>
        <td>${escapeHtml(user.username)}</td>
        <td>${escapeHtml(user.role)}</td>
        <td>${getStatusText(user.status)}</td>
        <td>${formatDate(user.updatedAt)}</td>
      </tr>
    `,
    )
    .join("");
}

async function getSkuInventoryRows(skuId) {
  try {
    return await request(`/inventory/product-boxes?skuId=${skuId}`);
  } catch {
    return [];
  }
}

function renderSkuLocationsCell(rows) {
  if (!rows?.length) return "-";
  const items = rows
    .map((row) => {
      const boxCode = row.box?.boxCode || "-";
      const shelfCode = row.box?.shelf?.shelfCode || "-";
      const qty = Number(row.qty ?? 0);
      return `<div>${escapeHtml(boxCode)} / ${escapeHtml(shelfCode)} / ${escapeHtml(qty)}</div>`;
    })
    .join("");
  return `<div class="location-list">${items}</div>`;
}

async function loadSkus() {
  const skus = await request("/skus");
  $("statSkus").textContent = skus.length;

  const locationEntries = await Promise.all(
    skus.map(async (sku) => [String(sku.id), await getSkuInventoryRows(sku.id)]),
  );
  const locationMap = new Map(locationEntries);

  $("skusBody").innerHTML = skus
    .map(
      (sku) => `
      <tr>
        <td>${escapeHtml(sku.sku)}</td>
        <td>${escapeHtml(sku.erpSku)}</td>
        <td>${escapeHtml(sku.asin)}</td>
        <td>${escapeHtml(sku.fnsku)}</td>
        <td>${renderSkuLocationsCell(locationMap.get(String(sku.id)) || [])}</td>
      </tr>
    `,
    )
    .join("");
}

function renderShelfOptionsForSelect(selectId, shelves, placeholder) {
  const select = $(selectId);
  if (!select) return;

  const prev = select.value;
  const options = shelves
    .map((shelf) => {
      const isEnabled = Number(shelf.status) === 1;
      const disabledAttr = isEnabled ? "" : " disabled";
      const disabledMark = isEnabled ? "" : "（禁用）";
      return `<option value="${escapeHtml(shelf.id)}"${disabledAttr}>${escapeHtml(shelf.shelfCode)}${disabledMark}</option>`;
    })
    .join("");

  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;

  if (prev && shelves.some((shelf) => String(shelf.id) === prev && Number(shelf.status) === 1)) {
    select.value = prev;
  }
}

function renderShelfOptions(shelves) {
  renderShelfOptionsForSelect("newBoxShelfId", shelves, "请选择货架号");
  renderShelfOptionsForSelect("newSkuShelfId", shelves, "箱号已存在可不选；新建箱号请选货架号");
}

async function loadShelves() {
  const shelves = await request("/shelves");
  $("statShelves").textContent = shelves.length;

  renderShelfOptions(shelves);
  $("shelvesBody").innerHTML = shelves
    .map(
      (shelf) => `
      <tr>
        <td>${escapeHtml(shelf.shelfCode)}</td>
        <td>${escapeHtml(shelf.name)}</td>
        <td>${getStatusText(shelf.status)}</td>
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
      (box) => `
      <tr>
        <td>${escapeHtml(box.boxCode)}</td>
        <td>${escapeHtml(box.shelf?.shelfCode)}</td>
        <td>${getStatusText(box.status)}</td>
      </tr>
    `,
    )
    .join("");
}

async function getExistingBoxByCode(boxCode) {
  const matched = await request(`/boxes?q=${encodeURIComponent(boxCode)}`);
  return matched.find((box) => box.boxCode === boxCode);
}

async function ensureBoxForNewSku(boxCode, shelfId) {
  const existed = await getExistingBoxByCode(boxCode);
  if (existed) {
    return existed;
  }

  if (!Number.isInteger(shelfId) || shelfId <= 0) {
    throw new Error("箱号不存在，请先选择货架号以创建新箱号");
  }

  await request("/boxes", {
    method: "POST",
    body: JSON.stringify({
      boxCode,
      shelfId,
    }),
  });
}

function getInboundOrderStatusTag(status) {
  if (status === "confirmed") return '<span class="tag">已确认</span>';
  if (status === "void") return '<span class="tag">已作废</span>';
  return '<span class="tag">待处理</span>';
}

async function loadInboundOrders() {
  const orders = await request("/inbound/orders");
  $("statInboundDraft").textContent = orders.filter((order) => order.status === "draft").length;

  $("inboundBody").innerHTML = orders
    .map((order) => {
      const actionHtml =
        order.status === "draft"
          ? [
              `<button class="tiny-btn" data-action="confirmInbound" data-id="${order.id}">确认</button>`,
              `<button class="tiny-btn ghost" data-action="voidInbound" data-id="${order.id}">作废</button>`,
            ].join(" ")
          : getInboundOrderStatusTag(order.status);

      return `
        <tr>
          <td>${escapeHtml(order.orderNo)}</td>
          <td>${escapeHtml(order.status)}</td>
          <td>${escapeHtml(order.orderType)}</td>
          <td>${escapeHtml(order.items?.length ?? 0)}</td>
          <td>${formatDate(order.createdAt)}</td>
          <td>${actionHtml}</td>
        </tr>
      `;
    })
    .join("");
}

function formatAuditEntity(item) {
  const entityType = item.entityType || "-";
  const entityId = item.entityId || "-";
  return `${escapeHtml(entityType)}#${escapeHtml(entityId)}`;
}

async function loadAudit() {
  const result = await request("/audit-logs?page=1&pageSize=20");
  const items = result.items || [];

  $("auditBody").innerHTML = items
    .map(
      (item) => `
      <tr>
        <td>${formatDate(item.createdAt)}</td>
        <td>${formatAuditEntity(item)}</td>
        <td>${escapeHtml(item.action)}</td>
        <td>${escapeHtml(item.eventType)}</td>
        <td>${escapeHtml(item.operator?.username)}</td>
        <td>${escapeHtml(item.requestId)}</td>
      </tr>
    `,
    )
    .join("");
}

function renderLocationText(rows) {
  if (!rows || rows.length === 0) {
    return "所在箱号/货架号：无";
  }

  const uniqueLocations = Array.from(
    new Set(
      rows.map((row) => {
        const boxCode = row.box?.boxCode || "-";
        const shelfCode = row.box?.shelf?.shelfCode || "-";
        return `${boxCode}/${shelfCode}`;
      }),
    ),
  );

  return `所在箱号/货架号：${uniqueLocations.join("，")}`;
}

async function loadManualBoxes(skuId, tbodyId) {
  const tbody = $(tbodyId);
  if (!tbody) return;

  if (!skuId) {
    tbody.innerHTML = '<tr><td colspan="3">请先选择产品</td></tr>';
    return;
  }

  const rows = await request(`/inventory/product-boxes?skuId=${skuId}`);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="3">该产品暂无库存记录</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.box?.boxCode)}</td>
        <td>${escapeHtml(row.box?.shelf?.shelfCode)}</td>
        <td>${escapeHtml(row.qty)}</td>
      </tr>
    `,
    )
    .join("");
}

function renderSkuResultLabel(sku) {
  const labels = [sku.sku, sku.erpSku, sku.asin, sku.fnsku].filter(Boolean);
  return escapeHtml(labels.join(" / "));
}

async function searchManualSkus(keyword, resultId, action) {
  const resultBox = $(resultId);
  if (!resultBox) return;

  if (!keyword) {
    resultBox.innerHTML = "-";
    return;
  }

  const skus = await request(`/inventory/search?keyword=${encodeURIComponent(keyword)}`);
  if (!skus.length) {
    resultBox.innerHTML = "未找到匹配产品";
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

  resultBox.innerHTML = skus
    .map(
      (sku) => `
      <button class="tiny-btn ghost sku-result-btn" data-action="${action}" data-id="${sku.id}">
        <span>${renderSkuResultLabel(sku)}</span>
        <span class="sku-location">${renderLocationText(locationMap.get(String(sku.id)) || [])}</span>
      </button>
    `,
    )
    .join(" ");
}

async function submitManualAdjust({ skuStateKey, keywordInputId, boxCodeInputId, qtyInputId, reasonInputId, outbound, tbodyId }) {
  const skuId = state[skuStateKey];
  const absQty = Math.abs(Number($(qtyInputId).value));
  if (!Number.isFinite(absQty) || absQty <= 0) {
    throw new Error("数量必须大于 0");
  }

  const payload = {
    skuId: skuId || undefined,
    keyword: skuId ? undefined : $(keywordInputId).value.trim() || undefined,
    boxCode: $(boxCodeInputId).value.trim() || undefined,
    qtyDelta: outbound ? -absQty : absQty,
    reason: $(reasonInputId).value.trim() || undefined,
  };

  await request("/inventory/manual-adjust", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (skuId) {
    await loadManualBoxes(skuId, tbodyId);
  }
  await loadBoxes();
  await loadAudit();
}

async function reloadAll() {
  await loadMe();
  if (!state.token) {
    clearStats();
    return;
  }

  await Promise.all([loadUsers(), loadSkus(), loadShelves(), loadBoxes(), loadInboundOrders(), loadAudit()]);
}

function bindForms() {
  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
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
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    state.token = "";
    state.me = null;
    localStorage.removeItem("wms_token");
    showToast("已退出登录");
    await reloadAll();
  });

  $("createUserForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await request("/users", {
        method: "POST",
        body: JSON.stringify({
          username: $("newUsername").value.trim(),
          password: $("newPassword").value,
          role: $("newRole").value,
        }),
      });
      event.target.reset();
      showToast("员工已创建");
      await loadUsers();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createSkuForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const sku = $("newSku").value.trim();
      const boxCode = $("newSkuBoxCode").value.trim();
      const shelfId = Number($("newSkuShelfId").value);
      const qty = Number($("newSkuQty").value);

      if (!sku) {
        showToast("SKU 不能为空", true);
        return;
      }
      if (!boxCode) {
        showToast("箱号不能为空", true);
        return;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        showToast("数量必须大于 0", true);
        return;
      }

      const possibleDuplicate = await request(`/skus?q=${encodeURIComponent(sku)}`);
      if (possibleDuplicate.some((item) => item.sku === sku)) {
        showToast("SKU 已存在", true);
        return;
      }

      await ensureBoxForNewSku(boxCode, shelfId);

      const createdSku = await request("/skus", {
        method: "POST",
        body: JSON.stringify({
          sku,
          erpSku: $("newErpSku").value.trim() || undefined,
          asin: $("newAsin").value.trim() || undefined,
          fnsku: $("newFnsku").value.trim() || undefined,
        }),
      });

      await request("/inventory/manual-adjust", {
        method: "POST",
        body: JSON.stringify({
          skuId: createdSku.id,
          boxCode,
          qtyDelta: qty,
          reason: "新建产品初始入库",
        }),
      });

      event.target.reset();
      showToast("产品已创建并入库");
      await loadShelves();
      await loadBoxes();
      await loadSkus();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createShelfForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await request("/shelves", {
        method: "POST",
        body: JSON.stringify({
          shelfCode: $("newShelfCode").value.trim(),
          name: $("newShelfName").value.trim() || undefined,
        }),
      });
      event.target.reset();
      showToast("货架已创建");
      await loadShelves();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createBoxForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const shelfId = Number($("newBoxShelfId").value);
      if (!Number.isInteger(shelfId) || shelfId <= 0) {
        showToast("请选择货架号", true);
        return;
      }

      await request("/boxes", {
        method: "POST",
        body: JSON.stringify({
          boxCode: $("newBoxCode").value.trim(),
          shelfId,
        }),
      });

      event.target.reset();
      showToast("箱号已创建");
      await loadShelves();
      await loadBoxes();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("importInboundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
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
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("manualInboundSearchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      state.manualInboundSkuId = null;
      await searchManualSkus($("manualInboundKeyword").value.trim(), "manualInboundSkuResults", "pickManualInboundSku");
      await loadManualBoxes(null, "manualInboundBoxesBody");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("manualOutboundSearchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      state.manualOutboundSkuId = null;
      await searchManualSkus($("manualOutboundKeyword").value.trim(), "manualOutboundSkuResults", "pickManualOutboundSku");
      await loadManualBoxes(null, "manualOutboundBoxesBody");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("manualInboundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await submitManualAdjust({
        skuStateKey: "manualInboundSkuId",
        keywordInputId: "manualInboundKeyword",
        boxCodeInputId: "manualInboundBoxCode",
        qtyInputId: "manualInboundQty",
        reasonInputId: "manualInboundReason",
        outbound: false,
        tbodyId: "manualInboundBoxesBody",
      });
      showToast("手动入库成功");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("manualOutboundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await submitManualAdjust({
        skuStateKey: "manualOutboundSkuId",
        keywordInputId: "manualOutboundKeyword",
        boxCodeInputId: "manualOutboundBoxCode",
        qtyInputId: "manualOutboundQty",
        reasonInputId: "manualOutboundReason",
        outbound: true,
        tbodyId: "manualOutboundBoxesBody",
      });
      showToast("手动出库成功");
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

function bindDelegates() {
  $("inboundBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const action = button.dataset.action;
    const id = button.dataset.id;
    if (!id) return;

    try {
      if (action === "confirmInbound") {
        await request(`/inbound/orders/${id}/confirm`, { method: "POST", body: "{}" });
        showToast("入库单已确认");
      } else if (action === "voidInbound") {
        await request(`/inbound/orders/${id}/void`, { method: "POST", body: "{}" });
        showToast("入库单已作废");
      }
      await loadInboundOrders();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("manualInboundSkuResults").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='pickManualInboundSku']");
    if (!button) return;

    const id = Number(button.dataset.id);
    if (!Number.isFinite(id)) return;

    state.manualInboundSkuId = id;
    await loadManualBoxes(id, "manualInboundBoxesBody").catch((error) => showToast(error.message, true));
  });

  $("manualOutboundSkuResults").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='pickManualOutboundSku']");
    if (!button) return;

    const id = Number(button.dataset.id);
    if (!Number.isFinite(id)) return;

    state.manualOutboundSkuId = id;
    await loadManualBoxes(id, "manualOutboundBoxesBody").catch((error) => showToast(error.message, true));
  });
}

function bindRefresh() {
  $("refreshUsers").addEventListener("click", () => loadUsers().catch((error) => showToast(error.message, true)));
  $("refreshSkus").addEventListener("click", () => loadSkus().catch((error) => showToast(error.message, true)));
  $("refreshShelves").addEventListener("click", () => loadShelves().catch((error) => showToast(error.message, true)));
  $("refreshBoxes").addEventListener("click", () => loadBoxes().catch((error) => showToast(error.message, true)));
  $("refreshInbound").addEventListener("click", () => loadInboundOrders().catch((error) => showToast(error.message, true)));

  $("refreshManualInbound").addEventListener("click", () => {
    searchManualSkus($("manualInboundKeyword").value.trim(), "manualInboundSkuResults", "pickManualInboundSku").catch((error) => showToast(error.message, true));
    loadManualBoxes(state.manualInboundSkuId, "manualInboundBoxesBody").catch((error) => showToast(error.message, true));
  });

  $("refreshManualOutbound").addEventListener("click", () => {
    searchManualSkus($("manualOutboundKeyword").value.trim(), "manualOutboundSkuResults", "pickManualOutboundSku").catch((error) => showToast(error.message, true));
    loadManualBoxes(state.manualOutboundSkuId, "manualOutboundBoxesBody").catch((error) => showToast(error.message, true));
  });

  $("refreshAudit").addEventListener("click", () => loadAudit().catch((error) => showToast(error.message, true)));
}

bindTabs();
bindForms();
bindDelegates();
bindRefresh();
reloadAll().catch((error) => showToast(error.message, true));
