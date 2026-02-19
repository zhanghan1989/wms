const state = {
  token: localStorage.getItem("wms_token") || "",
  me: null,
  shelves: [],
  boxes: [],
  inventorySkus: [],
  inventoryLocations: new Map(),
  inventorySortedSkus: [],
  inventoryVisibleCount: 0,
  inventoryPageSize: 30,
  inventorySearchMode: false,
  batchInboundOrders: [],
  selectedBatchInboundOrderId: "",
  selectedBatchInboundOrderDetail: null,
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

function openDeleteConfirmModal(orderNo) {
  const message = $("deleteConfirmMessage");
  if (message) {
    message.textContent = `确认删除批量入库单 ${orderNo} ？删除后会释放该单锁定的箱号。`;
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
  { label = "出库", ghost = true, lockBox = false, action = "inventoryOutbound" } = {},
) {
  if (Number(totalQty) <= 0) {
    return "";
  }
  const boxAttr = boxCode ? ` data-box-code="${escapeHtml(boxCode)}"` : "";
  const lockAttr = lockBox ? ' data-lock-box="1"' : "";
  const className = ghost ? "tiny-btn ghost" : "tiny-btn";
  return `<button class="${className}" data-action="${action}" data-sku-id="${skuId}"${boxAttr}${lockAttr}>${escapeHtml(label)}</button>`;
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
          boxCode: "",
          shelfCode: "",
          sku: "-",
          qty: 0,
          isCurrentSku: false,
        },
      ];
    }
    return boxRows.map((row) => ({
      boxCode: Number(row.sku?.id) === currentSkuId ? box.boxCode : "",
      shelfCode: Number(row.sku?.id) === currentSkuId ? box.shelfCode : "",
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
                label: "出库",
                ghost: false,
                lockBox: true,
                action: "inventoryOutbound",
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
                  <td>${escapeHtml(row.qty)}</td>
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
      return `
      <tr class="inventory-main-row">
        <td>${escapeHtml(displayText(sku.model))}</td>
        <td>${escapeHtml(displayText(sku.desc1))}</td>
        <td>${escapeHtml(displayText(sku.desc2))}</td>
        <td>${escapeHtml(displayText(sku.remark))}</td>
        <td>${escapeHtml(sku.sku)}</td>
        <td>${escapeHtml(displayText(sku.shop))}</td>
        <td>${escapeHtml(totalQty)}</td>
        <td>
          <div class="action-row">
            ${renderEditButton(sku.id)}
          </div>
        </td>
      </tr>
    `;
    })
    .join("");

  $("inventoryBody").innerHTML = html || '<tr><td colspan="8" class="muted">-</td></tr>';
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
      const leftRows = [
        ["型号", displayText(sku.model)],
        ["说明1", displayText(sku.desc1)],
        ["说明2", displayText(sku.desc2)],
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
                <span class="inventory-search-field-value">${escapeHtml(value)}</span>
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
  renderInventorySearchResults(skus, new Map(locationEntries), new Map(boxSkuEntries));
}

function findSkuById(skuId) {
  return state.inventorySkus.find((sku) => Number(sku.id) === Number(skuId));
}

function openEditSkuModal(skuId) {
  const sku = findSkuById(skuId);
  if (!sku) {
    throw new Error("未找到产品");
  }

  $("editSkuId").value = String(sku.id);
  $("editModel").value = sku.model || "";
  $("editDesc1").value = sku.desc1 || "";
  $("editDesc2").value = sku.desc2 || "";
  $("editShop").value = sku.shop || "";
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
    model: $("editModel").value.trim() || undefined,
    desc1: $("editDesc1").value.trim() || undefined,
    desc2: $("editDesc2").value.trim() || undefined,
    shop: $("editShop").value.trim() || undefined,
    remark: $("editRemark").value.trim() || undefined,
    erpSku: $("editErpSku").value.trim() || undefined,
    asin: $("editAsin").value.trim() || undefined,
    fnsku: $("editFnsku").value.trim() || undefined,
  };

  await request(`/skus/${skuId}`, {
    method: "PUT",
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

async function loadShelves() {
  const shelves = await request("/shelves");
  state.shelves = shelves;
  $("statShelves").textContent = shelves.length;

  renderShelfOptionsForSelect("newBoxShelfId", "请选择货架号");
  renderShelfOptionsForSelect("modalNewBoxShelfId", "请选择货架号");

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
    tbody.innerHTML = '<tr><td colspan="8" class="muted">-</td></tr>';
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
          <td>${formatDate(order.createdAt)}</td>
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

function openAdjustModal(direction, skuId, presetBoxCode = "") {
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
  $("adjustQty").min = "1";
  $("adjustQty").value = "1";
  $("adjustReason").value = direction === "inbound" ? "退货入库" : "库存出库";
  $("adjustModalTitle").textContent = direction === "inbound" ? "库存入库" : "库存出库";
  $("adjustSubmitBtn").textContent = direction === "inbound" ? "确认入库" : "确认出库";
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
  if (reason && reason.length > 10) {
    throw new Error("备注最多 10 个字");
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
  const model = $("modalNewModel").value.trim() || undefined;
  const desc1 = $("modalNewDesc1").value.trim() || undefined;
  const desc2 = $("modalNewDesc2").value.trim() || undefined;
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
    body: JSON.stringify({ model, desc1, desc2, shop, remark, sku, erpSku, asin, fnsku }),
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

async function reloadAll() {
  await loadMe();
  if (!state.token) {
    clearStats();
    $("usersBody").innerHTML = "";
    $("auditBody").innerHTML = "";
    $("inventoryBody").innerHTML = "";
    $("batchInboundBody").innerHTML = "";
    renderBatchInboundDetail(null);
    $("inventorySearchResults").textContent = "-";
    setInventoryDisplayMode(false);
    return;
  }

  const isAdmin = state.me?.role === "admin";
  const tasks = [loadInventory(), loadShelves(), loadBoxes(), loadBatchInboundOrders()];
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

  $("openCreateSkuModal").addEventListener("click", async () => {
    await Promise.all([loadShelves(), loadBoxes()]).catch((error) => showToast(error.message, true));
    $("createSkuModalForm").reset();
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
  $("adjustBoxCode").addEventListener("input", (event) => {
    renderAdjustBoxSuggestions(event.target.value);
  });
  $("adjustBoxCode").addEventListener("focus", (event) => {
    renderAdjustBoxSuggestions(event.target.value);
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
      const keyword = $("inventoryKeyword").value.trim();
      const shouldRefreshSearch = state.inventorySearchMode && Boolean(keyword);
      await submitEditSkuForm();
      closeModal("editSkuModal");
      showToast("产品已更新");
      await loadInventory();
      await loadAudit();
      if (shouldRefreshSearch) {
        await searchInventoryProducts(keyword);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("adjustForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const keyword = $("inventoryKeyword").value.trim();
      const shouldRefreshSearch = state.inventorySearchMode && Boolean(keyword);
      await submitAdjustForm();
      closeModal("adjustModal");
      showToast($("adjustDirection").value === "outbound" ? "出库成功" : "入库成功");
      await loadInventory();
      await loadBoxes();
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
  $("batchInboundBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const action = button.dataset.action;
    const orderId = button.dataset.orderId;
    if (!orderId) return;

    try {
      if (action === "batchInboundSelectOrder" || action === "batchInboundOpenConfirm") {
        await loadBatchInboundOrderDetail(orderId);
        switchPanel("batchInbound");
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
        const ok = await openDeleteConfirmModal(orderNo);
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
      openAdjustModal(direction, skuId, boxCode);
    } catch (error) {
      showToast(error.message, true);
    }
  };

  $("inventoryBody").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='inventoryEdit']");
    if (!button) return;
    const skuId = Number(button.dataset.skuId);
    if (!Number.isInteger(skuId) || skuId <= 0) return;
    try {
      openEditSkuModal(skuId);
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
    const deleteConfirmClose = event.target.closest("button[data-action='closeDeleteConfirmModal']");
    if (deleteConfirmClose) {
      resolveDeleteConfirm(false);
      return;
    }
    const errorModalClose = event.target.closest("button[data-action='closeErrorModal']");
    if (errorModalClose) {
      closeErrorModal();
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
  $("refreshUsers").addEventListener("click", () => loadUsers().catch((error) => showToast(error.message, true)));
  $("refreshShelves").addEventListener("click", () => loadShelves().catch((error) => showToast(error.message, true)));
  $("refreshBoxes").addEventListener("click", () => loadBoxes().catch((error) => showToast(error.message, true)));
  $("refreshBatchInbound").addEventListener("click", () =>
    loadBatchInboundOrders().catch((error) => showToast(error.message, true)),
  );
  $("refreshAudit").addEventListener("click", () => loadAudit().catch((error) => showToast(error.message, true)));
}

bindTabs();
bindInputRules();
bindForms();
bindDelegates();
bindScrollLoad();
bindRefresh();
switchPanel("inventory");
reloadAll().catch((error) => showToast(error.message, true));
