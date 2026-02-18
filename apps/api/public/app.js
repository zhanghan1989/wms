const state = {
  token: localStorage.getItem("wms_token") || "",
  me: null,
  shelves: [],
  inventorySkus: [],
  inventoryLocations: new Map(),
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

function switchPanel(targetId) {
  document.querySelectorAll(".nav-btn").forEach((button) => button.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));

  const button = document.querySelector(`.nav-btn[data-target="${targetId}"]`);
  if (button) button.classList.add("active");

  const panel = $(targetId);
  if (panel) panel.classList.add("active");
}

function openModal(modalId) {
  const modal = $(modalId);
  if (!modal) return;
  modal.classList.remove("hidden");
}

function closeModal(modalId) {
  const modal = $(modalId);
  if (!modal) return;
  modal.classList.add("hidden");
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
    button.addEventListener("click", () => switchPanel(button.dataset.target));
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

function renderInventoryLocationRows(rows) {
  if (!rows.length) {
    return '<span class="muted">无库存</span>';
  }

  return rows
    .map((row) => {
      const boxCode = row.box?.boxCode || "-";
      const shelfCode = row.box?.shelf?.shelfCode || "-";
      const qty = Number(row.qty ?? 0);
      return `<div>${escapeHtml(boxCode)} / ${escapeHtml(shelfCode)} / 数量 ${escapeHtml(qty)}</div>`;
    })
    .join("");
}

function renderInventoryTable() {
  $("inventoryBody").innerHTML = state.inventorySkus
    .map((sku) => {
      const rows = state.inventoryLocations.get(String(sku.id)) || [];
      return `
      <tr class="inventory-main-row">
        <td>${escapeHtml(sku.sku)}</td>
        <td>${escapeHtml(sku.erpSku)}</td>
        <td>${escapeHtml(sku.asin)}</td>
        <td>${escapeHtml(sku.fnsku)}</td>
        <td>
          <div class="action-row">
            <button class="tiny-btn" data-action="inventoryInbound" data-sku-id="${sku.id}">入库</button>
            <button class="tiny-btn ghost" data-action="inventoryOutbound" data-sku-id="${sku.id}">出库</button>
          </div>
        </td>
      </tr>
      <tr class="inventory-sub-row">
        <td colspan="5">
          <div class="location-list">
            <strong>所在箱号/货架号/数量：</strong>
            ${renderInventoryLocationRows(rows)}
          </div>
        </td>
      </tr>
    `;
    })
    .join("");
}

async function loadInventory() {
  const skus = await request("/skus");
  state.inventorySkus = skus;
  $("statSkus").textContent = skus.length;

  const locationEntries = await Promise.all(
    skus.map(async (sku) => [String(sku.id), await getSkuInventoryRows(sku.id)]),
  );
  state.inventoryLocations = new Map(locationEntries);

  renderInventoryTable();
}

function renderInventorySearchResults(skus, locationMap) {
  const container = $("inventorySearchResults");
  if (!skus.length) {
    container.textContent = "未找到匹配产品";
    return;
  }

  container.innerHTML = skus
    .map((sku) => {
      const labels = [sku.sku, sku.erpSku, sku.asin, sku.fnsku].filter(Boolean).join(" / ");
      const rows = locationMap.get(String(sku.id)) || [];
      return `
      <div class="inventory-search-item">
        <div class="inventory-search-title">${escapeHtml(labels)}</div>
        <div class="inventory-search-locations">${renderInventoryLocationRows(rows)}</div>
        <div class="action-row">
          <button class="tiny-btn" data-action="inventoryInbound" data-sku-id="${sku.id}">入库</button>
          <button class="tiny-btn ghost" data-action="inventoryOutbound" data-sku-id="${sku.id}">出库</button>
        </div>
      </div>
    `;
    })
    .join("");
}

async function searchInventoryProducts(keyword) {
  const container = $("inventorySearchResults");
  if (!keyword) {
    container.textContent = "-";
    return;
  }

  const skus = await request(`/inventory/search?keyword=${encodeURIComponent(keyword)}`);
  const locationEntries = await Promise.all(
    skus.map(async (sku) => [String(sku.id), await getSkuInventoryRows(sku.id)]),
  );
  renderInventorySearchResults(skus, new Map(locationEntries));
}

function renderShelfOptionsForSelect(selectId, placeholder) {
  const select = $(selectId);
  if (!select) return;

  const prev = select.value;
  const options = state.shelves
    .map((shelf) => {
      const isEnabled = Number(shelf.status) === 1;
      const disabledAttr = isEnabled ? "" : " disabled";
      const disabledMark = isEnabled ? "" : "（禁用）";
      return `<option value="${escapeHtml(shelf.id)}"${disabledAttr}>${escapeHtml(shelf.shelfCode)}${disabledMark}</option>`;
    })
    .join("");

  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
  if (prev && state.shelves.some((shelf) => String(shelf.id) === prev && Number(shelf.status) === 1)) {
    select.value = prev;
  }
}

async function loadShelves() {
  const shelves = await request("/shelves");
  state.shelves = shelves;
  $("statShelves").textContent = shelves.length;

  renderShelfOptionsForSelect("newBoxShelfId", "请选择货架号");
  renderShelfOptionsForSelect("modalNewSkuShelfId", "箱号已存在可不选；新建箱号请选货架号");

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

async function ensureBoxForSku(boxCode, shelfId) {
  const existed = await getExistingBoxByCode(boxCode);
  if (existed) return;

  if (!Number.isInteger(shelfId) || shelfId <= 0) {
    throw new Error("箱号不存在，请先选择货架号创建新箱号");
  }

  await request("/boxes", {
    method: "POST",
    body: JSON.stringify({ boxCode, shelfId }),
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
  return `${escapeHtml(item.entityType || "-")}#${escapeHtml(item.entityId || "-")}`;
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

function findSkuById(skuId) {
  return state.inventorySkus.find((sku) => Number(sku.id) === Number(skuId));
}

function openAdjustModal(direction, skuId) {
  const sku = findSkuById(skuId);
  const skuText = sku
    ? [sku.sku, sku.erpSku, sku.asin, sku.fnsku].filter(Boolean).join(" / ")
    : `SKU#${skuId}`;

  $("adjustSkuId").value = String(skuId);
  $("adjustDirection").value = direction;
  $("adjustSkuInfo").value = skuText;
  $("adjustBoxCode").value = "";
  $("adjustQty").value = "";
  $("adjustReason").value = direction === "inbound" ? "库存入库" : "库存出库";
  $("adjustModalTitle").textContent = direction === "inbound" ? "库存入库" : "库存出库";
  $("adjustSubmitBtn").textContent = direction === "inbound" ? "确认入库" : "确认出库";
  openModal("adjustModal");
}

async function submitAdjustForm() {
  const skuId = Number($("adjustSkuId").value);
  const direction = $("adjustDirection").value;
  const boxCode = $("adjustBoxCode").value.trim();
  const qty = Math.abs(Number($("adjustQty").value));
  const reason = $("adjustReason").value.trim() || undefined;

  if (!Number.isInteger(skuId) || skuId <= 0) {
    throw new Error("请选择产品");
  }
  if (!boxCode) {
    throw new Error("请输入箱号");
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error("数量必须大于 0");
  }

  await request("/inventory/manual-adjust", {
    method: "POST",
    body: JSON.stringify({
      skuId,
      boxCode,
      qtyDelta: direction === "outbound" ? -qty : qty,
      reason,
    }),
  });
}

async function createSkuFromModal() {
  const sku = $("modalNewSku").value.trim();
  const erpSku = $("modalNewErpSku").value.trim() || undefined;
  const asin = $("modalNewAsin").value.trim() || undefined;
  const fnsku = $("modalNewFnsku").value.trim() || undefined;
  const boxCode = $("modalNewSkuBoxCode").value.trim();
  const shelfId = Number($("modalNewSkuShelfId").value);
  const qty = Math.abs(Number($("modalNewSkuQty").value));
  const reason = $("modalNewSkuReason").value.trim() || "新建产品初始入库";

  if (!sku) throw new Error("SKU 不能为空");
  if (!boxCode) throw new Error("箱号不能为空");
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("数量必须大于 0");

  const possibleDuplicate = await request(`/skus?q=${encodeURIComponent(sku)}`);
  if (possibleDuplicate.some((item) => item.sku === sku)) {
    throw new Error("SKU 已存在");
  }

  await ensureBoxForSku(boxCode, shelfId);

  const createdSku = await request("/skus", {
    method: "POST",
    body: JSON.stringify({ sku, erpSku, asin, fnsku }),
  });

  await request("/inventory/manual-adjust", {
    method: "POST",
    body: JSON.stringify({
      skuId: createdSku.id,
      boxCode,
      qtyDelta: qty,
      reason,
    }),
  });
}

async function reloadAll() {
  await loadMe();
  if (!state.token) {
    clearStats();
    return;
  }

  await Promise.all([loadUsers(), loadInventory(), loadShelves(), loadBoxes(), loadInboundOrders(), loadAudit()]);
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
      switchPanel("inventory");
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
        throw new Error("请选择货架号");
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
      await loadInventory();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("inventorySearchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await searchInventoryProducts($("inventoryKeyword").value.trim());
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openCreateSkuModal").addEventListener("click", async () => {
    if (!state.shelves.length) {
      await loadShelves().catch((error) => showToast(error.message, true));
    }
    $("createSkuModalForm").reset();
    $("modalNewSkuQty").value = "1";
    $("modalNewSkuReason").value = "新建产品初始入库";
    openModal("createSkuModal");
  });

  $("createSkuModalForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await createSkuFromModal();
      closeModal("createSkuModal");
      showToast("产品已创建并入库");
      await loadShelves();
      await loadBoxes();
      await loadInventory();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("adjustForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await submitAdjustForm();
      closeModal("adjustModal");
      showToast($("adjustDirection").value === "outbound" ? "出库成功" : "入库成功");
      await loadInventory();
      await loadBoxes();
      await loadAudit();
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

  const openAdjustByAction = (event) => {
    const button = event.target.closest("button[data-action='inventoryInbound'], button[data-action='inventoryOutbound']");
    if (!button) return;

    const skuId = Number(button.dataset.skuId);
    if (!Number.isInteger(skuId) || skuId <= 0) return;

    const direction = button.dataset.action === "inventoryOutbound" ? "outbound" : "inbound";
    openAdjustModal(direction, skuId);
  };

  $("inventoryBody").addEventListener("click", openAdjustByAction);
  $("inventorySearchResults").addEventListener("click", openAdjustByAction);

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='closeCreateSkuModal']");
    if (button) {
      closeModal("createSkuModal");
      return;
    }
    const adjustClose = event.target.closest("button[data-action='closeAdjustModal']");
    if (adjustClose) {
      closeModal("adjustModal");
    }
  });

  $("createSkuModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("createSkuModal");
    }
  });

  $("adjustModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("adjustModal");
    }
  });
}

function bindRefresh() {
  $("refreshInventory").addEventListener("click", () => loadInventory().catch((error) => showToast(error.message, true)));
  $("refreshUsers").addEventListener("click", () => loadUsers().catch((error) => showToast(error.message, true)));
  $("refreshShelves").addEventListener("click", () => loadShelves().catch((error) => showToast(error.message, true)));
  $("refreshBoxes").addEventListener("click", () => loadBoxes().catch((error) => showToast(error.message, true)));
  $("refreshInbound").addEventListener("click", () => loadInboundOrders().catch((error) => showToast(error.message, true)));
  $("refreshAudit").addEventListener("click", () => loadAudit().catch((error) => showToast(error.message, true)));
}

bindTabs();
bindForms();
bindDelegates();
bindRefresh();
switchPanel("inventory");
reloadAll().catch((error) => showToast(error.message, true));
