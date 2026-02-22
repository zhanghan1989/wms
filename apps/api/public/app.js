const state = {
  token: localStorage.getItem("wms_token") || "",
  me: null,
  shelves: [],
  boxes: [],
  inventorySkus: [],
  brands: [],
  skuTypes: [],
  shops: [],
  skuEditRequests: [],
  inventoryLocations: new Map(),
  inventorySortedSkus: [],
  inventoryVisibleCount: 0,
  inventoryPageSize: 30,
  inventorySearchMode: false,
  batchInboundOrders: [],
  selectedBatchInboundOrderId: "",
  selectedBatchInboundOrderDetail: null,
  fbaReplenishments: [],
  fbaPendingCount: 0,
  productEditPendingCount: 0,
  fbaPendingBySku: {},
  fbaPendingByBoxSku: {},
  selectedProductEditRequestId: null,
  selectedFbaIds: new Set(),
  brandEditingIds: new Set(),
  skuTypeEditingIds: new Set(),
  shopEditingIds: new Set(),
  plainPasswords: (() => {
    try {
      const raw = localStorage.getItem("wms_plain_password_map");
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  })(),
};

let deleteConfirmResolver = null;
let actionConfirmResolver = null;
let toastTimer = null;

const $ = (id) => document.getElementById(id);

function showToast(message, isError = false) {
  if (isError) {
    showErrorModal(message);
    return;
  }

  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.classList.remove("error");
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toastTimer = setTimeout(() => {
    toast.classList.add("hidden");
    toastTimer = null;
  }, 3000);
}

function showErrorModal(message) {
  const text = String(message || "发生未知错误");
  const messageEl = $("errorModalMessage");
  if (messageEl) {
    messageEl.textContent = text;
  }
  openModal("errorModal");
}

function closeErrorModal() {
  closeModal("errorModal");
}

function normalizeErrorMessage(message) {
  const raw = String(message || "").trim();
  if (!raw) {
    return "发生未知错误";
  }

  const exactMap = {
    "Request failed": "请求失败",
    "Internal Server Error": "服务器内部错误",
    "Failed to fetch": "网络请求失败，请检查网络连接",
    Unauthorized: "未授权，请重新登录",
    Forbidden: "无权限执行该操作",
    "Forbidden resource": "无权限执行该操作",
  };
  if (exactMap[raw]) {
    return exactMap[raw];
  }

  const httpMatch = raw.match(/^HTTP\s+(\d{3})$/i);
  if (httpMatch) {
    return `请求失败（HTTP ${httpMatch[1]}）`;
  }

  const lockedMatch = raw.match(
    /^box code is locked by batch inbound order\s+(.+),\s*please confirm or delete that order first$/i,
  );
  if (lockedMatch) {
    return `箱号已被批量入库单 ${lockedMatch[1]} 锁定，请先确认或删除该单据`;
  }

  return raw;
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

function getRoleText(role) {
  return role === "admin" ? "管理者" : "员工";
}

function getFbaStatusText(status) {
  if (status === "pending_confirm") return "待确认";
  if (status === "pending_outbound") return "待出库";
  if (status === "outbound") return "已出库";
  if (status === "deleted") return "已删除";
  return displayText(status);
}

function getProductEditRequestStatusText(status) {
  if (status === "pending") return "待处理";
  if (status === "confirmed") return "已确认";
  if (status === "deleted") return "已删除";
  return displayText(status);
}

function parseFixedDigits(raw, length, fieldName) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length !== length) {
    throw new Error(`${fieldName}必须是${length}位数字`);
  }
  return digits;
}

function buildBoxCode(rawDigits) {
  return `B-${parseFixedDigits(rawDigits, 4, "箱号")}`;
}

function buildShelfCode(rawDigits) {
  return `S-${parseFixedDigits(rawDigits, 3, "货架号")}`;
}

function clearStats() {
  $("statUsers").textContent = "-";
  $("statSkus").textContent = "-";
  $("statShelves").textContent = "-";
  $("statBoxes").textContent = "-";
  $("statInboundDraft").textContent = "-";
}

function displayText(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  return String(value);
}

function applyRoleView() {
  const layout = document.querySelector(".layout");
  const quickActions = $("employeeQuickActions");
  const isLoggedIn = Boolean(state.me);
  const isEmployee = Boolean(state.me?.role === "employee");

  if (layout) {
    layout.classList.toggle("no-sidebar", isEmployee);
  }
  if (quickActions) {
    quickActions.classList.toggle("hidden", !isLoggedIn);
  }
}

function setAuthGate(isLoggedIn) {
  $("loginGate").classList.toggle("hidden", isLoggedIn);
  $("appTopbar").classList.toggle("hidden", !isLoggedIn);
  $("appLayout").classList.toggle("hidden", !isLoggedIn);
}

function setInventoryDisplayMode(searchMode) {
  state.inventorySearchMode = searchMode;
  const listSection = $("inventoryListSection");
  const searchSection = $("inventorySearchSection");
  if (listSection) listSection.classList.toggle("hidden", searchMode);
  if (searchSection) searchSection.classList.toggle("hidden", !searchMode);
}

function focusInventorySearch() {
  const panel = $("inventory");
  if (!panel || !panel.classList.contains("active")) return;
  const input = $("inventoryKeyword");
  if (!input || document.activeElement === input) return;
  setTimeout(() => input.focus(), 0);
}

function switchPanel(targetId) {
  document.querySelectorAll(".nav-btn").forEach((button) => button.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));

  const button = document.querySelector(`.nav-btn[data-target="${targetId}"]`);
  if (button) button.classList.add("active");

  const panel = $(targetId);
  if (panel) panel.classList.add("active");
  if (targetId === "inventory") {
    focusInventorySearch();
  }
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

function openDeleteConfirmModal(messageText) {
  const message = $("deleteConfirmMessage");
  if (message) {
    message.textContent = String(messageText || "确认删除当前数据？");
  }
  if (typeof deleteConfirmResolver === "function") {
    deleteConfirmResolver(false);
    deleteConfirmResolver = null;
  }
  openModal("deleteConfirmModal");
  return new Promise((resolve) => {
    deleteConfirmResolver = resolve;
  });
}

function resolveDeleteConfirm(confirmed) {
  closeModal("deleteConfirmModal");
  if (typeof deleteConfirmResolver === "function") {
    const resolve = deleteConfirmResolver;
    deleteConfirmResolver = null;
    resolve(Boolean(confirmed));
  }
}

function openActionConfirmModal(messageText, titleText = "确认操作", confirmText = "确认") {
  const title = $("actionConfirmTitle");
  const message = $("actionConfirmMessage");
  const okBtn = $("actionConfirmOkBtn");
  if (title) {
    title.innerHTML = `<span class="confirm-icon">!</span>${escapeHtml(titleText)}`;
  }
  if (message) {
    message.textContent = String(messageText || "确认执行当前操作？");
  }
  if (okBtn) {
    okBtn.textContent = String(confirmText || "确认");
  }
  if (typeof actionConfirmResolver === "function") {
    actionConfirmResolver(false);
    actionConfirmResolver = null;
  }
  openModal("actionConfirmModal");
  return new Promise((resolve) => {
    actionConfirmResolver = resolve;
  });
}

function resolveActionConfirm(confirmed) {
  closeModal("actionConfirmModal");
  if (typeof actionConfirmResolver === "function") {
    const resolve = actionConfirmResolver;
    actionConfirmResolver = null;
    resolve(Boolean(confirmed));
  }
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

  let res;
  try {
    res = await fetch(`/api${path}`, { ...options, headers });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }
  const text = await res.text();

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text || "请求失败" };
  }

  if (!res.ok || payload.code !== 0) {
    throw new Error(normalizeErrorMessage(payload.message || `HTTP ${res.status}`));
  }

  return payload.data;
}

function bindTabs() {
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => switchPanel(button.dataset.target));
  });
}

function bindDigitInput(id, maxLen) {
  const input = $(id);
  if (!input) return;
  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "").slice(0, maxLen);
    if (input.value !== digits) {
      input.value = digits;
    }
  });
}

function bindPositiveIntegerInput(id, { min = 1, max = null } = {}) {
  const input = $(id);
  if (!input) return;

  const normalize = () => {
    let digits = String(input.value || "").replace(/\D/g, "");
    digits = digits.replace(/^0+/, "");
    if (!digits) {
      input.value = "";
      return;
    }
    let value = Number(digits);
    if (Number.isNaN(value)) {
      input.value = "";
      return;
    }
    if (value < min) value = min;
    if (max !== null && value > max) value = max;
    input.value = String(value);
  };

  input.addEventListener("input", normalize);
  input.addEventListener("blur", normalize);
}

function bindBatchNoInput(id) {
  const input = $(id);
  if (!input) return;
  input.addEventListener("input", () => {
    const normalized = String(input.value || "")
      .replace(/\D/g, "")
      .replace(/^0+/, "")
      .slice(0, 20);
    if (input.value !== normalized) {
      input.value = normalized;
    }
  });
}

function bindInputRules() {
  bindDigitInput("newShelfCodeDigits", 3);
  bindDigitInput("newBoxCodeDigits", 4);
  bindDigitInput("modalNewBoxCodeDigits", 4);
  bindDigitInput("modalNewShelfCodeDigits", 3);
  bindPositiveIntegerInput("batchCollectBoxCount", { min: 1, max: 500 });
  bindBatchNoInput("batchCollectBatchNo");
}

async function loadMe() {
  if (!state.token) {
    state.me = null;
    $("sessionInfo").textContent = "未登录";
    $("meCard").textContent = "-";
    setAuthGate(false);
    applyRoleView();
    return;
  }

  try {
    state.me = await request("/auth/me");
    $("sessionInfo").textContent = `${state.me.username} (${state.me.role})`;
    $("meCard").textContent = JSON.stringify(state.me, null, 2);
    setAuthGate(true);
    applyRoleView();
  } catch {
    state.token = "";
    state.me = null;
    localStorage.removeItem("wms_token");
    $("sessionInfo").textContent = "登录失效";
    $("meCard").textContent = "-";
    setAuthGate(false);
    applyRoleView();
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
        <td>${escapeHtml(state.plainPasswords[user.username] || "-")}</td>
        <td>${escapeHtml(getRoleText(user.role))}</td>
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

async function getCurrentBoxSkuQty(skuId, boxCode) {
  const normalizedBoxCode = normalizeBoxCodeInput(boxCode);
  if (!normalizedBoxCode) return 0;
  const rows = await getSkuInventoryRows(skuId);
  const matched = rows.find(
    (row) => String(row?.box?.boxCode || "").toUpperCase() === normalizedBoxCode,
  );
  return Math.max(0, Number(matched?.qty ?? 0));
}

async function getBoxSkuInventoryRows(boxId) {
  try {
    return await request(`/inventory/box-skus?boxId=${boxId}`);
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

function renderInboundButton(skuId, boxCode = "", label = "新增入库", lockBox = false) {
  const boxAttr = boxCode ? ` data-box-code="${escapeHtml(boxCode)}"` : "";
  const lockAttr = lockBox ? ' data-lock-box="1"' : "";
  return `<button class="tiny-btn" data-action="inventoryInbound" data-sku-id="${skuId}"${boxAttr}${lockAttr}>${escapeHtml(label)}</button>`;
}

function renderEditButton(skuId) {
  return `<button class="tiny-btn" data-action="inventoryEdit" data-sku-id="${skuId}">编辑</button>`;
}

function renderOutboundButton(
  skuId,
  totalQty,
  boxCode = "",
  { label = "FBA补货", ghost = true, lockBox = false, action = "inventoryOutbound", maxQty = null } = {},
) {
  if (Number(totalQty) <= 0) {
    return "";
  }
  const boxAttr = boxCode ? ` data-box-code="${escapeHtml(boxCode)}"` : "";
  const lockAttr = lockBox ? ' data-lock-box="1"' : "";
  const normalizedMaxQty = Math.floor(Number(maxQty));
  const maxQtyAttr = Number.isInteger(normalizedMaxQty) && normalizedMaxQty > 0
    ? ` data-max-qty="${escapeHtml(normalizedMaxQty)}"`
    : "";
  const className = ghost ? "tiny-btn ghost" : "tiny-btn";
  return `<button class="${className}" data-action="${action}" data-sku-id="${skuId}"${boxAttr}${lockAttr}${maxQtyAttr}>${escapeHtml(label)}</button>`;
}

function getFbaPendingQtyBySku(skuId) {
  return Number(state.fbaPendingBySku[String(skuId)] || 0);
}

function getFbaPendingQtyByBoxSku(boxId, skuId) {
  return Number(state.fbaPendingByBoxSku[`${String(boxId)}-${String(skuId)}`] || 0);
}

function renderQtyWithPending(qty, pendingQty) {
  const safeQty = Number(qty || 0);
  const safePending = Number(pendingQty || 0);
  if (safePending <= 0) {
    return escapeHtml(safeQty);
  }
  return `${escapeHtml(safeQty)}<span class="qty-pending">(-${escapeHtml(safePending)})</span>`;
}

function renderBoxSkuFlatTable(currentSku, rows, boxSkuMap) {
  const currentSkuId = Number(currentSku.id);
  const currentSkuRows = rows
    .filter((row) => Number(row.qty ?? 0) > 0 && row.box?.id)
    .sort((a, b) => Number(a.qty ?? 0) - Number(b.qty ?? 0));
  if (!currentSkuRows.length) {
    return "";
  }

  const targetBoxes = currentSkuRows
    .map((row) => ({
      boxId: String(row.box.id),
      boxCode: row.box?.boxCode || "-",
      shelfCode: row.box?.shelf?.shelfCode || "-",
      currentSkuQty: Number(row.qty ?? 0),
    }))
    .sort((a, b) => a.currentSkuQty - b.currentSkuQty);

  const flatRows = targetBoxes.flatMap((box) => {
    const boxRows = (boxSkuMap.get(String(box.boxId)) || [])
      .filter((row) => Number(row.qty ?? 0) > 0)
      .sort((a, b) => {
        const aIsCurrent = Number(a.sku?.id) === currentSkuId;
        const bIsCurrent = Number(b.sku?.id) === currentSkuId;
        if (aIsCurrent !== bIsCurrent) {
          return aIsCurrent ? -1 : 1;
        }
        if (!aIsCurrent && !bIsCurrent) {
          const qtyDiff = Number(b.qty ?? 0) - Number(a.qty ?? 0);
          if (qtyDiff !== 0) {
            return qtyDiff;
          }
        }
        return String(displayText(a.sku?.sku)).localeCompare(String(displayText(b.sku?.sku)), "en", { numeric: true });
      });
    if (!boxRows.length) {
      return [
        {
          boxId: box.boxId,
          boxCode: "",
          shelfCode: "",
          skuId: 0,
          sku: "-",
          qty: 0,
          isCurrentSku: false,
        },
      ];
    }
    return boxRows.map((row) => ({
      boxId: box.boxId,
      boxCode: Number(row.sku?.id) === currentSkuId ? box.boxCode : "",
      shelfCode: Number(row.sku?.id) === currentSkuId ? box.shelfCode : "",
      skuId: Number(row.sku?.id || 0),
      sku: row.sku?.sku || "-",
      qty: Number(row.qty ?? 0),
      isCurrentSku: Number(row.sku?.id) === currentSkuId,
    }));
  });

  if (!flatRows.length) {
    return "";
  }

  return `
    <div class="inventory-box-table-wrap">
      <table class="inventory-box-table">
        <thead>
          <tr><th>箱号</th><th>货架号</th><th>SKU</th><th>数量</th><th></th></tr>
        </thead>
        <tbody>
          ${flatRows
            .map((row) => {
              const inboundButton = renderInboundButton(currentSkuId, row.boxCode, "入库", true);
              const outboundPrimaryButton = renderOutboundButton(currentSkuId, row.qty, row.boxCode, {
                label: "FBA补货",
                ghost: false,
                lockBox: true,
                action: "inventoryOutbound",
                maxQty: row.qty,
              });
              const outboundOneButton = renderOutboundButton(currentSkuId, row.qty, row.boxCode, {
                label: "出库1件",
                ghost: false,
                lockBox: true,
                action: "inventoryOutboundOne",
              });
              const actionButtons = row.isCurrentSku
                ? `
                  <div class="action-row">
                    ${inboundButton}
                    ${outboundPrimaryButton}
                    ${outboundOneButton}
                  </div>
                `
                : '<span class="muted">-</span>';
              return `
                <tr class="${row.isCurrentSku ? "inventory-current-sku-row" : ""}">
                  <td>${escapeHtml(row.boxCode)}</td>
                  <td>${escapeHtml(row.shelfCode)}</td>
                  <td>${escapeHtml(row.sku)}</td>
                  <td>${renderQtyWithPending(row.qty, row.isCurrentSku ? getFbaPendingQtyByBoxSku(row.boxId, currentSkuId) : 0)}</td>
                  <td>${actionButtons}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderInventoryTable() {
  const list = state.inventorySortedSkus.slice(0, state.inventoryVisibleCount);
  const html = list
    .map((sku) => {
      const rows = state.inventoryLocations.get(String(sku.id)) || [];
      const totalQty = rows.reduce((sum, row) => sum + Number(row.qty ?? 0), 0);
      const pendingQty = getFbaPendingQtyBySku(sku.id);
      return `
      <tr class="inventory-main-row">
        <td>${escapeHtml(displayText(sku.model))}</td>
        <td>${escapeHtml(displayText(sku.brand))}</td>
        <td>${escapeHtml(displayText(sku.type))}</td>
        <td>${escapeHtml(displayText(sku.color))}</td>
        <td>${escapeHtml(displayText(sku.remark))}</td>
        <td>${escapeHtml(sku.sku)}</td>
        <td>${escapeHtml(displayText(sku.shop))}</td>
        <td>${renderQtyWithPending(totalQty, pendingQty)}</td>
        <td>
          <div class="action-row">
            ${renderEditButton(sku.id)}
          </div>
        </td>
      </tr>
    `;
    })
    .join("");

  $("inventoryBody").innerHTML = html || '<tr><td colspan="9" class="muted">-</td></tr>';
}

function loadMoreInventoryIfNeeded() {
  if (state.inventorySearchMode) return;
  if (!state.token) return;
  const inventoryPanel = $("inventory");
  if (!inventoryPanel || !inventoryPanel.classList.contains("active")) return;
  if (state.inventoryVisibleCount >= state.inventorySortedSkus.length) return;
  state.inventoryVisibleCount += state.inventoryPageSize;
  renderInventoryTable();
}

async function loadInventory() {
  const skus = await request("/skus");
  state.inventorySkus = skus;
  $("statSkus").textContent = skus.length;
  renderSkuOptionsForSelect("moveProductSkuId", "请选择SKU");
  await loadFbaPendingSummary();

  const locationEntries = await Promise.all(
    skus.map(async (sku) => [String(sku.id), await getSkuInventoryRows(sku.id)]),
  );
  state.inventoryLocations = new Map(locationEntries);

  state.inventorySortedSkus = [...skus].sort((a, b) => {
    const qtyA = (state.inventoryLocations.get(String(a.id)) || []).reduce(
      (sum, row) => sum + Number(row.qty ?? 0),
      0,
    );
    const qtyB = (state.inventoryLocations.get(String(b.id)) || []).reduce(
      (sum, row) => sum + Number(row.qty ?? 0),
      0,
    );
    return qtyB - qtyA;
  });
  state.inventoryVisibleCount = state.inventoryPageSize;
  setInventoryDisplayMode(false);
  renderInventoryTable();
  await refreshMoveProductOldBoxOptionsBySku();
}

function renderInventorySearchResults(skus, locationMap, boxSkuMap) {
  const container = $("inventorySearchResults");
  if (!skus.length) {
    container.textContent = "未找到匹配产品";
    return;
  }

  container.innerHTML = skus
    .map((sku) => {
      const rows = locationMap.get(String(sku.id)) || [];
      const totalQty = rows.reduce((sum, row) => sum + Number(row.qty ?? 0), 0);
      const pendingQty = getFbaPendingQtyBySku(sku.id);
      const leftRows = [
        ["型号", displayText(sku.model)],
        ["品牌", displayText(sku.brand)],
        ["类型", displayText(sku.type)],
        ["颜色", displayText(sku.color)],
        ["备注", displayText(sku.remark)],
        ["店铺", displayText(sku.shop)],
      ];
      const rightRows = [
        ["SKU", displayText(sku.sku)],
        ["erpSKU", displayText(sku.erpSku)],
        ["ASIN", displayText(sku.asin)],
        ["FNSKU", displayText(sku.fnsku)],
        ["库存总数量", totalQty],
      ];
      const boxTable = totalQty > 0 ? renderBoxSkuFlatTable(sku, rows, boxSkuMap) : "";
      const topActionRow = `<div class="action-row">${renderInboundButton(sku.id, "", "新增入库")}</div>`;
      return `
      <div class="inventory-search-item">
        <div class="inventory-search-fields">
          <div class="inventory-search-column">
            ${leftRows
              .map(
                ([name, value]) => `
              <div class="inventory-search-field">
                <span class="inventory-search-field-name">${escapeHtml(name)}：</span>
                <span class="inventory-search-field-value">${escapeHtml(value)}</span>
              </div>
            `,
              )
              .join("")}
          </div>
          <div class="inventory-search-column">
            ${rightRows
              .map(
                ([name, value]) => `
              <div class="inventory-search-field">
                <span class="inventory-search-field-name">${escapeHtml(name)}：</span>
                <span class="inventory-search-field-value">${
                  name === "库存总数量"
                    ? renderQtyWithPending(value, pendingQty)
                    : escapeHtml(value)
                }</span>
              </div>
            `,
              )
              .join("")}
          </div>
        </div>
        ${totalQty > 0 ? "" : `<div class="inventory-search-locations">${renderInventoryLocationRows(rows)}</div>`}
        ${topActionRow}
        ${boxTable}
      </div>
    `;
    })
    .join("");
}

async function searchInventoryProducts(keyword) {
  const container = $("inventorySearchResults");
  if (!keyword) {
    setInventoryDisplayMode(false);
    renderInventoryTable();
    focusInventorySearch();
    return;
  }

  setInventoryDisplayMode(true);
  const skus = await request(`/inventory/search?keyword=${encodeURIComponent(keyword)}`);
  const locationEntries = await Promise.all(
    skus.map(async (sku) => [String(sku.id), await getSkuInventoryRows(sku.id)]),
  );
  const boxIds = Array.from(
    new Set(
      locationEntries
        .flatMap(([, rows]) => rows.map((row) => row.box?.id))
        .filter((boxId) => boxId !== null && boxId !== undefined)
        .map((boxId) => String(boxId)),
    ),
  );
  const boxSkuEntries = await Promise.all(
    boxIds.map(async (boxId) => [String(boxId), await getBoxSkuInventoryRows(boxId)]),
  );
  await loadFbaPendingSummary();
  renderInventorySearchResults(skus, new Map(locationEntries), new Map(boxSkuEntries));
}

function findSkuById(skuId) {
  return state.inventorySkus.find((sku) => Number(sku.id) === Number(skuId));
}

async function openEditSkuModal(skuId) {
  const sku = findSkuById(skuId);
  if (!sku) {
    throw new Error("未找到产品");
  }
  await Promise.all([loadBrands(), loadSkuTypes(), loadShops()]);

  $("editSkuId").value = String(sku.id);
  $("editModel").value = sku.model || "";
  renderBrandOptionsForSelect("editBrand", "请选择品牌", sku.brand || "");
  renderSkuTypeOptionsForSelect("editType", "请选择类型", sku.type || "");
  $("editColor").value = sku.color || "";
  renderShopOptionsForSelect("editShop", "请选择店铺", sku.shop || "");
  $("editRemark").value = sku.remark || "";
  $("editSku").value = sku.sku || "";
  $("editErpSku").value = sku.erpSku || "";
  $("editAsin").value = sku.asin || "";
  $("editFnsku").value = sku.fnsku || "";
  openModal("editSkuModal");
}

async function submitEditSkuForm() {
  const skuId = Number($("editSkuId").value);
  if (!Number.isInteger(skuId) || skuId <= 0) {
    throw new Error("请选择产品");
  }

  const payload = {
    skuId,
    sku: $("editSku").value.trim() || undefined,
    model: $("editModel").value.trim() || undefined,
    brand: $("editBrand").value.trim() || undefined,
    type: $("editType").value.trim() || undefined,
    color: $("editColor").value.trim() || undefined,
    shop: $("editShop").value.trim() || undefined,
    remark: $("editRemark").value.trim() || undefined,
    erpSku: $("editErpSku").value.trim() || undefined,
    asin: $("editAsin").value.trim() || undefined,
    fnsku: $("editFnsku").value.trim() || undefined,
  };

  await request("/sku-edit-requests", {
    method: "POST",
    body: JSON.stringify(payload),
  });
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

function renderBoxOptionsForSelect(selectId, placeholder) {
  const select = $(selectId);
  if (!select) return;

  const prev = select.value;
  const options = getEnabledBoxesSorted()
    .map((box) => {
      const shelfCode = box?.shelf?.shelfCode ? ` / ${box.shelf.shelfCode}` : "";
      return `<option value="${escapeHtml(box.id)}">${escapeHtml(box.boxCode)}${escapeHtml(shelfCode)}</option>`;
    })
    .join("");

  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
  if (prev && getEnabledBoxesSorted().some((box) => String(box.id) === String(prev))) {
    select.value = prev;
  }
}

function renderSkuOptionsForSelect(selectId, placeholder) {
  const select = $(selectId);
  if (!select) return;

  const prev = select.value;
  const options = [...state.inventorySkus]
    .sort((a, b) => String(a.sku || "").localeCompare(String(b.sku || ""), "en", { numeric: true }))
    .map((sku) => `<option value="${escapeHtml(sku.id)}">${escapeHtml(sku.sku)}</option>`)
    .join("");

  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
  if (prev && state.inventorySkus.some((sku) => String(sku.id) === String(prev))) {
    select.value = prev;
  }
}

function getEnabledBrandsSorted() {
  return state.brands
    .filter((item) => Number(item.status) === 1)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN", { numeric: true }));
}

function getEnabledSkuTypesSorted() {
  return state.skuTypes
    .filter((item) => Number(item.status) === 1)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN", { numeric: true }));
}

function getEnabledShopsSorted() {
  return state.shops
    .filter((item) => Number(item.status) === 1)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN", { numeric: true }));
}

function renderBrandOptionsForSelect(selectId, placeholder, selectedValue = "") {
  const select = $(selectId);
  if (!select) return;

  const prev = selectedValue || select.value;
  const options = getEnabledBrandsSorted()
    .map((brand) => `<option value="${escapeHtml(brand.name)}">${escapeHtml(brand.name)}</option>`)
    .join("");
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
  if (prev) {
    const exists = Array.from(select.options).some((option) => option.value === prev);
    if (!exists) {
      const extra = document.createElement("option");
      extra.value = prev;
      extra.textContent = `${prev}（历史值）`;
      select.appendChild(extra);
    }
    select.value = prev;
  }
}

function renderSkuTypeOptionsForSelect(selectId, placeholder, selectedValue = "") {
  const select = $(selectId);
  if (!select) return;

  const prev = selectedValue || select.value;
  const options = getEnabledSkuTypesSorted()
    .map((skuType) => `<option value="${escapeHtml(skuType.name)}">${escapeHtml(skuType.name)}</option>`)
    .join("");
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
  if (prev) {
    const exists = Array.from(select.options).some((option) => option.value === prev);
    if (!exists) {
      const extra = document.createElement("option");
      extra.value = prev;
      extra.textContent = `${prev}（历史值）`;
      select.appendChild(extra);
    }
    select.value = prev;
  }
}

function renderShopOptionsForSelect(selectId, placeholder, selectedValue = "") {
  const select = $(selectId);
  if (!select) return;

  const prev = selectedValue || select.value;
  const options = getEnabledShopsSorted()
    .map((shop) => `<option value="${escapeHtml(shop.name)}">${escapeHtml(shop.name)}</option>`)
    .join("");
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
  if (prev) {
    const exists = Array.from(select.options).some((option) => option.value === prev);
    if (!exists) {
      const extra = document.createElement("option");
      extra.value = prev;
      extra.textContent = `${prev}（历史值）`;
      select.appendChild(extra);
    }
    select.value = prev;
  }
}

function renderBrandsTable() {
  const body = $("brandsBody");
  if (!body) return;
  const rows = [...state.brands].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN", { numeric: true }),
  );

  body.innerHTML =
    rows
      .map(
        (item) => {
          const itemId = String(item.id);
          const editing = state.brandEditingIds.has(itemId);
          return `
      <tr>
        <td>
          <input
            id="brandName-${escapeHtml(item.id)}"
            value="${escapeHtml(item.name)}"
            maxlength="128"
            ${editing ? "" : "readonly"}
            data-original-name="${escapeHtml(item.name)}"
          />
        </td>
        <td>
          <button class="tiny-btn" data-action="editBrand" data-id="${escapeHtml(item.id)}">${editing ? "确认变更" : "变更"}</button>
          <button class="tiny-btn danger" data-action="deleteBrand" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">删除</button>
        </td>
      </tr>
    `;
        },
      )
      .join("") || '<tr><td colspan="2" class="muted">-</td></tr>';
}

function renderSkuTypesTable() {
  const body = $("skuTypesBody");
  if (!body) return;
  const rows = [...state.skuTypes].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN", { numeric: true }),
  );

  body.innerHTML =
    rows
      .map((item) => {
        const itemId = String(item.id);
        const editing = state.skuTypeEditingIds.has(itemId);
        return `
      <tr>
        <td>
          <input
            id="skuTypeName-${escapeHtml(item.id)}"
            value="${escapeHtml(item.name)}"
            maxlength="128"
            ${editing ? "" : "readonly"}
            data-original-name="${escapeHtml(item.name)}"
          />
        </td>
        <td>
          <button class="tiny-btn" data-action="editSkuType" data-id="${escapeHtml(item.id)}">${editing ? "确认变更" : "变更"}</button>
          <button class="tiny-btn danger" data-action="deleteSkuType" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">删除</button>
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="2" class="muted">-</td></tr>';
}

function renderShopsTable() {
  const body = $("shopsBody");
  if (!body) return;
  const rows = [...state.shops].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN", { numeric: true }),
  );

  body.innerHTML =
    rows
      .map((item) => {
        const itemId = String(item.id);
        const editing = state.shopEditingIds.has(itemId);
        return `
      <tr>
        <td>
          <input
            id="shopName-${escapeHtml(item.id)}"
            value="${escapeHtml(item.name)}"
            maxlength="128"
            ${editing ? "" : "readonly"}
            data-original-name="${escapeHtml(item.name)}"
          />
        </td>
        <td>
          <button class="tiny-btn" data-action="editShop" data-id="${escapeHtml(item.id)}">${editing ? "确认变更" : "变更"}</button>
          <button class="tiny-btn danger" data-action="deleteShop" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}">删除</button>
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="2" class="muted">-</td></tr>';
}

function renderProductEditRequestTable() {
  const body = $("productEditRequestBody");
  if (!body) return;

  body.innerHTML =
    state.skuEditRequests
      .map((item) => {
        const skuText = item?.sku?.sku || "-";
        const statusText = getProductEditRequestStatusText(item?.status);
        const creatorText = item?.creator?.username || "-";
        const canDelete = item?.status === "pending";
        return `
      <tr>
        <td>${escapeHtml(formatDate(item?.createdAt))}</td>
        <td>${escapeHtml(displayText(skuText))}</td>
        <td><span class="edit-request-status">${escapeHtml(statusText)}</span></td>
        <td>${escapeHtml(displayText(creatorText))}</td>
        <td>
          <button class="tiny-btn" data-action="openProductEditRequestDetail" data-id="${escapeHtml(item?.id)}">编辑详情</button>
          <button class="tiny-btn danger" data-action="deleteProductEditRequestRow" data-id="${escapeHtml(item?.id)}" ${canDelete ? "" : "disabled"}>删除</button>
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="5" class="muted">-</td></tr>';
}

function renderProductEditRequestDetail(item) {
  const meta = $("productEditRequestMeta");
  const compare = $("productEditRequestCompare");
  const confirmBtn = $("confirmProductEditRequestBtn");
  if (!meta || !compare || !confirmBtn) return;

  if (!item) {
    state.selectedProductEditRequestId = null;
    meta.innerHTML = "";
    compare.innerHTML = '<div class="muted">暂无数据</div>';
    confirmBtn.classList.add("hidden");
    return;
  }

  state.selectedProductEditRequestId = Number(item.id);
  meta.innerHTML = `
    <div><strong>SKU：</strong>${escapeHtml(displayText(item?.sku?.sku))}</div>
    <div><strong>申请人：</strong>${escapeHtml(displayText(item?.creator?.username))}</div>
    <div><strong>申请时间：</strong>${escapeHtml(formatDate(item?.createdAt))}</div>
    <div><strong>状态：</strong>${escapeHtml(getProductEditRequestStatusText(item?.status))}</div>
  `;

  const fieldDefs = [
    ["model", "型号"],
    ["brand", "品牌"],
    ["type", "类型"],
    ["color", "颜色"],
    ["shop", "所属亚马逊店铺"],
    ["remark", "备注"],
    ["sku", "SKU"],
    ["erpSku", "erpSKU"],
    ["asin", "ASIN"],
    ["fnsku", "FNSKU"],
  ];
  const changedSet = new Set(Array.isArray(item?.changedFields) ? item.changedFields : []);
  const beforeData = item?.beforeData || {};
  const afterData = item?.afterData || {};

  const renderCol = (title, data, side) => `
    <div class="edit-request-compare-col">
      <h4>${escapeHtml(title)}</h4>
      <div class="edit-request-field-list">
        ${fieldDefs
          .map(([fieldKey, label]) => {
            const changed = changedSet.has(fieldKey);
            const value = displayText(data?.[fieldKey]);
            const changedClass = changed ? " changed" : "";
            return `
              <div class="edit-request-field">
                <span class="edit-request-field-name">${escapeHtml(label)}：</span>
                <span class="edit-request-field-value${changedClass}" data-side="${escapeHtml(side)}">${escapeHtml(value)}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;

  compare.innerHTML = `${renderCol("变更前", beforeData, "before")}${renderCol("变更后", afterData, "after")}`;
  const canOperate = item?.status === "pending";
  confirmBtn.classList.toggle("hidden", !canOperate);
}

function renderBoxOptionsForInput(inputId, listId, placeholder, keyword = "") {
  const input = $(inputId);
  const datalist = $(listId);
  if (!input || !datalist) return;

  const prev = input.value;
  input.placeholder = placeholder;
  const matches = filterAdjustBoxes(keyword);
  datalist.innerHTML = matches
    .map((box) => `<option value="${escapeHtml(box.boxCode)}"></option>`)
    .join("");

  if (prev) {
    input.value = prev;
  }
}

function getEnabledBoxesSorted() {
  return state.boxes
    .filter((box) => Number(box.status) === 1)
    .sort((a, b) => String(a.boxCode).localeCompare(String(b.boxCode), "en", { numeric: true }));
}

function normalizeBoxCodeInput(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) return "";
  if (/^\d{1,4}$/.test(value)) {
    return `B-${value.padStart(4, "0")}`;
  }
  const prefixed = value.match(/^B-(\d{1,4})$/);
  if (prefixed) {
    return `B-${prefixed[1].padStart(4, "0")}`;
  }
  return value;
}

function resolveEnabledBoxCode(raw) {
  const normalized = normalizeBoxCodeInput(raw);
  if (!normalized) return "";
  const found = getEnabledBoxesSorted().find((box) => String(box.boxCode).toUpperCase() === normalized);
  return found?.boxCode || "";
}

function findEnabledBoxByCode(raw) {
  const normalized = normalizeBoxCodeInput(raw);
  if (!normalized) return null;
  return (
    getEnabledBoxesSorted().find((box) => String(box.boxCode).toUpperCase() === normalized) || null
  );
}

function getEnabledShelvesSorted() {
  return state.shelves
    .filter((shelf) => Number(shelf.status) === 1)
    .sort((a, b) => String(a.shelfCode).localeCompare(String(b.shelfCode), "en", { numeric: true }));
}

function normalizeShelfCodeInput(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) return "";
  if (/^\d{1,3}$/.test(value)) {
    return `S-${value.padStart(3, "0")}`;
  }
  const prefixed = value.match(/^S-(\d{1,3})$/);
  if (prefixed) {
    return `S-${prefixed[1].padStart(3, "0")}`;
  }
  return value;
}

function resolveEnabledShelfCode(raw, excludeShelfId = null) {
  const normalized = normalizeShelfCodeInput(raw);
  if (!normalized) return "";
  const found = getEnabledShelvesSorted().find((shelf) => {
    if (excludeShelfId && String(shelf.id) === String(excludeShelfId)) return false;
    return String(shelf.shelfCode).toUpperCase() === normalized;
  });
  return found?.shelfCode || "";
}

function renderMoveShelfBoxOptions(keyword = "") {
  const input = $("moveShelfBoxCode");
  const datalist = $("moveShelfBoxCodeList");
  if (!input || !datalist) return;

  const prev = input.value;
  const raw = String(keyword ?? "").trim().toUpperCase();
  const digits = raw.replace(/\D/g, "");
  const matches = getEnabledBoxesSorted().filter((box) => {
    if (!raw) return true;
    if (digits) return String(box.boxCode).replace(/\D/g, "").includes(digits);
    return String(box.boxCode).toUpperCase().includes(raw);
  });
  datalist.innerHTML = matches
    .map((box) => `<option value="${escapeHtml(box.boxCode)}"></option>`)
    .join("");
  if (prev) input.value = prev;
}

function renderMoveShelfTargetOptions(keyword = "") {
  const input = $("moveShelfTargetCode");
  const datalist = $("moveShelfTargetCodeList");
  const currentBox = findEnabledBoxByCode($("moveShelfBoxCode")?.value || "");
  if (!input || !datalist) return;

  const prev = input.value;
  const raw = String(keyword ?? "").trim().toUpperCase();
  const digits = raw.replace(/\D/g, "");
  const matches = getEnabledShelvesSorted().filter((shelf) => {
    if (currentBox && String(shelf.id) === String(currentBox.shelf?.id)) return false;
    if (!raw) return true;
    if (digits) return String(shelf.shelfCode).replace(/\D/g, "").includes(digits);
    return String(shelf.shelfCode).toUpperCase().includes(raw);
  });
  datalist.innerHTML = matches
    .map((shelf) => `<option value="${escapeHtml(shelf.shelfCode)}"></option>`)
    .join("");
  if (prev) input.value = prev;
}

function syncMoveShelfCurrentDisplay() {
  const currentInput = $("moveShelfCurrentCode");
  if (!currentInput) return;
  const box = findEnabledBoxByCode($("moveShelfBoxCode")?.value || "");
  currentInput.value = box?.shelf?.shelfCode || "";
}

function renderMoveProductNewBoxOptions(keyword = "") {
  const input = $("moveProductNewBoxCode");
  const datalist = $("moveProductNewBoxCodeList");
  if (!input || !datalist) return;

  const prev = input.value;
  const raw = String(keyword ?? "").trim().toUpperCase();
  const digits = raw.replace(/\D/g, "");
  const matches = getEnabledBoxesSorted().filter((box) => {
    if (!raw) return true;
    if (digits) return String(box.boxCode).replace(/\D/g, "").includes(digits);
    return String(box.boxCode).toUpperCase().includes(raw);
  });
  datalist.innerHTML = matches
    .map((box) => `<option value="${escapeHtml(box.boxCode)}"></option>`)
    .join("");
  if (prev) input.value = prev;
}

function syncMoveProductOldShelfDisplay() {
  const shelfInput = $("moveProductOldShelfCode");
  if (!shelfInput) return;
  const selectedBoxCode = resolveEnabledBoxCode($("moveProductOldBoxCode")?.value || "");
  const box = findEnabledBoxByCode(selectedBoxCode);
  shelfInput.value = box?.shelf?.shelfCode || "";
}

function syncMoveProductNewShelfDisplay() {
  const shelfInput = $("moveProductNewShelfCode");
  if (!shelfInput) return;
  const newBoxCode = resolveEnabledBoxCode($("moveProductNewBoxCode")?.value || "");
  const box = findEnabledBoxByCode(newBoxCode);
  shelfInput.value = box?.shelf?.shelfCode || "";
}

async function refreshMoveProductOldBoxOptionsBySku() {
  const skuId = Number($("moveProductSkuId")?.value || 0);
  const select = $("moveProductOldBoxCode");
  const hint = $("moveProductOldBoxHint");
  if (!select) return;

  if (!Number.isInteger(skuId) || skuId <= 0) {
    select.innerHTML = '<option value="">请先选择SKU</option>';
    if (hint) hint.classList.add("hidden");
    syncMoveProductOldShelfDisplay();
    return;
  }

  const rows = (await getSkuInventoryRows(skuId))
    .filter((row) => Number(row?.qty ?? 0) > 0 && row?.box?.boxCode)
    .sort((a, b) => String(a.box.boxCode).localeCompare(String(b.box.boxCode), "en", { numeric: true }));
  const hasMultiple = rows.length > 1;

  const prev = resolveEnabledBoxCode(select.value);
  const options = rows
    .map((row) => `<option value="${escapeHtml(row.box.boxCode)}">${escapeHtml(row.box.boxCode)}</option>`)
    .join("");
  if (rows.length === 1) {
    select.innerHTML = options;
  } else {
    select.innerHTML = `<option value="">请选择旧箱号</option>${options}`;
  }
  if (hint) {
    hint.classList.toggle("hidden", !hasMultiple);
  }

  if (rows.length === 1) {
    select.value = rows[0].box.boxCode;
  } else if (prev && rows.some((row) => String(row.box.boxCode) === String(prev))) {
    select.value = prev;
  } else {
    select.value = "";
  }

  syncMoveProductOldShelfDisplay();
}

function filterAdjustBoxes(keyword) {
  const boxes = getEnabledBoxesSorted();
  const raw = String(keyword ?? "").trim().toUpperCase();
  if (!raw) return boxes;

  const digits = raw.replace(/\D/g, "");
  if (digits) {
    return boxes.filter((box) => String(box.boxCode).replace(/\D/g, "").includes(digits));
  }

  return boxes.filter((box) => String(box.boxCode).toUpperCase().includes(raw));
}

async function loadProductEditRequests() {
  const rows = await request("/sku-edit-requests");
  state.skuEditRequests = Array.isArray(rows) ? rows : [];
  renderProductEditRequestTable();
}

async function loadProductEditRequestDetail(id) {
  return request(`/sku-edit-requests/${id}`);
}

async function confirmProductEditRequest(id) {
  return request(`/sku-edit-requests/${id}/confirm`, {
    method: "POST",
  });
}

async function deleteProductEditRequest(id) {
  return request(`/sku-edit-requests/${id}/delete`, {
    method: "POST",
  });
}

function renderAdjustBoxSuggestions(keyword = "") {
  const datalist = $("adjustBoxCodeList");
  if (!datalist) return;

  const matches = filterAdjustBoxes(keyword);
  datalist.innerHTML = matches
    .map((box) => `<option value="${escapeHtml(box.boxCode)}"></option>`)
    .join("");

  const hint = $("adjustBoxHint");
  if (!hint) return;

  const raw = String(keyword ?? "").trim();
  if (!raw) {
    hint.classList.add("hidden");
    return;
  }

  hint.classList.toggle("hidden", matches.length > 0);
}

async function loadBrands() {
  const brands = await request("/brands");
  state.brands = brands;
  const latestIds = new Set((Array.isArray(brands) ? brands : []).map((item) => String(item.id)));
  state.brandEditingIds = new Set(
    [...state.brandEditingIds].filter((id) => latestIds.has(String(id))),
  );
  renderBrandOptionsForSelect("modalNewBrand", "请选择品牌");
  renderBrandOptionsForSelect("editBrand", "请选择品牌");
  renderBrandsTable();
}

async function loadSkuTypes() {
  const skuTypes = await request("/sku-types");
  state.skuTypes = skuTypes;
  const latestIds = new Set((Array.isArray(skuTypes) ? skuTypes : []).map((item) => String(item.id)));
  state.skuTypeEditingIds = new Set(
    [...state.skuTypeEditingIds].filter((id) => latestIds.has(String(id))),
  );
  renderSkuTypeOptionsForSelect("modalNewType", "请选择类型");
  renderSkuTypeOptionsForSelect("editType", "请选择类型");
  renderSkuTypesTable();
}

async function loadShops() {
  const shops = await request("/shops");
  state.shops = shops;
  const latestIds = new Set((Array.isArray(shops) ? shops : []).map((item) => String(item.id)));
  state.shopEditingIds = new Set(
    [...state.shopEditingIds].filter((id) => latestIds.has(String(id))),
  );
  renderShopOptionsForSelect("modalNewShop", "请选择店铺");
  renderShopOptionsForSelect("editShop", "请选择店铺");
  renderShopsTable();
}

async function loadShelves() {
  const shelves = await request("/shelves");
  state.shelves = shelves;
  $("statShelves").textContent = shelves.length;

  renderShelfOptionsForSelect("newBoxShelfId", "请选择货架号");
  renderShelfOptionsForSelect("modalNewBoxShelfId", "请选择货架号");
  renderMoveShelfTargetOptions($("moveShelfTargetCode")?.value || "");

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
  state.boxes = boxes;
  $("statBoxes").textContent = boxes.length;
  renderBoxOptionsForInput("modalNewSkuBoxCode", "modalNewSkuBoxCodeList", "请选择已有箱号或者新增箱号");
  renderAdjustBoxSuggestions($("adjustBoxCode")?.value || "");
  renderMoveShelfBoxOptions($("moveShelfBoxCode")?.value || "");
  syncMoveShelfCurrentDisplay();
  renderMoveShelfTargetOptions($("moveShelfTargetCode")?.value || "");
  renderMoveProductNewBoxOptions($("moveProductNewBoxCode")?.value || "");
  syncMoveProductOldShelfDisplay();
  syncMoveProductNewShelfDisplay();
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

function getBatchInboundStatusText(status, order = null) {
  if (status === "waiting_upload") {
    if (order?.domesticOrderNo && !order?.seaOrderNo) {
      return "待发海运";
    }
    if (order?.uploadedFileName && !order?.domesticOrderNo) {
      return "待填国内单号";
    }
    return "等待上传批量入库文档";
  }
  if (status === "waiting_inbound") return "待入库";
  if (status === "confirmed") return "已确认";
  if (status === "void") return "已作废";
  return status || "-";
}

function getSeaOrderTrackUrl(seaOrderNo) {
  return `http://jp.uofexp.com/search_order.aspx?trackNumber=${encodeURIComponent(seaOrderNo)}`;
}

function formatBatchRange(order) {
  if (!order?.rangeStart || !order?.rangeEnd || !order?.expectedBoxCount) {
    return "-";
  }
  return `${order.rangeStart} ~ ${order.rangeEnd}（${order.expectedBoxCount}箱）`;
}

function renderBatchInboundUploadOptions() {
  const select = $("batchUploadOrderId");
  if (!select) return;
  const prev = select.value || state.selectedBatchInboundOrderId || "";
  const waitingUploadOrders = state.batchInboundOrders.filter(
    (order) =>
      order.status === "waiting_upload" &&
      !order.uploadedFileName &&
      !order.domesticOrderNo &&
      !order.seaOrderNo,
  );
  const options = waitingUploadOrders
    .map(
      (order) =>
        `<option value="${escapeHtml(order.id)}">${escapeHtml(order.orderNo)}</option>`,
    )
    .join("");
  select.innerHTML = `<option value="">请选择入库单</option>${options}`;
  if (waitingUploadOrders.some((order) => String(order.id) === String(prev))) {
    select.value = prev;
  }
}

function renderBatchInboundOrders() {
  const tbody = $("batchInboundBody");
  if (!tbody) return;
  if (!state.batchInboundOrders.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">-</td></tr>';
    return;
  }

  tbody.innerHTML = state.batchInboundOrders
    .map((order) => {
      const actions = [
        `<button class="tiny-btn ghost" data-action="batchInboundSelectOrder" data-order-id="${escapeHtml(
          order.id,
        )}">查看</button>`,
      ];
      if (order.status === "waiting_inbound") {
        actions.push(
          `<button class="tiny-btn" data-action="batchInboundOpenConfirm" data-order-id="${escapeHtml(
            order.id,
          )}">确认入库</button>`,
        );
      }
      if (order.status !== "confirmed" && !order.seaOrderNo) {
        actions.push(
          `<button class="tiny-btn danger" data-action="batchInboundDeleteOrder" data-order-id="${escapeHtml(
            order.id,
          )}" data-order-no="${escapeHtml(order.orderNo)}">删除</button>`,
        );
      }
      return `
        <tr>
          <td>${escapeHtml(order.orderNo)}</td>
          <td>${escapeHtml(getBatchInboundStatusText(order.status, order))}</td>
          <td>${escapeHtml(formatBatchRange(order))}</td>
          <td>
            <div class="batch-no-editor">
              <input
                id="domesticOrderNo-${escapeHtml(order.id)}"
                class="batch-no-input"
                value="${escapeHtml(order.domesticOrderNo || "")}"
                placeholder="请输入国内单号"
              />
              <button
                class="tiny-btn"
                data-action="batchInboundSaveDomesticOrderNo"
                data-order-id="${escapeHtml(order.id)}"
                data-input-id="domesticOrderNo-${escapeHtml(order.id)}"
              >保存</button>
            </div>
          </td>
          <td>
            <div class="batch-no-editor">
              <input
                id="seaOrderNo-${escapeHtml(order.id)}"
                class="batch-no-input"
                value="${escapeHtml(order.seaOrderNo || "")}"
                placeholder="请输入海运单号"
              />
              <button
                class="tiny-btn"
                data-action="batchInboundSaveSeaOrderNo"
                data-order-id="${escapeHtml(order.id)}"
                data-input-id="seaOrderNo-${escapeHtml(order.id)}"
              >保存</button>
            </div>
            ${
              order.seaOrderNo
                ? `<a class="batch-sea-link" href="${escapeHtml(
                    getSeaOrderTrackUrl(order.seaOrderNo),
                  )}" target="_blank" rel="noopener noreferrer">${escapeHtml(order.seaOrderNo)}</a>`
                : ""
            }
          </td>
          <td>${escapeHtml(order.confirmedCount ?? 0)} / ${escapeHtml(order.itemCount ?? 0)}</td>
          <td><div class="action-row">${actions.join("")}</div></td>
        </tr>
      `;
    })
    .join("");
}

function renderBatchInboundDetail(detail) {
  const container = $("batchInboundDetail");
  if (!container) return;
  if (!detail) {
    container.className = "batch-detail-empty muted";
    container.textContent = "请先选择批量入库单。";
    return;
  }

  const grouped = new Map();
  (detail.items || []).forEach((item) => {
    const key = item.boxCode;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  });

  const boxCodes = Array.from(grouped.keys()).sort((a, b) => {
    const numA = Number(String(a).replace(/\D/g, ""));
    const numB = Number(String(b).replace(/\D/g, ""));
    return numA - numB;
  });

  const canConfirm = detail.status === "waiting_inbound";
  const headerActions = canConfirm
    ? `<button class="tiny-btn" data-action="batchInboundConfirmAll" data-order-id="${escapeHtml(
        detail.id,
      )}">整单确认入库</button>`
    : "";

  const boxBlocks = boxCodes
    .map((boxCode) => {
      const items = grouped.get(boxCode) || [];
      const pendingCount = items.filter((item) => item.status === "pending").length;
      const boxAction =
        canConfirm && pendingCount > 0
          ? `<button class="tiny-btn" data-action="batchInboundConfirmBox" data-order-id="${escapeHtml(
              detail.id,
            )}" data-box-code="${escapeHtml(boxCode)}">确认整箱</button>`
          : `<span class="tag">${pendingCount > 0 ? "待确认" : "已确认"}</span>`;

      return `
        <article class="batch-box-card">
          <div class="batch-box-head">
            <h4 class="batch-box-title">箱号 ${escapeHtml(boxCode)}</h4>
            <div class="batch-detail-actions">${boxAction}</div>
          </div>
          <table class="batch-detail-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>数量</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${items
                .map((item) => {
                  const itemAction =
                    canConfirm && item.status === "pending"
                      ? `<button class="tiny-btn" data-action="batchInboundConfirmItem" data-order-id="${escapeHtml(
                          detail.id,
                        )}" data-item-id="${escapeHtml(item.id)}">确认SKU</button>`
                      : '<span class="muted">-</span>';
                  return `
                    <tr>
                      <td>${escapeHtml(item.skuCode)}</td>
                      <td>${escapeHtml(item.qty)}</td>
                      <td>${escapeHtml(item.status === "pending" ? "待确认" : "已确认")}</td>
                      <td>${itemAction}</td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </article>
      `;
    })
    .join("");

  container.className = "";
  container.innerHTML = `
    <div class="batch-detail-head">
      <div class="batch-detail-meta">
        <div>单号：${escapeHtml(detail.orderNo)}</div>
        <div>状态：${escapeHtml(getBatchInboundStatusText(detail.status, detail))}</div>
        <div>采集范围：${escapeHtml(formatBatchRange(detail))}</div>
        <div>明细进度：${escapeHtml(detail.confirmedCount ?? 0)} / ${escapeHtml(
          detail.itemCount ?? 0,
        )}</div>
      </div>
      <div class="batch-detail-actions">${headerActions}</div>
    </div>
    ${boxBlocks || '<div class="muted">暂无明细</div>'}
  `;
}

async function loadBatchInboundOrders({ keepSelection = true } = {}) {
  const orders = await request("/batch-inbound/orders");
  state.batchInboundOrders = Array.isArray(orders) ? orders : [];
  $("statInboundDraft").textContent = state.batchInboundOrders.filter(
    (order) => order.status === "waiting_upload" || order.status === "waiting_inbound",
  ).length;
  renderBatchInboundOrders();
  renderBatchInboundUploadOptions();

  if (!keepSelection) {
    state.selectedBatchInboundOrderId = "";
    state.selectedBatchInboundOrderDetail = null;
    renderBatchInboundDetail(null);
    return;
  }

  if (!state.selectedBatchInboundOrderId) {
    renderBatchInboundDetail(null);
    return;
  }

  const exists = state.batchInboundOrders.some(
    (order) => String(order.id) === String(state.selectedBatchInboundOrderId),
  );
  if (!exists) {
    state.selectedBatchInboundOrderId = "";
    state.selectedBatchInboundOrderDetail = null;
    renderBatchInboundDetail(null);
    return;
  }

  await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId, { silent: true });
}

async function loadBatchInboundOrderDetail(orderId, { silent = false } = {}) {
  const detail = await request(`/batch-inbound/orders/${orderId}`);
  state.selectedBatchInboundOrderId = String(orderId);
  state.selectedBatchInboundOrderDetail = detail;
  renderBatchInboundDetail(detail);
  if (!silent) {
    $("batchUploadOrderId").value = String(orderId);
  }
}

async function submitCollectBatchInboundForm() {
  const batchNoRaw = String($("batchCollectBatchNo").value || "").trim();
  const boxCount = Number($("batchCollectBoxCount").value);
  if (!batchNoRaw) {
    throw new Error("批号不能为空");
  }
  if (!/^[1-9]\d*$/.test(batchNoRaw)) {
    throw new Error("批号只能输入大于0的数字");
  }
  if (!Number.isInteger(boxCount) || boxCount <= 0) {
    throw new Error("采集箱数必须是大于0的整数");
  }

  const created = await request("/batch-inbound/orders/collect", {
    method: "POST",
    body: JSON.stringify({
      batchNo: batchNoRaw,
      boxCount,
    }),
  });

  const hint = $("batchCollectHint");
  if (hint && created) {
    hint.textContent = `请使用从数字 ${created.rangeStart} ~ ${created.rangeEnd} 的 ${created.expectedBoxCount} 个箱号。`;
  }
  state.selectedBatchInboundOrderId = String(created.id);
}

async function submitUploadBatchInboundForm() {
  const orderId = $("batchUploadOrderId").value;
  const file = $("batchInboundFile").files?.[0];
  if (!orderId) {
    throw new Error("请先选择批量入库单");
  }
  if (!file) {
    throw new Error("请上传批量入库文档");
  }

  const formData = new FormData();
  formData.append("file", file);
  await request(`/batch-inbound/orders/${orderId}/upload`, {
    method: "POST",
    body: formData,
  });

  $("batchInboundFile").value = "";
  state.selectedBatchInboundOrderId = String(orderId);
}

async function saveBatchInboundDomesticOrderNo(orderId, domesticOrderNo) {
  return request(`/batch-inbound/orders/${orderId}/domestic-order-no`, {
    method: "POST",
    body: JSON.stringify({ domesticOrderNo }),
  });
}

async function saveBatchInboundSeaOrderNo(orderId, seaOrderNo) {
  return request(`/batch-inbound/orders/${orderId}/sea-order-no`, {
    method: "POST",
    body: JSON.stringify({ seaOrderNo }),
  });
}

async function confirmBatchInboundAction(action, orderId, payload = {}) {
  if (!orderId) {
    throw new Error("缺少批量入库单ID");
  }
  let path = `/batch-inbound/orders/${orderId}/confirm-all`;
  if (action === "item") {
    path = `/batch-inbound/orders/${orderId}/items/${payload.itemId}/confirm`;
  } else if (action === "box") {
    path = `/batch-inbound/orders/${orderId}/boxes/${encodeURIComponent(payload.boxCode)}/confirm`;
  }
  await request(path, {
    method: "POST",
    body: "{}",
  });
}

async function deleteBatchInboundOrder(orderId) {
  await request(`/batch-inbound/orders/${orderId}`, {
    method: "DELETE",
  });
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

async function loadMyAudit() {
  if (!state.me?.id) {
    $("myAuditBody").innerHTML = "";
    return;
  }
  const result = await request(`/audit-logs?page=1&pageSize=20&operatorId=${state.me.id}`);
  const items = result.items || [];
  $("myAuditBody").innerHTML = items
    .map(
      (item) => `
      <tr>
        <td>${formatDate(item.createdAt)}</td>
        <td>${formatAuditEntity(item)}</td>
        <td>${escapeHtml(item.action)}</td>
        <td>${escapeHtml(item.eventType)}</td>
        <td>${escapeHtml(item.requestId)}</td>
      </tr>
    `,
    )
    .join("");
}

function renderFbaPendingBadge() {
  const badge = $("fbaPendingBadge");
  if (!badge) return;
  const count = Number(state.fbaPendingCount || 0);
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count <= 0);
}

async function loadFbaPendingSummary() {
  if (!state.token) {
    state.fbaPendingCount = 0;
    state.fbaPendingBySku = {};
    state.fbaPendingByBoxSku = {};
    renderFbaPendingBadge();
    return;
  }

  const summary = await request("/inventory/fba-replenishments/pending-summary");
  state.fbaPendingCount = Number(summary?.pendingConfirmCount || 0);
  state.fbaPendingBySku = summary?.pendingBySku || {};
  state.fbaPendingByBoxSku = summary?.pendingByBoxSku || {};
  renderFbaPendingBadge();
}

function renderProductEditPendingBadge() {
  const badge = $("productEditPendingBadge");
  if (!badge) return;
  const count = Number(state.productEditPendingCount || 0);
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count <= 0);
}

async function loadProductEditPendingSummary() {
  if (!state.token) {
    state.productEditPendingCount = 0;
    renderProductEditPendingBadge();
    return;
  }

  const summary = await request("/sku-edit-requests/pending-summary");
  state.productEditPendingCount = Number(summary?.pendingCount || 0);
  renderProductEditPendingBadge();
}

function renderFbaReplenishmentList() {
  const tbody = $("fbaReplenishmentBody");
  if (!tbody) return;
  syncSelectedFbaIds();

  if (!state.fbaReplenishments.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="muted">-</td></tr>';
    updateFbaSelectAll();
    updateFbaOutboundButtonState();
    return;
  }

  tbody.innerHTML = state.fbaReplenishments
    .map(
      (item) => `
      <tr>
        <td>
          ${
            item.status === "pending_outbound"
              ? `<input type="checkbox" data-action="fbaToggleRow" data-id="${escapeHtml(item.id)}" ${
                  state.selectedFbaIds.has(String(item.id)) ? "checked" : ""
                } />`
              : "-"
          }
        </td>
        <td>${escapeHtml(item.requestNo)}</td>
        <td>${escapeHtml(getFbaStatusText(item.status))}</td>
        <td>${escapeHtml(displayText(item.sku?.sku))}</td>
        <td>${escapeHtml(displayText(item.sku?.model))}</td>
        <td>${escapeHtml(displayText(item.sku?.brand))}</td>
        <td>${escapeHtml(displayText(item.box?.boxCode))}</td>
        <td>${escapeHtml(displayText(item.box?.shelfCode))}</td>
        <td>${escapeHtml(displayText(item.requestedQty))}</td>
        <td>
          ${
            item.status === "pending_confirm"
              ? `<input id="fbaActualQty-${escapeHtml(item.id)}" class="tiny-input" type="number" min="1" step="1" value="${escapeHtml(item.actualQty ?? item.requestedQty)}" />`
              : escapeHtml(displayText(item.actualQty ?? item.requestedQty))
          }
        </td>
        <td>
          <div class="action-row">
            ${
              item.status === "pending_confirm"
                ? `<button class="tiny-btn" data-action="fbaConfirmRow" data-id="${escapeHtml(item.id)}" data-input-id="fbaActualQty-${escapeHtml(item.id)}">确认</button>`
                : ""
            }
            ${
              item.status === "pending_outbound"
                ? `<button class="tiny-btn" data-action="fbaReopenRow" data-id="${escapeHtml(item.id)}">变更</button>`
                : ""
            }
            ${
              item.status === "pending_confirm"
                ? `<button class="tiny-btn danger" data-action="fbaDeleteRow" data-id="${escapeHtml(item.id)}" data-request-no="${escapeHtml(item.requestNo)}">删除</button>`
                : ""
            }
            ${item.status === "deleted" ? '<span class="muted">-</span>' : ""}
          </div>
        </td>
      </tr>
    `,
    )
    .join("");

  updateFbaSelectAll();
  updateFbaOutboundButtonState();
}

async function loadFbaReplenishments() {
  if (!state.token) {
    state.fbaReplenishments = [];
    state.selectedFbaIds = new Set();
    renderFbaReplenishmentList();
    return;
  }

  const list = await request("/inventory/fba-replenishments");
  state.fbaReplenishments = Array.isArray(list) ? list : [];
  renderFbaReplenishmentList();
}

async function createFbaReplenishmentRequest({ skuId, boxCode, qty, remark }) {
  return request("/inventory/fba-replenishments", {
    method: "POST",
    body: JSON.stringify({
      skuId,
      boxCode,
      qty,
      remark,
    }),
  });
}

async function confirmFbaReplenishmentRequest(id, actualQty) {
  return request(`/inventory/fba-replenishments/${id}/confirm`, {
    method: "POST",
    body: JSON.stringify({ actualQty }),
  });
}

async function outboundFbaReplenishmentRequests(ids, expressNo) {
  return request("/inventory/fba-replenishments/outbound", {
    method: "POST",
    body: JSON.stringify({ ids, expressNo }),
  });
}

async function deleteFbaReplenishmentRequest(id) {
  return request(`/inventory/fba-replenishments/${id}/delete`, {
    method: "POST",
  });
}

async function reopenFbaReplenishmentRequest(id) {
  return request(`/inventory/fba-replenishments/${id}/reopen`, {
    method: "POST",
  });
}

function syncSelectedFbaIds() {
  const selectableIds = new Set(
    state.fbaReplenishments
      .filter((item) => item.status === "pending_outbound")
      .map((item) => String(item.id)),
  );
  state.selectedFbaIds = new Set(
    Array.from(state.selectedFbaIds).filter((id) => selectableIds.has(String(id))),
  );
}

function updateFbaSelectAll() {
  const selectAll = $("fbaSelectAll");
  if (!selectAll) return;
  const selectable = state.fbaReplenishments.filter((item) => item.status === "pending_outbound");
  if (!selectable.length) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }

  const selectedCount = selectable.filter((item) => state.selectedFbaIds.has(String(item.id))).length;
  selectAll.checked = selectedCount > 0 && selectedCount === selectable.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
}

function updateFbaOutboundButtonState() {
  const button = $("fbaBatchOutboundBtn");
  if (!button) return;
  const count = state.selectedFbaIds.size;
  button.disabled = count <= 0;
  button.textContent = count > 0 ? `出库（${count}）` : "出库";
}

function openFbaOutboundModal() {
  if (!state.selectedFbaIds.size) {
    throw new Error("请先选择待出库申请单");
  }
  $("fbaOutboundExpressNo").value = "";
  openModal("fbaOutboundModal");
}

function openAdjustModal(direction, skuId, presetBoxCode = "", maxQty = null) {
  const normalizedPresetBoxCode = normalizeBoxCodeInput(presetBoxCode);
  $("adjustSkuId").value = String(skuId);
  $("adjustDirection").value = direction;
  const lockBox = Boolean(normalizedPresetBoxCode);
  const boxInput = $("adjustBoxCode");
  const addBoxBtn = $("openCreateBoxFromAdjust");
  const boxHint = $("adjustBoxHint");
  boxInput.value = normalizedPresetBoxCode;
  if (lockBox) {
    boxInput.readOnly = true;
    boxInput.removeAttribute("list");
    addBoxBtn.classList.add("hidden");
    if (boxHint) boxHint.classList.add("hidden");
  } else {
    boxInput.readOnly = false;
    boxInput.setAttribute("list", "adjustBoxCodeList");
    addBoxBtn.classList.remove("hidden");
    renderAdjustBoxSuggestions(normalizedPresetBoxCode);
  }
  const qtyInput = $("adjustQty");
  qtyInput.min = "1";
  qtyInput.step = "1";
  qtyInput.value = "1";
  const normalizedMaxQty = Number(maxQty);
  if (direction === "outbound" && Number.isInteger(normalizedMaxQty) && normalizedMaxQty > 0) {
    qtyInput.dataset.maxQty = String(normalizedMaxQty);
  } else {
    qtyInput.dataset.maxQty = "";
  }
  $("adjustReason").value = direction === "inbound" ? "退货入库" : "FBA补货";
  $("adjustModalTitle").textContent = direction === "inbound" ? "库存入库" : "FBA补货";
  $("adjustSubmitBtn").textContent = direction === "inbound" ? "确认入库" : "生成FBA补货申请单";
  openModal("adjustModal");
}

async function quickOutboundOne(skuId, boxCode) {
  const normalizedBoxCode = normalizeBoxCodeInput(boxCode);
  if (!Number.isInteger(Number(skuId)) || Number(skuId) <= 0) {
    throw new Error("请选择产品");
  }
  if (!normalizedBoxCode) {
    throw new Error("请选择箱号");
  }

  await loadFbaPendingSummary();
  const rows = await getSkuInventoryRows(skuId);
  const matched = rows.find(
    (row) => String(row?.box?.boxCode || "").toUpperCase() === normalizedBoxCode,
  );
  const currentQty = Math.max(0, Number(matched?.qty ?? 0));
  const boxId = Number(matched?.box?.id ?? 0);
  const pendingQty = boxId > 0 ? getFbaPendingQtyByBoxSku(boxId, skuId) : 0;
  if (currentQty <= pendingQty) {
    throw new Error("数量不足，请对FBA出货单进行修改");
  }

  await request("/inventory/manual-adjust", {
    method: "POST",
    body: JSON.stringify({
      skuId: Number(skuId),
      boxCode: normalizedBoxCode,
      qtyDelta: -1,
      reason: "快速出库1件",
    }),
  });
}

async function submitAdjustForm() {
  const skuId = Number($("adjustSkuId").value);
  const direction = $("adjustDirection").value;
  const rawBoxCode = $("adjustBoxCode").value;
  const boxCode = normalizeBoxCodeInput(rawBoxCode);
  const qty = Math.abs(Number($("adjustQty").value));
  const reason = $("adjustReason").value.trim() || undefined;

  if (!Number.isInteger(skuId) || skuId <= 0) {
    throw new Error("请选择产品");
  }
  if (!boxCode) {
    throw new Error("请选择箱号");
  }
  $("adjustBoxCode").value = boxCode;
  if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
    throw new Error("数量必须为正整数");
  }
  if (direction === "outbound") {
    const latestQty = await getCurrentBoxSkuQty(skuId, boxCode);
    $("adjustQty").dataset.maxQty = String(latestQty);

    if (latestQty <= 0) {
      throw new Error("\u5f53\u524d\u7bb1\u53f7\u8be5SKU\u53ef\u7528\u5e93\u5b58\u4e3a0\uff0c\u4e0d\u80fd\u751f\u6210FBA\u8865\u8d27\u7533\u8bf7\u5355");
    }
    if (qty > latestQty) {
      throw new Error(`FBA\u8865\u8d27\u6570\u91cf\u4e0d\u80fd\u5927\u4e8e\u5f53\u524d\u7bb1\u53f7\u8be5SKU\u53ef\u7528\u6570\u91cf\uff08${latestQty}\uff09`);
    }
  }
  if (reason && reason.length > 10) {
    throw new Error("备注最多 10 个字");
  }

  if (direction === "outbound") {
    await createFbaReplenishmentRequest({
      skuId,
      boxCode,
      qty,
      remark: reason || "FBA补货",
    });
    return;
  }

  await request("/inventory/manual-adjust", {
    method: "POST",
    body: JSON.stringify({
      skuId,
      boxCode,
      qtyDelta: qty,
      reason,
    }),
  });
}

async function createSkuFromModal() {
  const model = $("modalNewModel").value.trim() || undefined;
  const brand = $("modalNewBrand").value.trim() || undefined;
  const type = $("modalNewType").value.trim() || undefined;
  const color = $("modalNewColor").value.trim() || undefined;
  const shop = $("modalNewShop").value.trim() || undefined;
  const remark = $("modalNewRemark").value.trim() || undefined;
  const sku = $("modalNewSku").value.trim();
  const erpSku = $("modalNewErpSku").value.trim() || undefined;
  const asin = $("modalNewAsin").value.trim() || undefined;
  const fnsku = $("modalNewFnsku").value.trim() || undefined;
  const rawBoxCode = $("modalNewSkuBoxCode").value;
  const boxCode = resolveEnabledBoxCode(rawBoxCode);
  const qty = Math.abs(Number($("modalNewSkuQty").value));
  const reason = "新建产品初始入库";

  if (!sku) throw new Error("SKU 不能为空");
  if (!boxCode) throw new Error("箱号不存在，请选择已有箱号或者先新增箱号");
  $("modalNewSkuBoxCode").value = boxCode;
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("数量必须大于 0");

  const possibleDuplicate = await request(`/skus?q=${encodeURIComponent(sku)}`);
  if (possibleDuplicate.some((item) => item.sku === sku)) {
    throw new Error("SKU 已存在");
  }

  const createdSku = await request("/skus", {
    method: "POST",
    body: JSON.stringify({ model, brand, type, color, shop, remark, sku, erpSku, asin, fnsku }),
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

async function createBoxFromSkuModal() {
  const boxCode = buildBoxCode($("modalNewBoxCodeDigits").value);
  const shelfId = Number($("modalNewBoxShelfId").value);

  if (!Number.isInteger(shelfId) || shelfId <= 0) throw new Error("请选择货架号");

  await request("/boxes", {
    method: "POST",
    body: JSON.stringify({ boxCode, shelfId }),
  });
  return boxCode;
}

async function createShelfFromInventoryModal() {
  const shelfCode = buildShelfCode($("modalNewShelfCodeDigits").value);
  const name = $("modalNewShelfName").value.trim() || undefined;

  await request("/shelves", {
    method: "POST",
    body: JSON.stringify({ shelfCode, name }),
  });
}

async function submitMoveBoxShelfForm() {
  const sourceBox = findEnabledBoxByCode($("moveShelfBoxCode").value);
  const sourceBoxId = Number(sourceBox?.id || 0);
  if (!Number.isInteger(sourceBoxId) || sourceBoxId <= 0) {
    throw new Error("请选择箱号");
  }

  const targetShelfCode = resolveEnabledShelfCode(
    $("moveShelfTargetCode").value,
    sourceBox?.shelf?.id ?? null,
  );
  if (!targetShelfCode) {
    throw new Error("请选择目标货架号");
  }
  $("moveShelfTargetCode").value = targetShelfCode;
  const targetShelf = getEnabledShelvesSorted().find(
    (item) => String(item.shelfCode).toUpperCase() === String(targetShelfCode).toUpperCase(),
  );
  const targetShelfId = Number(targetShelf?.id || 0);
  if (!Number.isInteger(targetShelfId) || targetShelfId <= 0) {
    throw new Error("请选择目标货架号");
  }
  if (String(targetShelfId) === String(sourceBox?.shelf?.id)) {
    throw new Error("新货架号不能与旧货架号相同");
  }

  await request(`/boxes/${sourceBoxId}`, {
    method: "PUT",
    body: JSON.stringify({ shelfId: targetShelfId }),
  });
}

async function submitMoveBoxCodeForm() {
  const skuId = Number($("moveProductSkuId").value);
  if (!Number.isInteger(skuId) || skuId <= 0) {
    throw new Error("请选择SKU");
  }

  const rows = (await getSkuInventoryRows(skuId)).filter(
    (row) => Number(row?.qty ?? 0) > 0 && row?.box?.boxCode,
  );
  if (!rows.length) {
    throw new Error("该SKU当前没有可移动库存");
  }

  const oldBoxCode = resolveEnabledBoxCode($("moveProductOldBoxCode").value);
  if (!oldBoxCode) {
    throw new Error("请选择旧箱号");
  }
  const oldRow = rows.find(
    (row) => String(row.box.boxCode).toUpperCase() === String(oldBoxCode).toUpperCase(),
  );
  if (!oldRow) {
    if (rows.length > 1) {
      throw new Error("该SKU存在多个箱号，请手动指定旧箱号");
    }
    throw new Error("旧箱号与SKU不匹配");
  }

  const newBoxCode = resolveEnabledBoxCode($("moveProductNewBoxCode").value);
  if (!newBoxCode) {
    throw new Error("请选择新箱号");
  }
  if (String(newBoxCode).toUpperCase() === String(oldRow.box.boxCode).toUpperCase()) {
    throw new Error("新箱号不能与旧箱号相同");
  }

  const qty = Number(oldRow.qty ?? 0);
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("旧箱号下该SKU库存不足");
  }

  await request("/inventory/manual-adjust", {
    method: "POST",
    body: JSON.stringify({
      skuId,
      boxCode: oldRow.box.boxCode,
      qtyDelta: -qty,
      reason: "移动产品到新箱子-转出",
    }),
  });

  await request("/inventory/manual-adjust", {
    method: "POST",
    body: JSON.stringify({
      skuId,
      boxCode: newBoxCode,
      qtyDelta: qty,
      reason: "移动产品到新箱子-转入",
    }),
  });

  return {
    qty,
    oldBoxCode: oldRow.box.boxCode,
    newBoxCode,
  };
}

async function initOverseasWarehousePage() {
  await Promise.all([loadShelves(), loadBoxes(), loadInventory()]);
  $("moveBoxShelfForm")?.reset();
  $("moveShelfCurrentCode").value = "";
  $("moveShelfTargetCode").value = "";
  renderMoveShelfBoxOptions("");
  renderMoveShelfTargetOptions("");
  syncMoveShelfCurrentDisplay();

  $("moveBoxCodeForm")?.reset();
  $("moveProductOldBoxCode").innerHTML = '<option value="">请先选择SKU</option>';
  $("moveProductOldShelfCode").value = "";
  $("moveProductNewShelfCode").value = "";
  const hint = $("moveProductOldBoxHint");
  if (hint) hint.classList.add("hidden");
  renderMoveProductNewBoxOptions("");
}

async function reloadAll() {
  await loadMe();
  if (!state.token) {
    clearStats();
    $("usersBody").innerHTML = "";
    $("auditBody").innerHTML = "";
    $("inventoryBody").innerHTML = "";
    $("batchInboundBody").innerHTML = "";
    $("fbaReplenishmentBody").innerHTML = "";
    renderBatchInboundDetail(null);
    $("inventorySearchResults").textContent = "-";
    $("brandsBody").innerHTML = "";
    $("skuTypesBody").innerHTML = "";
    $("shopsBody").innerHTML = "";
    $("productEditRequestBody").innerHTML = "";
    renderProductEditRequestDetail(null);
    state.brands = [];
    state.skuTypes = [];
    state.shops = [];
    state.skuEditRequests = [];
    state.fbaPendingCount = 0;
    state.productEditPendingCount = 0;
    state.fbaPendingBySku = {};
    state.fbaPendingByBoxSku = {};
    state.selectedFbaIds = new Set();
    state.selectedProductEditRequestId = null;
    state.brandEditingIds = new Set();
    state.skuTypeEditingIds = new Set();
    state.shopEditingIds = new Set();
    renderFbaPendingBadge();
    renderProductEditPendingBadge();
    updateFbaSelectAll();
    updateFbaOutboundButtonState();
    setInventoryDisplayMode(false);
    return;
  }

  const isAdmin = state.me?.role === "admin";
  const tasks = [
    loadInventory(),
    loadBrands(),
    loadSkuTypes(),
    loadShops(),
    loadProductEditRequests(),
    loadProductEditPendingSummary(),
    loadShelves(),
    loadBoxes(),
    loadBatchInboundOrders(),
    loadFbaReplenishments(),
  ];
  if (isAdmin) {
    tasks.push(loadUsers(), loadAudit());
  } else {
    $("usersBody").innerHTML = "";
    $("auditBody").innerHTML = "";
    $("statUsers").textContent = "-";
  }

  const results = await Promise.allSettled(tasks);
  const firstError = results.find((item) => item.status === "rejected");
  if (firstError && firstError.status === "rejected") {
    throw firstError.reason;
  }
  setInventoryDisplayMode(false);
  focusInventorySearch();
}

function bindForms() {
  $("loginGateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await request("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: $("gateUsername").value.trim(),
          password: $("gatePassword").value,
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

  const handleLogout = async () => {
    state.token = "";
    state.me = null;
    localStorage.removeItem("wms_token");
    document.querySelectorAll(".modal").forEach((modal) => modal.classList.add("hidden"));
    showToast("已退出登录");
    await reloadAll();
    switchPanel("overview");
  };

  $("logoutBtn").addEventListener("click", handleLogout);
  $("topLogoutBtn").addEventListener("click", handleLogout);

  $("createUserForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const username = $("newUsername").value.trim();
      const password = $("newPassword").value;
      await request("/users", {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          role: $("newRole").value,
        }),
      });
      state.plainPasswords[username] = password;
      localStorage.setItem("wms_plain_password_map", JSON.stringify(state.plainPasswords));
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
      const shelfCode = buildShelfCode($("newShelfCodeDigits").value);
      await request("/shelves", {
        method: "POST",
        body: JSON.stringify({
          shelfCode,
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
      const boxCode = buildBoxCode($("newBoxCodeDigits").value);
      const shelfId = Number($("newBoxShelfId").value);
      if (!Number.isInteger(shelfId) || shelfId <= 0) {
        throw new Error("请选择货架号");
      }

      await request("/boxes", {
        method: "POST",
        body: JSON.stringify({
          boxCode,
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

  $("collectBatchInboundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await submitCollectBatchInboundForm();
      showToast("箱号采集完成，已创建批量入库单");
      await loadBatchInboundOrders();
      if (state.selectedBatchInboundOrderId) {
        await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("uploadBatchInboundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await submitUploadBatchInboundForm();
      showToast("文档上传成功");
      await loadBatchInboundOrders();
      if (state.selectedBatchInboundOrderId) {
        await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId);
      }
      await loadInventory();
      await loadBoxes();
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

  $("openBatchInboundModal").addEventListener("click", async () => {
    try {
      switchPanel("batchInbound");
      await loadBatchInboundOrders();
      if (state.selectedBatchInboundOrderId) {
        await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId, { silent: true });
      } else {
        renderBatchInboundDetail(null);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openFbaReplenishmentPanel").addEventListener("click", async () => {
    try {
      switchPanel("fbaReplenishment");
      await loadFbaReplenishments();
      await loadFbaPendingSummary();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("fbaBatchOutboundBtn").addEventListener("click", () => {
    try {
      openFbaOutboundModal();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("fbaSelectAll").addEventListener("change", (event) => {
    const checked = Boolean(event.target.checked);
    const selectableIds = state.fbaReplenishments
      .filter((item) => item.status === "pending_outbound")
      .map((item) => String(item.id));
    state.selectedFbaIds = checked ? new Set(selectableIds) : new Set();
    renderFbaReplenishmentList();
  });

  $("fbaOutboundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const expressNo = String($("fbaOutboundExpressNo").value || "").trim();
      if (!expressNo) {
        throw new Error("请输入快递号");
      }
      const ids = Array.from(state.selectedFbaIds)
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0);
      if (!ids.length) {
        throw new Error("请先选择待出库申请单");
      }

      await outboundFbaReplenishmentRequests(ids, expressNo);
      closeModal("fbaOutboundModal");
      state.selectedFbaIds = new Set();
      showToast("出库完成");
      await loadFbaReplenishments();
      await loadFbaPendingSummary();
      await loadInventory();
      await loadBoxes();

      const keyword = $("inventoryKeyword").value.trim();
      if (state.inventorySearchMode && keyword) {
        await searchInventoryProducts(keyword);
      }
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openInventoryHome").addEventListener("click", () => {
    switchPanel("inventory");
    focusInventorySearch();
  });

  $("openOverseasWarehousePanel").addEventListener("click", async () => {
    try {
      switchPanel("overseasWarehouse");
      await Promise.all([loadShelves(), loadBoxes(), loadInventory()]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openProductManagementPanel").addEventListener("click", async () => {
    try {
      switchPanel("productManagement");
      await Promise.all([
        loadShelves(),
        loadBoxes(),
        loadInventory(),
        loadBrands(),
        loadSkuTypes(),
        loadShops(),
        loadProductEditRequests(),
        loadProductEditPendingSummary(),
      ]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openBrandManageModal").addEventListener("click", async () => {
    try {
      state.brandEditingIds = new Set();
      await loadBrands();
      openModal("brandManageModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openSkuTypeManageModal").addEventListener("click", async () => {
    try {
      state.skuTypeEditingIds = new Set();
      await loadSkuTypes();
      openModal("skuTypeManageModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openShopManageModal").addEventListener("click", async () => {
    try {
      state.shopEditingIds = new Set();
      await loadShops();
      openModal("shopManageModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openCreateSkuModal").addEventListener("click", async () => {
    await Promise.all([loadShelves(), loadBoxes(), loadBrands(), loadSkuTypes(), loadShops()]).catch((error) =>
      showToast(error.message, true),
    );
    $("createSkuModalForm").reset();
    renderBrandOptionsForSelect("modalNewBrand", "请选择品牌");
    renderSkuTypeOptionsForSelect("modalNewType", "请选择类型");
    renderShopOptionsForSelect("modalNewShop", "请选择店铺");
    $("modalNewSkuQty").value = "1";
    openModal("createSkuModal");
  });

  const openCreateBoxModal = async () => {
    if (!state.shelves.length) {
      await loadShelves().catch((error) => showToast(error.message, true));
    }
    $("createBoxFromSkuForm").reset();
    openModal("createBoxFromSkuModal");
  };

  $("openCreateBoxFromSkuModal").addEventListener("click", openCreateBoxModal);
  $("openCreateBoxQuick").addEventListener("click", openCreateBoxModal);
  $("openCreateBoxFromAdjust").addEventListener("click", openCreateBoxModal);
  $("modalNewSkuBoxCode").addEventListener("input", (event) => {
    renderBoxOptionsForInput(
      "modalNewSkuBoxCode",
      "modalNewSkuBoxCodeList",
      "请选择已有箱号或者新增箱号",
      event.target.value,
    );
  });
  $("modalNewSkuBoxCode").addEventListener("focus", (event) => {
    renderBoxOptionsForInput(
      "modalNewSkuBoxCode",
      "modalNewSkuBoxCodeList",
      "请选择已有箱号或者新增箱号",
      event.target.value,
    );
  });
  $("modalNewSkuBoxCode").addEventListener("blur", (event) => {
    const resolved = resolveEnabledBoxCode(event.target.value);
    if (resolved) {
      event.target.value = resolved;
    }
  });
  $("moveShelfBoxCode").addEventListener("input", (event) => {
    renderMoveShelfBoxOptions(event.target.value);
    syncMoveShelfCurrentDisplay();
    $("moveShelfTargetCode").value = "";
    renderMoveShelfTargetOptions("");
  });
  $("moveShelfBoxCode").addEventListener("focus", (event) => {
    renderMoveShelfBoxOptions(event.target.value);
  });
  $("moveShelfBoxCode").addEventListener("blur", (event) => {
    const resolved = resolveEnabledBoxCode(event.target.value);
    if (resolved) {
      event.target.value = resolved;
    }
    syncMoveShelfCurrentDisplay();
    renderMoveShelfTargetOptions($("moveShelfTargetCode").value || "");
  });
  $("moveShelfTargetCode").addEventListener("input", (event) => {
    renderMoveShelfTargetOptions(event.target.value);
  });
  $("moveShelfTargetCode").addEventListener("focus", (event) => {
    renderMoveShelfTargetOptions(event.target.value);
  });
  $("moveShelfTargetCode").addEventListener("blur", (event) => {
    const currentBox = findEnabledBoxByCode($("moveShelfBoxCode")?.value || "");
    const resolved = resolveEnabledShelfCode(event.target.value, currentBox?.shelf?.id ?? null);
    if (resolved) {
      event.target.value = resolved;
    }
  });
  $("moveProductSkuId").addEventListener("change", async () => {
    try {
      await refreshMoveProductOldBoxOptionsBySku();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("moveProductOldBoxCode").addEventListener("change", () => {
    syncMoveProductOldShelfDisplay();
  });
  $("moveProductNewBoxCode").addEventListener("input", (event) => {
    renderMoveProductNewBoxOptions(event.target.value);
    syncMoveProductNewShelfDisplay();
  });
  $("moveProductNewBoxCode").addEventListener("focus", (event) => {
    renderMoveProductNewBoxOptions(event.target.value);
  });
  $("moveProductNewBoxCode").addEventListener("blur", (event) => {
    const resolved = resolveEnabledBoxCode(event.target.value);
    if (resolved) {
      event.target.value = resolved;
    }
    syncMoveProductNewShelfDisplay();
  });
  $("adjustBoxCode").addEventListener("input", (event) => {
    renderAdjustBoxSuggestions(event.target.value);
  });
  $("adjustBoxCode").addEventListener("focus", (event) => {
    renderAdjustBoxSuggestions(event.target.value);
  });
  $("adjustQty").addEventListener("input", (event) => {
    const input = event.target;
    let digits = String(input.value || "").replace(/\D/g, "").replace(/^0+/, "");
    if (!digits) {
      input.value = "";
      return;
    }

    let value = Number(digits);
    if (!Number.isInteger(value) || value <= 0) {
      input.value = "";
      return;
    }

    input.value = String(value);
  });
  $("adjustQty").addEventListener("blur", (event) => {
    const input = event.target;
    if (!String(input.value || "").trim()) {
      input.value = "1";
    }
  });

  $("openCreateShelfQuick").addEventListener("click", () => {
    $("createShelfFromInventoryForm").reset();
    openModal("createShelfFromInventoryModal");
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

  $("createBoxFromSkuForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const createdBoxCode = await createBoxFromSkuModal();
      closeModal("createBoxFromSkuModal");
      showToast("箱号已创建");
      await loadShelves();
      await loadBoxes();
      const createSkuModal = $("createSkuModal");
      if (createSkuModal && !createSkuModal.classList.contains("hidden")) {
        $("modalNewSkuBoxCode").value = createdBoxCode;
        renderBoxOptionsForInput(
          "modalNewSkuBoxCode",
          "modalNewSkuBoxCodeList",
          "请选择已有箱号或者新增箱号",
          createdBoxCode,
        );
      }
      const adjustModal = $("adjustModal");
      if (adjustModal && !adjustModal.classList.contains("hidden")) {
        $("adjustBoxCode").value = createdBoxCode;
        renderAdjustBoxSuggestions(createdBoxCode);
      }
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createShelfFromInventoryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await createShelfFromInventoryModal();
      closeModal("createShelfFromInventoryModal");
      showToast("货架已创建");
      await loadShelves();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openMyAuditLog").addEventListener("click", async () => {
    try {
      await loadMyAudit();
      openModal("myAuditModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("refreshMyAudit").addEventListener("click", async () => {
    try {
      await loadMyAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openProfileModal").addEventListener("click", () => {
    $("profileUsername").value = state.me?.username || "";
    $("profileRole").value = state.me?.role || "";
    $("profileCurrentPassword").value = "";
    $("profileNewPassword").value = "";
    openModal("profileModal");
  });

  $("profileForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const currentPassword = $("profileCurrentPassword").value;
      const newPassword = $("profileNewPassword").value;
      await request("/auth/me/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      closeModal("profileModal");
      showToast("密码已更新");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("editSkuForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await submitEditSkuForm();
      closeModal("editSkuModal");
      showToast("编辑申请已提交");
      await Promise.all([loadProductEditRequests(), loadProductEditPendingSummary()]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("adjustForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const keyword = $("inventoryKeyword").value.trim();
      const shouldRefreshSearch = state.inventorySearchMode && Boolean(keyword);
      const direction = $("adjustDirection").value;
      await submitAdjustForm();
      closeModal("adjustModal");
      showToast(direction === "outbound" ? "FBA补货申请单已生成" : "入库成功");
      await loadInventory();
      await loadBoxes();
      await loadFbaReplenishments();
      await loadAudit();
      if (shouldRefreshSearch) {
        await searchInventoryProducts(keyword);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

function bindDelegates() {
  $("brandsBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (!id) return;
    try {
      if (action === "editBrand") {
        const input = $(`brandName-${id}`);
        if (!input) return;
        const isEditing = state.brandEditingIds.has(String(id));
        if (!isEditing) {
          state.brandEditingIds.add(String(id));
          renderBrandsTable();
          const nextInput = $(`brandName-${id}`);
          if (nextInput) {
            nextInput.focus();
            nextInput.select();
          }
          return;
        }

        const name = String(input.value || "").trim();
        if (!name) {
          throw new Error("品牌名称不能为空");
        }
        const originalName = String(input.dataset.originalName || "").trim();
        if (!originalName) {
          throw new Error("品牌原始值不存在");
        }
        if (name === originalName) {
          state.brandEditingIds.delete(String(id));
          renderBrandsTable();
          return;
        }

        await request(`/brands/${id}`, {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
        state.brandEditingIds.delete(String(id));
        showToast("品牌已更新，关联 SKU 品牌已同步");
        await Promise.all([loadBrands(), loadInventory(), loadAudit()]);
      } else if (action === "deleteBrand") {
        const brandName = button.dataset.name || id;
        const ok = await openActionConfirmModal(`确认删除品牌 ${brandName}？`, "确认操作", "确认删除");
        if (!ok) return;
        await request(`/brands/${id}`, { method: "DELETE" });
        state.brandEditingIds.delete(String(id));
        showToast("品牌已删除");
        await Promise.all([loadBrands(), loadInventory(), loadAudit()]);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("skuTypesBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (!id) return;
    try {
      if (action === "editSkuType") {
        const input = $(`skuTypeName-${id}`);
        if (!input) return;
        const isEditing = state.skuTypeEditingIds.has(String(id));
        if (!isEditing) {
          state.skuTypeEditingIds.add(String(id));
          renderSkuTypesTable();
          const focusInput = $(`skuTypeName-${id}`);
          if (focusInput) {
            focusInput.focus();
            focusInput.select?.();
          }
          return;
        }

        const name = String(input?.value || "").trim();
        if (!name) {
          throw new Error("类型名称不能为空");
        }
        const originalName = String(input.getAttribute("data-original-name") || "").trim();
        if (name === originalName) {
          state.skuTypeEditingIds.delete(String(id));
          renderSkuTypesTable();
          return;
        }
        await request(`/sku-types/${id}`, {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
        state.skuTypeEditingIds.delete(String(id));
        showToast("类型已更新");
        await Promise.all([loadSkuTypes(), loadInventory(), loadAudit()]);
      } else if (action === "deleteSkuType") {
        const skuTypeName = button.dataset.name || id;
        const ok = await openActionConfirmModal(`确认删除类型 ${skuTypeName}？`, "确认操作", "确认删除");
        if (!ok) return;
        await request(`/sku-types/${id}`, { method: "DELETE" });
        state.skuTypeEditingIds.delete(String(id));
        showToast("类型已删除");
        await Promise.all([loadSkuTypes(), loadInventory(), loadAudit()]);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("batchInboundBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const action = button.dataset.action;
    const orderId = button.dataset.orderId;
    if (!orderId) return;

    try {
      if (action === "batchInboundSelectOrder" || action === "batchInboundOpenConfirm") {
        await loadBatchInboundOrderDetail(orderId, { silent: true });
        openModal("batchInboundDetailModal");
      } else if (action === "batchInboundSaveDomesticOrderNo") {
        const input = $(button.dataset.inputId || "");
        const domesticOrderNo = String(input?.value || "").trim();
        if (!domesticOrderNo) {
          throw new Error("请输入国内单号");
        }
        await saveBatchInboundDomesticOrderNo(orderId, domesticOrderNo);
        showToast("国内单号已保存");
        await loadBatchInboundOrders();
        if (state.selectedBatchInboundOrderId) {
          await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId, { silent: true });
        }
      } else if (action === "batchInboundSaveSeaOrderNo") {
        const input = $(button.dataset.inputId || "");
        const seaOrderNo = String(input?.value || "").trim();
        if (!seaOrderNo) {
          throw new Error("请输入海运单号");
        }
        await saveBatchInboundSeaOrderNo(orderId, seaOrderNo);
        showToast("海运单号已保存");
        await loadBatchInboundOrders();
        if (state.selectedBatchInboundOrderId) {
          await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId, { silent: true });
        }
      } else if (action === "batchInboundDeleteOrder") {
        const orderNo = button.dataset.orderNo || orderId;
        const ok = await openDeleteConfirmModal(
          `确认删除批量入库单 ${orderNo} ？删除后会释放该单锁定的箱号。`,
        );
        if (!ok) return;
        await deleteBatchInboundOrder(orderId);
        showToast("删除成功，已释放锁定箱号");
        if (String(state.selectedBatchInboundOrderId) === String(orderId)) {
          state.selectedBatchInboundOrderId = "";
          state.selectedBatchInboundOrderDetail = null;
          renderBatchInboundDetail(null);
        }
        await loadBatchInboundOrders();
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("brandForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const name = String($("brandNameInput").value || "").trim();
      if (!name) {
        throw new Error("请输入品牌名称");
      }
      await request("/brands", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      $("brandNameInput").value = "";
      showToast("品牌已新增");
      await Promise.all([loadBrands(), loadInventory(), loadAudit()]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("skuTypeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const name = String($("skuTypeNameInput").value || "").trim();
      if (!name) {
        throw new Error("请输入类型名称");
      }
      await request("/sku-types", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      $("skuTypeNameInput").value = "";
      showToast("类型已新增");
      await Promise.all([loadSkuTypes(), loadInventory(), loadAudit()]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("shopsBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (!id) return;
    try {
      if (action === "editShop") {
        const input = $(`shopName-${id}`);
        if (!input) return;
        const isEditing = state.shopEditingIds.has(String(id));
        if (!isEditing) {
          state.shopEditingIds.add(String(id));
          renderShopsTable();
          const focusInput = $(`shopName-${id}`);
          if (focusInput) {
            focusInput.focus();
            focusInput.select?.();
          }
          return;
        }

        const name = String(input?.value || "").trim();
        if (!name) {
          throw new Error("请输入店铺名称");
        }
        const originalName = String(input.getAttribute("data-original-name") || "").trim();
        if (name === originalName) {
          state.shopEditingIds.delete(String(id));
          renderShopsTable();
          return;
        }
        await request(`/shops/${id}`, {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
        state.shopEditingIds.delete(String(id));
        showToast("店铺已变更");
        await Promise.all([loadShops(), loadInventory(), loadAudit()]);
      } else if (action === "deleteShop") {
        const shopName = button.dataset.name || id;
        const ok = await openActionConfirmModal(`确认删除店铺 ${shopName} ？`, "确认操作", "确认删除");
        if (!ok) return;
        await request(`/shops/${id}`, { method: "DELETE" });
        state.shopEditingIds.delete(String(id));
        showToast("店铺已删除");
        await Promise.all([loadShops(), loadInventory(), loadAudit()]);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("shopForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const name = String($("shopNameInput").value || "").trim();
      if (!name) {
        throw new Error("请输入店铺名称");
      }
      await request("/shops", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      $("shopNameInput").value = "";
      showToast("店铺已新增");
      await Promise.all([loadShops(), loadInventory(), loadAudit()]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("moveBoxShelfForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const confirmed = await openActionConfirmModal(
        "确认执行“移动箱子到新货架”？",
        "确认操作",
        "确认",
      );
      if (!confirmed) return;
      await submitMoveBoxShelfForm();
      showToast("箱号已移动至新货架");
      await initOverseasWarehousePage();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("moveBoxCodeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const confirmed = await openActionConfirmModal(
        "确认执行“移动产品到新箱子”？",
        "确认操作",
        "确认",
      );
      if (!confirmed) return;
      const result = await submitMoveBoxCodeForm();
      showToast(`已将${result.qty}件产品从 ${result.oldBoxCode} 移动到 ${result.newBoxCode}`);
      await initOverseasWarehousePage();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("batchInboundDetail").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const orderId = button.dataset.orderId;
    if (!orderId) return;

    try {
      if (action === "batchInboundConfirmAll") {
        await confirmBatchInboundAction("all", orderId);
        showToast("整单确认入库成功");
      } else if (action === "batchInboundConfirmBox") {
        const boxCode = button.dataset.boxCode;
        await confirmBatchInboundAction("box", orderId, { boxCode });
        showToast("整箱确认入库成功");
      } else if (action === "batchInboundConfirmItem") {
        const itemId = button.dataset.itemId;
        await confirmBatchInboundAction("item", orderId, { itemId });
        showToast("SKU确认入库成功");
      } else {
        return;
      }

      await loadBatchInboundOrders();
      await loadBatchInboundOrderDetail(orderId, { silent: true });
      await loadInventory();
      await loadBoxes();
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("fbaReplenishmentBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    try {
      const action = button.dataset.action;
      const id = Number(button.dataset.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error("申请单ID无效");
      }

      if (action === "fbaConfirmRow") {
        const inputId = button.dataset.inputId || "";
        const input = $(inputId);
        const actualQty = Number(String(input?.value || "").trim());
        if (!Number.isInteger(actualQty) || actualQty <= 0) {
          throw new Error("实际数量必须是大于0的整数");
        }
        await confirmFbaReplenishmentRequest(id, actualQty);
        showToast("已转为待出库");
      } else if (action === "fbaReopenRow") {
        await reopenFbaReplenishmentRequest(id);
        showToast("已回退到待确认，可重新修改实际数量");
      } else if (action === "fbaDeleteRow") {
        const requestNo = button.dataset.requestNo || `#${id}`;
        const ok = await openDeleteConfirmModal(`确认删除FBA补货申请单 ${requestNo} ？`);
        if (!ok) return;
        await deleteFbaReplenishmentRequest(id);
        showToast("申请单已删除");
      } else {
        return;
      }

      state.selectedFbaIds.delete(String(id));
      await loadFbaReplenishments();
      await loadFbaPendingSummary();
      await loadInventory();
      await loadBoxes();

      const keyword = $("inventoryKeyword").value.trim();
      if (state.inventorySearchMode && keyword) {
        await searchInventoryProducts(keyword);
      }
      await loadAudit();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("fbaReplenishmentBody").addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-action='fbaToggleRow']");
    if (!checkbox) return;

    const id = String(checkbox.dataset.id || "");
    if (!id) return;
    if (checkbox.checked) {
      state.selectedFbaIds.add(id);
    } else {
      state.selectedFbaIds.delete(id);
    }
    updateFbaSelectAll();
    updateFbaOutboundButtonState();
  });

  const openAdjustByAction = async (event) => {
    const button = event.target.closest(
      "button[data-action='inventoryInbound'], button[data-action='inventoryOutbound'], button[data-action='inventoryOutboundOne']",
    );
    if (!button) return;

    const skuId = Number(button.dataset.skuId);
    if (!Number.isInteger(skuId) || skuId <= 0) return;

    try {
      const action = button.dataset.action;
      const boxCode = button.dataset.boxCode || "";
      if (action === "inventoryOutboundOne") {
        const keyword = $("inventoryKeyword").value.trim();
        const shouldRefreshSearch = state.inventorySearchMode && Boolean(keyword);
        await quickOutboundOne(skuId, boxCode);
        showToast("出库1件成功");
        await loadInventory();
        await loadBoxes();
        await loadAudit();
        if (shouldRefreshSearch) {
          await searchInventoryProducts(keyword);
        }
        return;
      }

      const direction = action === "inventoryOutbound" ? "outbound" : "inbound";
      const maxQty = Number(button.dataset.maxQty || 0);
      openAdjustModal(
        direction,
        skuId,
        boxCode,
        Number.isInteger(maxQty) && maxQty > 0 ? maxQty : null,
      );
    } catch (error) {
      showToast(error.message, true);
    }
  };

  $("inventoryBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='inventoryEdit']");
    if (!button) return;
    const skuId = Number(button.dataset.skuId);
    if (!Number.isInteger(skuId) || skuId <= 0) return;
    try {
      await openEditSkuModal(skuId);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("productEditRequestBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const requestId = Number(button.dataset.id || 0);
    if (!Number.isInteger(requestId) || requestId <= 0) return;

    try {
      if (button.dataset.action === "openProductEditRequestDetail") {
        const detail = await loadProductEditRequestDetail(requestId);
        renderProductEditRequestDetail(detail);
        openModal("productEditRequestDetailModal");
        return;
      }

      if (button.dataset.action === "deleteProductEditRequestRow") {
        const ok = await openDeleteConfirmModal("确认删除该编辑申请？");
        if (!ok) return;
        await deleteProductEditRequest(requestId);
        showToast("编辑申请已删除");
        await Promise.all([loadProductEditRequests(), loadProductEditPendingSummary()]);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("confirmProductEditRequestBtn").addEventListener("click", async () => {
    try {
      const id = Number(state.selectedProductEditRequestId || 0);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error("请先选择编辑申请");
      }
      const ok = await openActionConfirmModal(
        "确认后会正式更新产品数据，是否继续？",
        "确认编辑申请",
        "确认",
      );
      if (!ok) return;
      await confirmProductEditRequest(id);
      showToast("编辑申请已确认并更新数据库");
      const detail = await loadProductEditRequestDetail(id);
      renderProductEditRequestDetail(detail);
      await Promise.all([
        loadProductEditRequests(),
        loadProductEditPendingSummary(),
        loadInventory(),
        loadAudit(),
      ]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("inventorySearchResults").addEventListener("click", openAdjustByAction);

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='closeCreateSkuModal']");
    if (button) {
      closeModal("createSkuModal");
      return;
    }
    const boxClose = event.target.closest("button[data-action='closeCreateBoxFromSkuModal']");
    if (boxClose) {
      closeModal("createBoxFromSkuModal");
      return;
    }
    const shelfClose = event.target.closest("button[data-action='closeCreateShelfFromInventoryModal']");
    if (shelfClose) {
      closeModal("createShelfFromInventoryModal");
      return;
    }
    const adjustClose = event.target.closest("button[data-action='closeAdjustModal']");
    if (adjustClose) {
      closeModal("adjustModal");
      return;
    }
    const myAuditClose = event.target.closest("button[data-action='closeMyAuditModal']");
    if (myAuditClose) {
      closeModal("myAuditModal");
      return;
    }
    const profileClose = event.target.closest("button[data-action='closeProfileModal']");
    if (profileClose) {
      closeModal("profileModal");
      return;
    }
    const editClose = event.target.closest("button[data-action='closeEditSkuModal']");
    if (editClose) {
      closeModal("editSkuModal");
      return;
    }
    const brandManageClose = event.target.closest("button[data-action='closeBrandManageModal']");
    if (brandManageClose) {
      closeModal("brandManageModal");
      return;
    }
    const skuTypeManageClose = event.target.closest("button[data-action='closeSkuTypeManageModal']");
    if (skuTypeManageClose) {
      closeModal("skuTypeManageModal");
      return;
    }
    const shopManageClose = event.target.closest("button[data-action='closeShopManageModal']");
    if (shopManageClose) {
      closeModal("shopManageModal");
      return;
    }
    const productEditRequestDetailClose = event.target.closest(
      "button[data-action='closeProductEditRequestDetailModal']",
    );
    if (productEditRequestDetailClose) {
      closeModal("productEditRequestDetailModal");
      return;
    }
    const deleteConfirmClose = event.target.closest("button[data-action='closeDeleteConfirmModal']");
    if (deleteConfirmClose) {
      resolveDeleteConfirm(false);
      return;
    }
    const actionConfirmClose = event.target.closest("button[data-action='closeActionConfirmModal']");
    if (actionConfirmClose) {
      resolveActionConfirm(false);
      return;
    }
    const errorModalClose = event.target.closest("button[data-action='closeErrorModal']");
    if (errorModalClose) {
      closeErrorModal();
      return;
    }
    const batchInboundDetailModalClose = event.target.closest(
      "button[data-action='closeBatchInboundDetailModal']",
    );
    if (batchInboundDetailModalClose) {
      closeModal("batchInboundDetailModal");
      return;
    }
    const fbaOutboundModalClose = event.target.closest(
      "button[data-action='closeFbaOutboundModal']",
    );
    if (fbaOutboundModalClose) {
      closeModal("fbaOutboundModal");
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

  $("createBoxFromSkuModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("createBoxFromSkuModal");
    }
  });

  $("createShelfFromInventoryModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("createShelfFromInventoryModal");
    }
  });

  $("myAuditModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("myAuditModal");
    }
  });

  $("profileModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("profileModal");
    }
  });

  $("editSkuModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("editSkuModal");
    }
  });

  $("brandManageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("brandManageModal");
    }
  });

  $("skuTypeManageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("skuTypeManageModal");
    }
  });

  $("shopManageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("shopManageModal");
    }
  });

  $("productEditRequestDetailModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("productEditRequestDetailModal");
    }
  });

  $("batchInboundDetailModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("batchInboundDetailModal");
    }
  });

  $("fbaOutboundModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("fbaOutboundModal");
    }
  });

  $("deleteConfirmOkBtn").addEventListener("click", () => {
    resolveDeleteConfirm(true);
  });

  $("deleteConfirmCancelBtn").addEventListener("click", () => {
    resolveDeleteConfirm(false);
  });

  $("deleteConfirmModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      resolveDeleteConfirm(false);
    }
  });

  $("actionConfirmOkBtn").addEventListener("click", () => {
    resolveActionConfirm(true);
  });

  $("actionConfirmCancelBtn").addEventListener("click", () => {
    resolveActionConfirm(false);
  });

  $("actionConfirmModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      resolveActionConfirm(false);
    }
  });

  $("errorModalCloseBtn").addEventListener("click", () => {
    closeErrorModal();
  });

  $("errorModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeErrorModal();
    }
  });
}

function bindScrollLoad() {
  window.addEventListener("scroll", () => {
    const threshold = 120;
    const nearBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - threshold;
    if (!nearBottom) return;
    loadMoreInventoryIfNeeded();
  });
}

function bindRefresh() {
  $("refreshInventory").addEventListener("click", () => loadInventory().catch((error) => showToast(error.message, true)));
  $("refreshOverseasWarehouse").addEventListener("click", () =>
    Promise.all([loadShelves(), loadBoxes()]).catch((error) => showToast(error.message, true)),
  );
  $("refreshProductManagement").addEventListener("click", () =>
    Promise.all([
      loadShelves(),
      loadBoxes(),
      loadInventory(),
      loadBrands(),
      loadSkuTypes(),
      loadShops(),
      loadProductEditRequests(),
      loadProductEditPendingSummary(),
    ]).catch((error) =>
      showToast(error.message, true),
    ),
  );
  $("refreshUsers").addEventListener("click", () => loadUsers().catch((error) => showToast(error.message, true)));
  $("refreshShelves").addEventListener("click", () => loadShelves().catch((error) => showToast(error.message, true)));
  $("refreshBoxes").addEventListener("click", () => loadBoxes().catch((error) => showToast(error.message, true)));
  $("refreshBatchInbound").addEventListener("click", () =>
    loadBatchInboundOrders().catch((error) => showToast(error.message, true)),
  );
  $("refreshFbaReplenishment").addEventListener("click", () =>
    Promise.all([loadFbaReplenishments(), loadFbaPendingSummary()]).catch((error) =>
      showToast(error.message, true),
    ),
  );
  $("refreshAudit").addEventListener("click", () => loadAudit().catch((error) => showToast(error.message, true)));
}

bindTabs();
bindInputRules();
bindForms();
bindDelegates();
bindScrollLoad();
bindRefresh();
updateFbaOutboundButtonState();
updateFbaSelectAll();
switchPanel("inventory");
reloadAll().catch((error) => showToast(error.message, true));
