const AUTH_STORAGE_KEY = "wms_token";
const AUTH_COOKIE_KEY = "wms_token";
const AUTH_SESSION_STORAGE_KEY = "wms_token_session";
const AUTH_DEPLOY_VERSION_STORAGE_KEY = "wms_auth_deploy_version";
const AUTH_DEPLOY_VERSION_COOKIE_KEY = "wms_auth_deploy_version";
const AUTH_DEPLOY_VERSION_SESSION_STORAGE_KEY = "wms_auth_deploy_version_session";
const AUTH_DEPLOY_VERSION_HASH_PARAM = "wmsDeployVersion";
const DEPLOY_RELOGIN_MESSAGE = "系统已更新，请重新登录后继续操作。";

function readCookieValue(name) {
  const target = `${String(name || "").trim()}=`;
  if (!target || typeof document === "undefined") return "";
  const parts = String(document.cookie || "").split(";");
  for (const part of parts) {
    const item = String(part || "").trim();
    if (!item.startsWith(target)) continue;
    try {
      return decodeURIComponent(item.slice(target.length));
    } catch {
      return item.slice(target.length);
    }
  }
  return "";
}

function persistAuthToken(token) {
  const value = String(token || "").trim();
  if (!value) {
    clearPersistedAuthToken();
    return "";
  }
  try {
    sessionStorage.setItem(AUTH_SESSION_STORAGE_KEY, value);
  } catch {}
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, value);
    const storedValue = String(localStorage.getItem(AUTH_STORAGE_KEY) || "").trim();
    if (storedValue !== value) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  } catch {
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {}
  }
  document.cookie = `${AUTH_COOKIE_KEY}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  return value;
}

function persistAuthDeployVersion(version) {
  const value = String(version || "").trim();
  try {
    if (value) {
      sessionStorage.setItem(AUTH_DEPLOY_VERSION_SESSION_STORAGE_KEY, value);
    } else {
      sessionStorage.removeItem(AUTH_DEPLOY_VERSION_SESSION_STORAGE_KEY);
    }
  } catch {}
  try {
    if (value) {
      localStorage.setItem(AUTH_DEPLOY_VERSION_STORAGE_KEY, value);
      const storedValue = String(localStorage.getItem(AUTH_DEPLOY_VERSION_STORAGE_KEY) || "").trim();
      if (storedValue !== value) {
        localStorage.removeItem(AUTH_DEPLOY_VERSION_STORAGE_KEY);
      }
    } else {
      localStorage.removeItem(AUTH_DEPLOY_VERSION_STORAGE_KEY);
    }
  } catch {
    try {
      localStorage.removeItem(AUTH_DEPLOY_VERSION_STORAGE_KEY);
    } catch {}
  }
  if (value) {
    document.cookie = `${AUTH_DEPLOY_VERSION_COOKIE_KEY}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
    return value;
  }
  document.cookie = `${AUTH_DEPLOY_VERSION_COOKIE_KEY}=; Max-Age=0; Path=/; SameSite=Lax`;
  return "";
}

function clearPersistedAuthToken() {
  try {
    sessionStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
    sessionStorage.removeItem(AUTH_DEPLOY_VERSION_SESSION_STORAGE_KEY);
  } catch {}
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(AUTH_DEPLOY_VERSION_STORAGE_KEY);
  } catch {}
  document.cookie = `${AUTH_COOKIE_KEY}=; Max-Age=0; Path=/; SameSite=Lax`;
  document.cookie = `${AUTH_DEPLOY_VERSION_COOKIE_KEY}=; Max-Age=0; Path=/; SameSite=Lax`;
}

function readPersistedAuthToken() {
  let sessionValue = "";
  try {
    sessionValue = String(sessionStorage.getItem(AUTH_SESSION_STORAGE_KEY) || "").trim();
  } catch {}
  if (sessionValue) {
    persistAuthToken(sessionValue);
    return sessionValue;
  }

  let storageValue = "";
  try {
    storageValue = String(localStorage.getItem(AUTH_STORAGE_KEY) || "").trim();
  } catch {}
  const cookieValue = String(readCookieValue(AUTH_COOKIE_KEY) || "").trim();
  if (cookieValue && cookieValue !== storageValue) {
    persistAuthToken(cookieValue);
    return cookieValue;
  }
  if (storageValue) {
    persistAuthToken(storageValue);
    return storageValue;
  }
  if (cookieValue) {
    persistAuthToken(cookieValue);
    return cookieValue;
  }
  return "";
}

function applyInitialAuthStateAttribute(isLoggedIn) {
  if (typeof document === "undefined" || !document.documentElement) return;
  document.documentElement.setAttribute("data-wms-auth-state", isLoggedIn ? "logged-in" : "logged-out");
}

function readPersistedAuthDeployVersion() {
  let sessionValue = "";
  try {
    sessionValue = String(sessionStorage.getItem(AUTH_DEPLOY_VERSION_SESSION_STORAGE_KEY) || "").trim();
  } catch {}
  if (sessionValue) {
    persistAuthDeployVersion(sessionValue);
    return sessionValue;
  }

  let storageValue = "";
  try {
    storageValue = String(localStorage.getItem(AUTH_DEPLOY_VERSION_STORAGE_KEY) || "").trim();
  } catch {}
  const cookieValue = String(readCookieValue(AUTH_DEPLOY_VERSION_COOKIE_KEY) || "").trim();
  if (cookieValue && cookieValue !== storageValue) {
    persistAuthDeployVersion(cookieValue);
    return cookieValue;
  }
  if (storageValue) {
    persistAuthDeployVersion(storageValue);
    return storageValue;
  }
  if (cookieValue) {
    persistAuthDeployVersion(cookieValue);
    return cookieValue;
  }
  return "";
}

const state = {
  token: readPersistedAuthToken(),
  authDeployVersion: readPersistedAuthDeployVersion(),
  currentDeployVersion: "",
  me: null,
  shelves: [],
  boxes: [],
  boxManageRows: [],
  boxManagePage: 1,
  boxManagePageSize: 30,
  boxManageHasMore: false,
  boxManageLoading: false,
  emptyBoxes: [],
  inventorySkus: [],
  brands: [],
  skuTypes: [],
  shops: [],
  skuEditRequests: [],
  skuEditRequestsPage: 1,
  skuEditRequestsPageSize: 30,
  skuEditRequestsHasMore: false,
  skuEditRequestsLoading: false,
  masterProducts: [],
  masterProductsPage: 1,
  masterProductsPageSize: 30,
  masterProductsHasMore: false,
  masterProductKeyword: "",
  masterProductView: "syncRecords",
  selectedMasterProductId: "",
  selectedMasterProductDetail: null,
  masterProductSyncRecords: [],
  masterProductSyncRecordsPage: 1,
  masterProductSyncRecordsPageSize: 30,
  masterProductSyncRecordsHasMore: false,
  masterProductExportFilterOptions: null,
  rakutenComboProducts: [],
  rakutenComboProductsPage: 1,
  rakutenComboProductsPageSize: 30,
  rakutenComboProductsHasMore: false,
  rakutenComboProductsTotal: 0,
  rakutenComboProductsLoading: false,
  rakutenComboProductKeyword: "",
  rakutenComboProductDraftItems: [],
  rakutenComboProductEditingId: "",
  inventoryLocations: new Map(),
  inventoryTotalsBySku: {},
  inventorySortedSkus: [],
  inventoryVisibleCount: 0,
  inventoryListPageSize: 20,
  skuManagementKeyword: "",
  skuManagementVisibleCount: 0,
  inventoryPageSize: 30,
  inventoryHomeProducts: [],
  inventoryHomePage: 1,
  inventoryHomePageSize: 30,
  inventoryHomeHasMore: false,
  inventoryHomeLoading: false,
  inventoryHomeKeyword: "",
  inventoryHomeSelectedDetail: null,
  inventorySearchMode: false,
  inventorySearchKeyword: "",
  inventorySearchPage: 0,
  inventorySearchPageSize: 10,
  inventorySearchHasMore: false,
  inventorySearchLoading: false,
  inventorySearchSkus: [],
  inventorySearchLocationMap: new Map(),
  inventorySearchBoxSkuMap: new Map(),
  users: [],
  usersById: new Map(),
  usersVisibleCount: 0,
  departmentOptions: [],
  roleOptions: [],
  auditLogs: [],
  auditVisibleCount: 0,
  myAuditLogs: [],
  myAuditVisibleCount: 0,
  batchInboundOrders: [],
  batchInboundVisibleCount: 0,
  selectedBatchInboundOrderId: "",
  selectedBatchInboundOrderDetail: null,
  orders: [],
  ordersVisibleCount: 0,
  amazonOrders: [],
  amazonOrdersVisibleCount: 0,
  manualOrders: [],
  manualOrdersVisibleCount: 0,
  overseasOrderProcessingOrders: [],
  chinaOrderProcessingOrders: [],
  overseasPickingBatches: [],
  overseasPickingBatchView: "list",
  selectedOverseasPickingBatchId: "",
  selectedOverseasPickingBatchDetail: null,
  yamatoShipmentBatches: [],
  yamatoPrintConfig: { mode: "browser", printerName: "" },
  selectedYamatoShipmentBatchId: "",
  selectedOverseasOrderKeys: new Set(),
  fbaReplenishments: [],
  fbaReplenishmentsVisibleCount: 0,
  fbaPendingCount: 0,
  productEditPendingCount: 0,
  fbaPendingBySku: {},
  fbaPendingByBoxSku: {},
  selectedProductEditRequestId: null,
  selectedProductEditRequestChangedFields: [],
  selectedProductEditRequestIds: new Set(),
  selectedEditUserId: null,
  selectedResetPasswordUserId: null,
  selectedRakutenOrderIds: new Set(),
  selectedAmazonOrderIds: new Set(),
  selectedManualOrderIds: new Set(),
  selectedFbaIds: new Set(),
  brandEditingIds: new Set(),
  skuTypeEditingIds: new Set(),
  shopEditingIds: new Set(),
  shelfEditingIds: new Set(),
  boxEditingIds: new Set(),
  shelfManageVisibleCount: 10,
  boxManageVisibleCount: 30,
  manageModalInitialPageSize: 10,
  manageModalLoadStep: 20,
  departmentOptionEditingCodes: new Set(),
  roleOptionEditingCodes: new Set(),
  auditFbaRequestNoById: {},
  overviewDashboard: null,
  dataBackups: [],
  dataBackupsVisibleCount: 0,
  pendingPrintLabel: null,
  stocktakeTasks: [],
  stocktakeVisibleCount: 0,
  selectedStocktakeTask: null,
  selectedStocktakeTaskRows: [],
  selectedShelfBoxQueryShelfCode: "",
  selectedShelfBoxQueryRows: [],
};

let deleteConfirmResolver = null;
let actionConfirmResolver = null;
let suppressAuthErrorToastUntil = 0;
let adjustBoxValidationTimer = null;
let adjustBoxValidationToken = 0;
let inventoryDetailInboundBoxValidationTimer = null;
let inventoryDetailInboundBoxValidationToken = 0;
let modalZIndexSeed = 20;
let errorModalAutoActionTimer = null;
let errorModalCountdownTimer = null;
let errorModalAutoAction = null;
let inventoryHomeLoadObserver = null;
let productEditRequestLoadObserver = null;
let skuManagementLoadObserver = null;
let ordersLoadObserver = null;
let amazonOrdersLoadObserver = null;
let manualOrdersLoadObserver = null;
let fbaReplenishmentLoadObserver = null;
let batchInboundLoadObserver = null;
let usersLoadObserver = null;
let auditLoadObserver = null;
let stocktakePlannerLoadObserver = null;
let dataBackupLoadObserver = null;
let shelfManageLoadObserver = null;
let boxManageLoadObserver = null;
let rakutenComboProductLoadObserver = null;
let responsiveTableLabelObserver = null;
let responsiveTableLabelFrame = 0;
let skuProductLookupToken = 0;
let hasUserNavigatedSinceBootstrap = false;
const AUTH_ERROR_STORAGE_KEY = "wms_auth_error_message";
const AUTH_HASH_PARAM = "wmsToken";

const SILENT_AUTH_ERROR_MESSAGE = "__silent_auth__";
const $ = (id) => document.getElementById(id);

$("openEmptyBoxManageModal")?.remove();
$("emptyBoxManageModal")?.remove();

const DEFAULT_DEPARTMENT_OPTIONS = [
  { code: "factory", name: "工厂", status: 1, sort: 10 },
  { code: "overseas_warehouse", name: "海外仓", status: 1, sort: 20 },
  { code: "china_warehouse", name: "中国仓", status: 1, sort: 30 },
];

const DEFAULT_ROLE_OPTIONS = [
  { code: "employee", name: "员工", status: 1, sort: 10 },
  { code: "admin", name: "管理者", status: 1, sort: 20 },
  { code: "system_admin", name: "系统管理员", status: 1, sort: 30 },
];
const SKU_EDIT_PENDING_BLOCK_MESSAGE = "正在编辑产品申请中，请管理员确认后再执行相关操作。";

const AUDIT_EVENT_TEXT_MAP = {
  box_created: "新增箱号",
  box_field_updated: "箱号信息更新",
  box_renamed: "箱号重命名",
  box_disabled: "禁用箱号",
  box_deleted: "删除箱号",
  box_stock_increased: "箱内库存增加",
  box_stock_outbound: "箱内库存出库",
  sku_created: "新增SKU",
  sku_field_updated: "SKU信息更新",
  sku_disabled: "禁用SKU",
  sku_deleted: "删除SKU",
  shelf_created: "新增货架",
  shelf_field_updated: "货架信息更新",
  shelf_disabled: "禁用货架",
  shelf_deleted: "删除货架",
  brand_created: "新增品牌",
  brand_updated: "更新品牌",
  brand_deleted: "删除品牌",
  sku_type_created: "新增类型",
  sku_type_updated: "更新类型",
  sku_type_deleted: "删除类型",
  shop_created: "新增店铺",
  shop_updated: "更新店铺",
  shop_deleted: "删除店铺",
  user_created: "新增用户",
  user_updated: "更新用户",
  user_disabled: "禁用用户",
  user_deleted: "删除用户",
  inbound_order_created: "创建入库单",
  inbound_order_confirmed: "确认入库单",
  inbound_order_voided: "作废入库单",
  outbound_order_created: "创建出库单",
  outbound_order_confirmed: "确认出库单",
  outbound_order_voided: "作废出库单",
  stocktake_task_created: "创建盘点任务",
  stocktake_task_started: "开始盘点任务",
  stocktake_task_finished: "完成盘点任务",
  stocktake_task_voided: "作废盘点任务",
  inventory_adjust_created: "创建库存调整单",
  inventory_adjust_confirmed: "确认库存调整单",
  inventory_adjust_voided: "作废库存调整单",
};

const AUDIT_ENTITY_TEXT_MAP = {
  box: "箱号",
  sku: "产品",
  shelf: "货架",
  user: "用户",
  brand: "品牌",
  sku_type: "类型",
  shop: "店铺",
  inbound_order: "入库单",
  outbound_order: "出库单",
  stocktake_task: "盘点任务",
  inventory_adjust_order: "库存调整单",
  fba_replenishment: "FBA补货申请",
  product_edit_request: "产品编辑申请",
};
const PRODUCT_EDIT_CONFIRM_PERMISSION_MESSAGE_FACTORY = "仅佛山工厂管理者可确认编辑申请";

function showToast(message, isError = false, options = {}) {
  if (String(message || "") === SILENT_AUTH_ERROR_MESSAGE) {
    return;
  }
  showErrorModal(message, isError, options);
}

function persistAuthGateMessage(message) {
  try {
    if (message) {
      window.sessionStorage.setItem(AUTH_ERROR_STORAGE_KEY, String(message));
      return;
    }
    window.sessionStorage.removeItem(AUTH_ERROR_STORAGE_KEY);
  } catch {}
}

function readPersistedAuthGateMessage() {
  try {
    return String(window.sessionStorage.getItem(AUTH_ERROR_STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

function renderAuthGateMessage(message = "") {
  const node = $("loginGateStatus");
  if (!node) return;
  const text = String(message || "").trim();
  node.textContent = text;
  node.classList.toggle("hidden", !text);
}

function expireAuthSession(message = "未授权，请重新登录", sourcePath = "") {
  const authMessage = normalizeErrorMessage(message || "未授权，请重新登录");
  const loginGateMessage =
    sourcePath && sourcePath !== "/auth/deploy-version" ? `${sourcePath} 返回 401\n${authMessage}` : authMessage;
  hasUserNavigatedSinceBootstrap = false;
  state.token = "";
  state.authDeployVersion = "";
  state.currentDeployVersion = "";
  state.me = null;
  suppressAuthErrorToastUntil = Date.now() + 3000;
  clearPersistedAuthToken();
  document.querySelectorAll(".modal").forEach((modal) => modal.classList.add("hidden"));
  clearErrorModalAutoState();
  $("sessionInfo").textContent = "登录失效";
  setAuthGate(false);
  applyRoleView();
  persistAuthGateMessage(loginGateMessage);
  renderAuthGateMessage(loginGateMessage);
  showToast(authMessage, true);
}

async function fetchDeployVersion() {
  let res;
  try {
    res = await fetch("/api/auth/deploy-version", { cache: "no-store" });
  } catch (error) {
    const requestError = new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
    requestError.status = 0;
    throw requestError;
  }

  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text || "请求失败" };
  }

  if (!res.ok || payload.code !== 0) {
    const requestError = new Error(normalizeErrorMessage(payload.message || `HTTP ${res.status}`));
    requestError.status = res.status;
    requestError.path = "/auth/deploy-version";
    throw requestError;
  }

  const deployVersion = String(payload?.data?.deployVersion || "").trim();
  if (!deployVersion) {
    throw new Error("系统部署版本缺失");
  }
  state.currentDeployVersion = deployVersion;
  return deployVersion;
}

async function ensureAuthDeployVersion() {
  if (!state.token) return "";

  const currentDeployVersion = await fetchDeployVersion();
  const authDeployVersion = String(state.authDeployVersion || readPersistedAuthDeployVersion() || "").trim();
  if (!authDeployVersion) {
    expireAuthSession(DEPLOY_RELOGIN_MESSAGE, "/auth/deploy-version");
    const silentAuthError = new Error(SILENT_AUTH_ERROR_MESSAGE);
    silentAuthError.status = 401;
    silentAuthError.path = "/auth/deploy-version";
    silentAuthError.responseMessage = DEPLOY_RELOGIN_MESSAGE;
    throw silentAuthError;
  }
  if (authDeployVersion !== currentDeployVersion) {
    expireAuthSession(DEPLOY_RELOGIN_MESSAGE, "/auth/deploy-version");
    const silentAuthError = new Error(SILENT_AUTH_ERROR_MESSAGE);
    silentAuthError.status = 401;
    silentAuthError.path = "/auth/deploy-version";
    silentAuthError.responseMessage = DEPLOY_RELOGIN_MESSAGE;
    throw silentAuthError;
  }

  return currentDeployVersion;
}

function clearErrorModalAutoState({ keepAction = false } = {}) {
  if (errorModalAutoActionTimer) {
    clearTimeout(errorModalAutoActionTimer);
    errorModalAutoActionTimer = null;
  }
  if (errorModalCountdownTimer) {
    clearInterval(errorModalCountdownTimer);
    errorModalCountdownTimer = null;
  }
  if (!keepAction) {
    errorModalAutoAction = null;
  }
}

function showErrorModal(message, isError = true, options = {}) {
  const text = String(message || "发生未知错误");
  const modalCard = document.querySelector("#errorModal .modal-card");
  const title = $("errorModalTitle");
  const icon = $("errorModalIcon");
  const messageEl = $("errorModalMessage");
  const closeBtn = $("errorModalCloseBtn");
  const printLabelBtn = $("errorModalPrintLabelBtn");
  const countdownSeconds = Number(options?.countdownSeconds ?? 0);
  const hideCloseButton = Boolean(options?.hideCloseButton);
  const autoNavigateHome = Boolean(options?.autoNavigateHome);
  const labelData = !isError && options && typeof options === "object" ? options.labelData || null : null;
  state.pendingPrintLabel = labelData;
  clearErrorModalAutoState();
  if (modalCard) {
    modalCard.classList.toggle("is-info", !isError);
  }
  if (title) {
    title.innerHTML = `<span id="errorModalIcon" class="confirm-icon">${isError ? "!" : "i"}</span>${
      isError ? "错误" : "提示"
    }`;
  }
  if (icon && !title) {
    icon.textContent = isError ? "!" : "i";
  }
  if (messageEl) {
    messageEl.textContent = text;
  }
  if (closeBtn) {
    closeBtn.textContent = isError ? "我知道了" : "关闭";
    closeBtn.classList.toggle("danger-solid", isError);
    closeBtn.classList.toggle("hidden", hideCloseButton);
  }
  if (printLabelBtn) {
    const shouldShowPrint = Boolean(labelData && String(labelData.fnsku || "").trim());
    printLabelBtn.classList.toggle("hidden", !shouldShowPrint);
  }
  if (countdownSeconds > 0 && messageEl) {
    let remaining = Math.max(1, Math.floor(countdownSeconds));
    const renderCountdownMessage = () => {
      messageEl.textContent = `${text}（${remaining}秒后自动跳转到首页）`;
    };
    renderCountdownMessage();
    errorModalCountdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearErrorModalAutoState({ keepAction: true });
        return;
      }
      renderCountdownMessage();
    }, 1000);
    if (autoNavigateHome) {
      errorModalAutoAction = async () => {
        await openInventoryHomeDefault();
      };
    }
    errorModalAutoActionTimer = setTimeout(async () => {
      const callback = errorModalAutoAction;
      clearErrorModalAutoState();
      closeModal("errorModal");
      if (typeof callback === "function") {
        await callback();
      }
    }, remaining * 1000);
  }
  openModal("errorModal");
}

function closeErrorModal() {
  state.pendingPrintLabel = null;
  const printLabelBtn = $("errorModalPrintLabelBtn");
  if (printLabelBtn) {
    printLabelBtn.classList.add("hidden");
  }
  const closeBtn = $("errorModalCloseBtn");
  if (closeBtn) {
    closeBtn.classList.remove("hidden");
  }
  clearErrorModalAutoState();
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

const LABEL_5030_SIZE_MM = {
  width: 50.186,
  height: 30.113,
};

const CODE39_PATTERNS = {
  "0": "nnnwwnwnn",
  "1": "wnnwnnnnw",
  "2": "nnwwnnnnw",
  "3": "wnwwnnnnn",
  "4": "nnnwwnnnw",
  "5": "wnnwwnnnn",
  "6": "nnwwwnnnn",
  "7": "nnnwnnwnw",
  "8": "wnnwnnwnn",
  "9": "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  "$": "nwnwnwnnn",
  "/": "nwnwnnnwn",
  "+": "nwnnnwnwn",
  "%": "nnnwnwnwn",
  "*": "nwnnwnwnn",
};

function normalizeFnskuForLabel(rawValue) {
  const normalized = String(rawValue || "").trim().toUpperCase();
  if (!normalized) {
    throw new Error("fnSKU为空，无法打印标签");
  }
  const unsupportedChars = Array.from(normalized).filter((char) => !CODE39_PATTERNS[char]);
  if (unsupportedChars.length) {
    throw new Error(`fnSKU含有不支持的一维码字符：${unsupportedChars.join(" ")}`);
  }
  return normalized;
}

function normalizeLabelPrintQty(rawQty) {
  const qty = Number(rawQty);
  if (!Number.isInteger(qty) || qty <= 0) {
    return 1;
  }
  return qty;
}

function buildCode39BarcodeSvg(value) {
  const encoded = `*${normalizeFnskuForLabel(value)}*`;
  const narrow = 2;
  const wide = 5;
  const height = 88;
  let x = 0;
  const bars = [];

  for (let idx = 0; idx < encoded.length; idx += 1) {
    const pattern = CODE39_PATTERNS[encoded[idx]];
    for (let i = 0; i < pattern.length; i += 1) {
      const isBar = i % 2 === 0;
      const width = pattern[i] === "w" ? wide : narrow;
      if (isBar) {
        bars.push(`<rect x="${x}" y="0" width="${width}" height="${height}" fill="#111" />`);
      }
      x += width;
    }
    if (idx < encoded.length - 1) {
      x += narrow;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x} ${height}" preserveAspectRatio="none">${bars.join(
    "",
  )}</svg>`;
}

function buildCode39BarcodeSvgForValue(rawValue, fieldLabel = "编码") {
  const normalized = String(rawValue || "").trim().toUpperCase();
  if (!normalized) {
    throw new Error(`${fieldLabel}为空，无法打印标签`);
  }
  const unsupportedChars = Array.from(normalized).filter((char) => !CODE39_PATTERNS[char]);
  if (unsupportedChars.length) {
    throw new Error(`${fieldLabel}包含不支持字符：${unsupportedChars.join(" ")}`);
  }
  const encoded = `*${normalized}*`;
  const narrow = 2;
  const wide = 5;
  const height = 88;
  let x = 0;
  const bars = [];

  for (let idx = 0; idx < encoded.length; idx += 1) {
    const pattern = CODE39_PATTERNS[encoded[idx]];
    for (let i = 0; i < pattern.length; i += 1) {
      const isBar = i % 2 === 0;
      const width = pattern[i] === "w" ? wide : narrow;
      if (isBar) {
        bars.push(`<rect x="${x}" y="0" width="${width}" height="${height}" fill="#111" />`);
      }
      x += width;
    }
    if (idx < encoded.length - 1) {
      x += narrow;
    }
  }

  return {
    normalized,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x} ${height}" preserveAspectRatio="none">${bars.join(
      "",
    )}</svg>`,
  };
}

function openPrintLabelWindow(labelData) {
  const fnsku = normalizeFnskuForLabel(labelData?.fnsku);
  const printQty = normalizeLabelPrintQty(labelData?.qty);
  const skuText = String(labelData?.sku || "").trim();
  const newProductText = `新品-${skuText || "-"}`;
  const barcodeSvg = buildCode39BarcodeSvg(fnsku);
  const pageWidth = LABEL_5030_SIZE_MM.width;
  const pageHeight = LABEL_5030_SIZE_MM.height;
  const popup = window.open("", "_blank", "width=520,height=360");
  if (!popup) {
    throw new Error("打印窗口被拦截，请允许弹窗后重试");
  }

  popup.document.open();
  popup.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>打印标签</title>
    <style>
      @page {
        size: ${pageWidth}mm ${pageHeight}mm;
        margin: 0;
      }
      html, body {
        margin: 0;
        padding: 0;
        width: ${pageWidth}mm;
        height: ${pageHeight}mm;
      }
      body {
        font-family: "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
      }
      .print-page {
        width: ${pageWidth}mm;
        height: ${pageHeight}mm;
        page-break-after: always;
      }
      .print-page:last-child {
        page-break-after: auto;
      }
      .label {
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        padding: 1mm;
        display: flex;
        flex-direction: column;
      }
      .label-barcode {
        height: 40%;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        box-sizing: border-box;
        padding: 0 3mm;
        margin-top: 2mm;
        overflow: hidden;
      }
      .label-barcode svg {
        width: 100%;
        height: 100%;
      }
      .label-bottom {
        flex: 1;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 1.2mm;
        overflow: hidden;
        word-break: break-all;
      }
      .label-bottom-text {
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.8mm;
      }
      .label-fnsku {
        text-align: center;
        font-size: 4.5mm;
        font-weight: 700;
        color: #111;
        line-height: 1.1;
        transform: translateY(-0.8mm);
      }
      .label-sku {
        text-align: center;
        font-size: 3.4mm;
        font-weight: 700;
        color: #111;
        line-height: 1.2;
      }
    </style>
  </head>
  <body>
    ${Array.from({ length: printQty })
      .map(
        () => `<div class="print-page">
      <div class="label">
        <div class="label-barcode">${barcodeSvg}</div>
        <div class="label-bottom">
          <div class="label-bottom-text">
            <span class="label-fnsku">${escapeHtml(fnsku)}</span>
            <span class="label-sku">${escapeHtml(newProductText)}</span>
          </div>
        </div>
      </div>
    </div>`,
      )
      .join("")}
    <script>
      window.addEventListener("load", function () {
        setTimeout(function () {
          window.focus();
          window.print();
        }, 120);
      });
      window.addEventListener("afterprint", function () {
        window.close();
      });
    </script>
  </body>
</html>`);
  popup.document.close();
}

function openProductIdLabelWindow(productId) {
  const barcode = buildCode39BarcodeSvgForValue(productId, "产品ID");
  const pageWidth = LABEL_5030_SIZE_MM.width;
  const pageHeight = LABEL_5030_SIZE_MM.height;
  const popup = window.open("", "_blank", "width=520,height=360");
  if (!popup) {
    throw new Error("打印窗口被拦截，请允许弹窗后重试");
  }

  popup.document.open();
  popup.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>产品入库标打印</title>
    <style>
      @page {
        size: ${pageWidth}mm ${pageHeight}mm;
        margin: 0;
      }
      html, body {
        margin: 0;
        padding: 0;
        width: ${pageWidth}mm;
        height: ${pageHeight}mm;
      }
      body {
        font-family: "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
      }
      .print-page {
        width: ${pageWidth}mm;
        height: ${pageHeight}mm;
      }
      .label {
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        padding: 1mm;
        display: flex;
        flex-direction: column;
      }
      .label-barcode {
        height: 58%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2mm 3mm 0;
        overflow: hidden;
      }
      .label-barcode svg {
        width: 100%;
        height: 100%;
      }
      .label-bottom {
        flex: 1;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 1mm;
      }
      .label-product-id {
        text-align: center;
        font-size: 5mm;
        font-weight: 700;
        color: #111;
        line-height: 1.1;
      }
    </style>
  </head>
  <body>
    <div class="print-page">
      <div class="label">
        <div class="label-barcode">${barcode.svg}</div>
        <div class="label-bottom">
          <div class="label-product-id">${escapeHtml(barcode.normalized)}</div>
        </div>
      </div>
    </div>
    <script>
      window.addEventListener("load", function () {
        setTimeout(function () {
          window.focus();
          window.print();
        }, 120);
      });
      window.addEventListener("afterprint", function () {
        window.close();
      });
    </script>
  </body>
</html>`);
  popup.document.close();
}

function openBatchProductIdLabelWindow(entries, shelfCode = "") {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const printableEntries = safeEntries
    .map((item) => ({
      productId: String(item?.productId || "").trim(),
      qty: Math.max(0, Number(item?.qty ?? 0)),
    }))
    .filter((item) => item.productId && item.qty > 0);

  if (!printableEntries.length) {
    throw new Error("没有可打印的产品标签");
  }

  const pageWidth = LABEL_5030_SIZE_MM.width;
  const pageHeight = LABEL_5030_SIZE_MM.height;
  const labels = [];
  printableEntries.forEach(({ productId, qty }) => {
    const barcode = buildCode39BarcodeSvgForValue(productId, "产品ID");
    for (let index = 0; index < qty; index += 1) {
      labels.push(`
        <div class="print-page">
          <div class="label">
            <div class="label-barcode">${barcode.svg}</div>
            <div class="label-bottom">
              <div class="label-product-id">${escapeHtml(barcode.normalized)}</div>
            </div>
          </div>
        </div>
      `);
    }
  });

  const popup = window.open("", "_blank", "width=720,height=640");
  if (!popup) {
    throw new Error("打印窗口被浏览器阻止，请允许弹窗后重试");
  }

  const titleSuffix = shelfCode ? ` - 货架 ${escapeHtml(String(shelfCode))}` : "";
  popup.document.open();
  popup.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>产品入库标批量打印${titleSuffix}</title>
    <style>
      @page {
        size: ${pageWidth}mm ${pageHeight}mm;
        margin: 0;
      }
      html, body {
        margin: 0;
        padding: 0;
      }
      body {
        font-family: "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
      }
      .print-page {
        width: ${pageWidth}mm;
        height: ${pageHeight}mm;
        page-break-after: always;
        break-after: page;
      }
      .print-page:last-child {
        page-break-after: auto;
        break-after: auto;
      }
      .label {
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        padding: 1mm;
        display: flex;
        flex-direction: column;
      }
      .label-barcode {
        height: 58%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2mm 3mm 0;
        overflow: hidden;
      }
      .label-barcode svg {
        width: 100%;
        height: 100%;
      }
      .label-bottom {
        flex: 1;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 1mm;
      }
      .label-product-id {
        text-align: center;
        font-size: 5mm;
        font-weight: 700;
        color: #111;
        line-height: 1.1;
      }
    </style>
  </head>
  <body>
    ${labels.join("")}
    <script>
      window.addEventListener("load", function () {
        setTimeout(function () {
          window.focus();
          window.print();
        }, 120);
      });
      window.addEventListener("afterprint", function () {
        window.close();
      });
    </script>
  </body>
</html>`);
  popup.document.close();
}

function printPendingLabelFromErrorModal() {
  if (!state.pendingPrintLabel) {
    throw new Error("当前没有可打印的标签数据");
  }
  openPrintLabelWindow(state.pendingPrintLabel);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function formatDateOnly(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function formatDateOnlyWithWeekday(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  return `${formatDateOnly(value)}(${weekdays[date.getDay()] || "-"})`;
}

const STOCKTAKE_DISPLAY_TIMEZONE = "Asia/Shanghai";

function formatDateOnlyInTimeZone(value, timeZone = STOCKTAKE_DISPLAY_TIMEZONE) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const mapped = Object.fromEntries(parts.filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));
  return `${mapped.year || "0000"}/${mapped.month || "00"}/${mapped.day || "00"}`;
}

function formatDateOnlyWithWeekdayInTimeZone(value, timeZone = STOCKTAKE_DISPLAY_TIMEZONE) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(date);
  const mapped = Object.fromEntries(parts.filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));
  return `${mapped.year || "0000"}/${mapped.month || "00"}/${mapped.day || "00"}(${mapped.weekday || "-"})`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getTodayStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function formatDateForFilename(date) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((item) => item.type !== "literal")
      .map((item) => [item.type, item.value]),
  );
  return `${parts.year || "0000"}${parts.month || "00"}${parts.day || "00"}-${parts.hour || "00"}${
    parts.minute || "00"
  }${parts.second || "00"}`;
}

function renderBossStockAdjustmentProductTypes() {
  const container = $("bossStockAdjustmentProductTypes");
  if (!container) return;
  const values = Array.isArray(state.masterProductExportFilterOptions?.productType)
    ? state.masterProductExportFilterOptions.productType
    : [];
  if (!values.length) {
    container.innerHTML = '<div class="muted">暂无可选产品类型</div>';
    return;
  }
  container.innerHTML = values
    .map(
      (value) => `
        <label class="boss-stock-adjustment-option">
          <input type="checkbox" name="bossStockAdjustmentProductType" value="${escapeHtml(value)}" />
          <span>${escapeHtml(value)}</span>
        </label>
      `,
    )
    .join("");
}

async function openBossStockAdjustmentModal() {
  await loadMasterProductExportFilterOptions();
  renderBossStockAdjustmentProductTypes();
  openModal("bossStockAdjustmentModal");
}

function getSelectedBossStockAdjustmentProductTypes() {
  return Array.from(document.querySelectorAll('input[name="bossStockAdjustmentProductType"]:checked'))
    .map((input) => String(input.value || "").trim())
    .filter(Boolean);
}

async function downloadStockAdjustmentCsv(productTypes = []) {
  if (!state.token) {
    throw new Error("请先登录");
  }
  const params = new URLSearchParams();
  productTypes.forEach((value) => params.append("productTypes", value));
  let response;
  try {
    response = await fetch(params.toString() ? `/api/inventory/stock-adjustment-csv?${params.toString()}` : "/api/inventory/stock-adjustment-csv", {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename="?([^";]+)"?/i);
  let fileName = `stock_ajustment_${formatDateForFilename(new Date())}.csv`;
  if (utf8NameMatch?.[1]) {
    try {
      fileName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    fileName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`已下载 ${fileName}`);
}

async function downloadBossMappingCsv() {
  if (!state.token) {
    throw new Error("请先登录");
  }
  let response;
  try {
    response = await fetch("/api/inventory/boss-mapping-csv", {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
  let fileName = `MappingItem_${formatDateForFilename(new Date())}.csv`;
  if (utf8NameMatch?.[1]) {
    try {
      fileName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    fileName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`已下载 ${fileName}`);
}

async function downloadPrintAgentWindowsExe() {
  if (!state.token) {
    throw new Error("请先登录");
  }
  const fileName = await downloadAuthorizedFile(
    "/inventory/print-agent-windows-exe",
    {},
    "wms-print-agent.exe",
  );
  showToast(`已生成并下载 ${fileName}`);
}

/*
async function downloadBossNewItemZip() {
  if (!state.token) {
    throw new Error("隸キ蜈育匳蠖・);
  }
  let response;
  try {
    response = await fetch("/api/inventory/boss-newitem-zip", {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
  let fileName = `boss_newitem_${formatDateForFilename(new Date())}.zip`;
  if (utf8NameMatch?.[1]) {
    try {
      fileName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    fileName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`蟾イ荳玖スス ${fileName}`);
}

*/
async function downloadBossNewItemZip() {
  if (!state.token) {
    throw new Error("请先登录");
  }
  let response;
  try {
    response = await fetch("/api/inventory/boss-newitem-zip", {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
  let fileName = `boss_newitem_${formatDateForFilename(new Date())}.zip`;
  if (utf8NameMatch?.[1]) {
    try {
      fileName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    fileName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`已下载 ${fileName}`);
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function triggerCsvDownload(fileName, rows) {
  const csvContent = `\uFEFF${rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n")}`;
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

async function downloadInventorySkuSummaryCsv() {
  await downloadAuthorizedFile("/skus/export-excel", {}, "系统所有产品SKU.xlsx");
  return;
  if (!state.token) {
    throw new Error("请先登录系统");
  }
  if (!Array.isArray(state.inventorySkus) || state.inventorySkus.length === 0) {
    await loadInventory({ preserveSearch: true });
  }

  const rows = [
    ["产品ID", "型号", "品牌", "类型", "颜色", "店铺", "备注", "SKU", "ASIN", "FNSKU", "FBMSKU", "rbSKU", "库存总数"],
  ];
  const list =
    Array.isArray(state.inventorySortedSkus) && state.inventorySortedSkus.length
      ? state.inventorySortedSkus
      : Array.isArray(state.inventorySkus)
        ? [...state.inventorySkus]
        : [];

  list.forEach((sku) => {
    rows.push([
      displayText(sku?.productId),
      displayText(sku?.model),
      displayText(sku?.brand),
      displayText(sku?.type),
      displayText(sku?.color),
      displayText(sku?.shop),
      displayText(sku?.remark),
      displayText(sku?.sku),
      displayText(sku?.asin),
      displayText(sku?.fnsku),
      displayText(sku?.fbmSku),
      displayText(sku?.rbSku),
      Number(state.inventoryTotalsBySku?.[String(sku?.id)] ?? 0),
    ]);
  });

  const fileName = `inventory_sku_summary_${formatDateForFilename(new Date())}.csv`;
  triggerCsvDownload(fileName, rows);
  showToast(`已下载 ${fileName}`);
}

async function downloadUnmatchedInventorySkuSummaryCsv() {
  await downloadAuthorizedFile("/skus/export-unmatched-excel", {}, "未匹配产品ID的SKU.xlsx");
}

async function downloadFbaOutboundExcel() {
  if (!state.token) {
    throw new Error("请先登录");
  }
  let response;
  try {
    response = await fetch("/api/inventory/fba-replenishments/outbound-excel", {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
  let fileName = `fba_outbound_${formatDateForFilename(new Date())}.xlsx`;
  if (utf8NameMatch?.[1]) {
    try {
      fileName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    fileName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`已下载 ${fileName}`);
}

async function downloadBatchInboundTemplate() {
  if (!state.token) {
    throw new Error("请先登录");
  }
  let response;
  try {
    response = await fetch("/api/batch-inbound/upload-template", {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename="?([^";]+)"?/i);
  let fileName = "批量入库.xlsx";
  if (utf8NameMatch?.[1]) {
    try {
      fileName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    fileName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`已下载模板 ${fileName}`);
}

async function downloadSkuUploadTemplate() {
  if (!state.token) {
    throw new Error("请先登录");
  }
  let response;
  try {
    response = await fetch("/api/skus/upload-template", {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename="?([^";]+)"?/i);
  let fileName = "批量上传SKU.xlsx";
  if (utf8NameMatch?.[1]) {
    try {
      fileName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    fileName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`已下载模板 ${fileName}`);
}

async function downloadInventoryUpdateTemplate() {
  if (!state.token) {
    throw new Error("请先登录");
  }
  let response;
  try {
    response = await fetch("/api/inventory/bulk-update-template", {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
  let fileName = "批量更新库存.xlsx";
  if (utf8NameMatch?.[1]) {
    try {
      fileName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    fileName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`已下载模板 ${fileName}`);
}

function getStatusText(status) {
  return Number(status) === 1 ? "启用" : "禁用";
}

function getRoleText(role) {
  const code = String(role || "");
  const item = state.roleOptions.find((option) => option.code === code);
  if (item?.name) return item.name;
  if (code === "system_admin") return "\u7cfb\u7edf\u7ba1\u7406\u5458";
  return code === "admin" ? "\u7ba1\u7406\u8005" : "\u5458\u5de5";
}

function hasAdminAccess(role) {
  return ["admin", "system_admin"].includes(String(role || ""));
}

function isCurrentUserSystemAdmin() {
  return String(state.me?.role || "") === "system_admin" && Number(state.me?.status ?? 0) === 1;
}

function getDepartmentText(department) {
  const code = String(department || "");
  if (!code) return "";
  const item = state.departmentOptions.find((option) => option.code === code);
  if (item?.name) return item.name;
  if (code === "factory") return "工厂";
  if (code === "overseas_warehouse") return "海外仓";
  return "中国仓";
}

function sortUserOptions(options) {
  return [...(Array.isArray(options) ? options : [])].sort((a, b) => {
    const sortA = Number(a?.sort ?? 0);
    const sortB = Number(b?.sort ?? 0);
    if (sortA !== sortB) return sortA - sortB;
    return String(a?.code || "").localeCompare(String(b?.code || ""));
  });
}

function getDepartmentOptionsWithFallback() {
  const items = state.departmentOptions.length ? state.departmentOptions : DEFAULT_DEPARTMENT_OPTIONS;
  return sortUserOptions(items);
}

function getRoleOptionsWithFallback() {
  const items = state.roleOptions.length ? state.roleOptions : DEFAULT_ROLE_OPTIONS;
  return sortUserOptions(items);
}

function getAssignableRoleOptions() {
  return getRoleOptionsWithFallback().filter((item) => String(item?.code || "") !== "system_admin");
}

function getAvailableDepartmentOptionItems() {
  return getDepartmentOptionsWithFallback().filter((item) => Number(item?.status) !== 1);
}

function getAvailableRoleOptionItems() {
  return getRoleOptionsWithFallback().filter((item) => Number(item?.status) !== 1);
}

function isUserOptionEnabled(options, code) {
  const target = String(code || "");
  const item = (Array.isArray(options) ? options : []).find(
    (option) => String(option?.code || "") === target,
  );
  if (!item) return true;
  return Number(item.status) === 1;
}

function normalizeProductEditChangedFields(changedFields) {
  const allowed = new Set([
    "productId",
    "rbSku",
    "asin",
    "fnsku",
    "fbmSku",
    "model",
    "brand",
    "type",
    "color",
    "shop",
    "remark",
  ]);
  return Array.from(
    new Set(
      (Array.isArray(changedFields) ? changedFields : [])
        .map((field) => String(field || "").trim())
        .filter((field) => allowed.has(field)),
    ),
  );
}

function getProductEditRequestSkuText(item) {
  const currentSku = String(item?.sku?.sku || "").trim();
  if (currentSku) return currentSku;
  const afterSku = String(item?.afterData?.sku || "").trim();
  if (afterSku) return afterSku;
  const beforeSku = String(item?.beforeData?.sku || "").trim();
  if (beforeSku) return beforeSku;
  return "-";
}

function canCurrentUserConfirmFactoryProductEditRequest() {
  const user = state.me;
  if (!user) return false;
  if (!hasAdminAccess(user.role)) return false;
  if (Number(user.status) !== 1) return false;

  const roleEnabled = isUserOptionEnabled(getRoleOptionsWithFallback(), String(user.role || ""));
  if (!roleEnabled) return false;
  if (String(user.role || "") === "system_admin") return true;
  if (String(user.department || "") !== "factory") return false;
  const departmentEnabled = isUserOptionEnabled(getDepartmentOptionsWithFallback(), "factory");
  return departmentEnabled;
}

function getProductEditConfirmContactMessage() {
  return "请联系佛山工厂管理员确认";
}

function resolveProductEditConfirmPermission(changedFields) {
  void changedFields;
  return {
    allowed: canCurrentUserConfirmFactoryProductEditRequest(),
    message: PRODUCT_EDIT_CONFIRM_PERMISSION_MESSAGE_FACTORY,
    contactMessage: getProductEditConfirmContactMessage(),
  };
}

function hasChineseChars(text) {
  return /[\u3400-\u9FFF]/.test(String(text || ""));
}

function randomDigits(length) {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
}

function buildDefaultPasswordByUsername(username) {
  const normalizedUsername = String(username || "").trim();
  if (!normalizedUsername) {
    return randomDigits(6);
  }
  if (hasChineseChars(normalizedUsername)) {
    return randomDigits(6);
  }
  const safePrefix = normalizedUsername.slice(0, 60);
  return `${safePrefix}${randomDigits(4)}`;
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
  return parseFixedDigits(rawDigits, 3, "箱号");
}

function buildShelfCode(rawDigits) {
  return parseFixedDigits(rawDigits, 2, "货架号");
}

function clearStats() {
  $("statUsers").textContent = "-";
  $("statSkus").textContent = "-";
  $("statShelves").textContent = "-";
  $("statBoxes").textContent = "-";
  $("statInboundDraft").textContent = "-";
}

function buildStrictShelfCode(rawValue) {
  const value = String(rawValue ?? "").trim().toUpperCase();
  if (/^(?:00|[A-Z][0-9])$/.test(value)) {
    return value;
  }
  throw new Error("货架号必须是00或A0格式");
}

function setTextById(id, text) {
  const el = $(id);
  if (el) {
    el.textContent = text;
  }
}

function formatOverviewNumber(value, fractionDigits = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "-";
  }
  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatOverviewRatio(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "-";
  }
  if (numeric >= 999) {
    return "999+";
  }
  return formatOverviewNumber(numeric, 1);
}

function renderOverviewTable(bodyId, html, colspan) {
  const body = $(bodyId);
  if (!body) return;
  body.innerHTML = html || `<tr><td colspan="${colspan}" class="muted">-</td></tr>`;
}

function clearOverviewDashboard() {
  state.overviewDashboard = null;
  $("statUsers").textContent = "-";
  $("statSkus").textContent = "-";
  $("statShelves").textContent = "-";
  $("statBoxes").textContent = "-";
  $("statInboundDraft").textContent = "-";
  [
    "overviewTotalStock",
    "overviewAvailableStock",
    "overviewLockedStock",
    "overviewInTransitStock",
    "overviewOutOfStockSkuCount",
    "overviewLowCoverageSkuCount",
    "overviewCoverageDays",
    "overviewAvgDailyOutbound",
    "overviewOutboundQty7d",
    "overviewOutboundQty14d",
    "overviewOutboundQty30d",
    "overviewDemandAvgDailyOutbound",
    "overviewRecommendationCount",
    "overviewRecommendationUrgentCount",
    "overviewRecommendationHighCount",
    "overviewRecommendationMediumCount",
    "overviewTargetDays",
    "overviewNoSales90Count",
    "overviewNoSales270Count",
  ].forEach((id) => setTextById(id, "-"));
  renderOverviewTable("overviewTopDemandBody", "", 5);
  renderOverviewTable("overviewAnomalyBody", "", 6);
  renderOverviewTable("overviewProductionBody", "", 9);
  renderOverviewTable("overviewNoSales90Body", "", 5);
  renderOverviewTable("overviewNoSales270Body", "", 5);
}

function renderOverviewDashboard(data) {
  const summary = data?.summary || {};
  const health = data?.health || {};
  const demand = data?.demand || {};
  const production = data?.production || {};
  const obsolete = data?.obsolete || {};

  setTextById("statUsers", formatOverviewNumber(summary.activeUserCount));
  setTextById("statSkus", formatOverviewNumber(summary.activeProductCount));
  setTextById("statShelves", formatOverviewNumber(summary.shelfCount));
  setTextById("statBoxes", formatOverviewNumber(summary.boxCount));
  setTextById("statInboundDraft", formatOverviewNumber(summary.pendingInboundOrderCount));

  setTextById("overviewTotalStock", formatOverviewNumber(health.totalStock));
  setTextById("overviewAvailableStock", formatOverviewNumber(health.availableStock));
  setTextById("overviewLockedStock", formatOverviewNumber(health.lockedStock));
  setTextById("overviewInTransitStock", formatOverviewNumber(health.inTransitStock));
  setTextById("overviewOutOfStockSkuCount", formatOverviewNumber(health.outOfStockSkuCount));
  setTextById("overviewLowCoverageSkuCount", formatOverviewNumber(health.lowCoverageSkuCount));
  setTextById("overviewCoverageDays", formatOverviewRatio(health.coverageDays));
  setTextById("overviewAvgDailyOutbound", formatOverviewNumber(health.avgDailyOutbound, 1));

  setTextById("overviewOutboundQty7d", formatOverviewNumber(demand.outboundQty7d));
  setTextById("overviewOutboundQty14d", formatOverviewNumber(demand.outboundQty14d));
  setTextById("overviewOutboundQty30d", formatOverviewNumber(demand.outboundQty30d));
  setTextById("overviewDemandAvgDailyOutbound", formatOverviewNumber(demand.avgDailyOutbound, 1));

  setTextById("overviewRecommendationCount", formatOverviewNumber(production.recommendationCount));
  setTextById("overviewRecommendationUrgentCount", formatOverviewNumber(production.urgentCount));
  setTextById("overviewRecommendationHighCount", formatOverviewNumber(production.highCount));
  setTextById("overviewRecommendationMediumCount", formatOverviewNumber(production.mediumCount));
  setTextById("overviewTargetDays", formatOverviewNumber(production.targetDays));
  setTextById("overviewNoSales90Count", formatOverviewNumber(obsolete.noSales90dCount));
  setTextById("overviewNoSales270Count", formatOverviewNumber(obsolete.noSales270dCount));

  const topRows = (Array.isArray(demand.topSkus) ? demand.topSkus : [])
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(displayText(item.productId))}</td>
        <td>${escapeHtml(displayText(item.productName))}</td>
        <td>${formatOverviewNumber(item.totalStock)}</td>
        <td>${formatOverviewNumber(item.qty30d)}</td>
        <td>${formatOverviewNumber(item.avgDailyOutbound, 1)}</td>
      </tr>
    `,
    )
    .join("");
  renderOverviewTable("overviewTopDemandBody", topRows, 5);

  const anomalyRows = (Array.isArray(demand.anomalySkus) ? demand.anomalySkus : [])
    .map((item) => {
      const ratio = Number(item.ratio);
      const ratioText = Number.isFinite(ratio) ? `${formatOverviewNumber(ratio, 2)}x` : "NEW";
      return `
      <tr>
        <td>${escapeHtml(displayText(item.productId))}</td>
        <td>${escapeHtml(displayText(item.productName))}</td>
        <td>${formatOverviewNumber(item.totalStock)}</td>
        <td>${formatOverviewNumber(item.qty7d)}</td>
        <td>${formatOverviewNumber(item.prev7d)}</td>
        <td>${ratioText}</td>
      </tr>
    `;
    })
    .join("");
  renderOverviewTable("overviewAnomalyBody", anomalyRows, 6);

  const productionRows = (Array.isArray(production.recommendations) ? production.recommendations : [])
    .map((item) => {
      const priority = displayText(item.priority);
      const priorityClass =
        priority === "紧急" ? "urgent" : priority === "高" ? "high" : priority === "中" ? "medium" : "normal";
      return `
      <tr>
        <td>${escapeHtml(displayText(item.productId))}</td>
        <td>${escapeHtml(displayText(item.productName))}</td>
        <td>${formatOverviewNumber(item.totalStock)}</td>
        <td>${formatOverviewNumber(item.availableStock)}</td>
        <td>${formatOverviewNumber(item.inTransitStock)}</td>
        <td>${formatOverviewNumber(item.avgDailyOutbound, 1)}</td>
        <td>${formatOverviewRatio(item.coverageDays)}</td>
        <td>${formatOverviewNumber(item.suggestedProductionQty)}</td>
        <td><span class="priority-chip priority-${priorityClass}">${escapeHtml(priority)}</span></td>
      </tr>
    `;
    })
    .join("");
  renderOverviewTable("overviewProductionBody", productionRows, 9);

  const noSales90Rows = (Array.isArray(obsolete.noSales90dSkus) ? obsolete.noSales90dSkus : [])
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(displayText(item.productId))}</td>
        <td>${escapeHtml(displayText(item.productName))}</td>
        <td>${formatOverviewNumber(item.totalStock)}</td>
        <td>${formatOverviewNumber(item.availableStock)}</td>
        <td>${formatOverviewNumber(item.inTransitStock)}</td>
      </tr>
    `,
    )
    .join("");
  renderOverviewTable("overviewNoSales90Body", noSales90Rows, 5);

  const noSales270Rows = (Array.isArray(obsolete.noSales270dSkus) ? obsolete.noSales270dSkus : [])
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(displayText(item.productId))}</td>
        <td>${escapeHtml(displayText(item.productName))}</td>
        <td>${formatOverviewNumber(item.totalStock)}</td>
        <td>${formatOverviewNumber(item.availableStock)}</td>
        <td>${formatOverviewNumber(item.inTransitStock)}</td>
      </tr>
    `,
    )
    .join("");
  renderOverviewTable("overviewNoSales270Body", noSales270Rows, 5);
}

async function loadOverviewDashboard() {
  const data = await request("/inventory/dashboard");
  state.overviewDashboard = data || null;
  renderOverviewDashboard(state.overviewDashboard);
}

function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const digits = idx === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[idx]}`;
}

function renderDataBackupTable() {
  const body = $("dataBackupBody");
  if (!body) return;
  const rows = Array.isArray(state.dataBackups) ? state.dataBackups : [];
  const visibleCount = Math.max(state.inventoryPageSize, Number(state.dataBackupsVisibleCount || 0));
  const visibleRows = rows.slice(0, visibleCount);
  body.innerHTML =
    visibleRows
      .map((item) => {
        const fileName = String(item?.fileName || "");
        const hasFile = Boolean(item?.hasFile);
        const action = hasFile
          ? `<button class="tiny-btn" data-action="downloadDataBackup" data-file-name="${escapeHtml(fileName)}">下载</button>`
          : '<span class="muted">仅记录</span>';
        return `
      <tr>
        <td>${escapeHtml(formatDate(item?.createdAt))}</td>
        <td>${escapeHtml(displayText(fileName))}</td>
        <td>${escapeHtml(formatFileSize(item?.sizeBytes))}</td>
        <td>${action}</td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="4" class="muted">暂无备份记录</td></tr>';
}

async function loadDataBackups() {
  const rows = await request("/backups");
  state.dataBackups = Array.isArray(rows) ? rows : [];
  state.dataBackupsVisibleCount = state.inventoryPageSize;
  renderDataBackupTable();
}

function loadMoreDataBackupsIfNeeded() {
  const panel = $("dataBackup");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.dataBackupsVisibleCount >= state.dataBackups.length) return;
  state.dataBackupsVisibleCount += state.inventoryPageSize;
  renderDataBackupTable();
}

async function runDataBackupNow(button) {
  await withBusyButton(button, "备份中...", async () => {
    const result = await request("/backups/run", { method: "POST" });
    await loadDataBackups();
    showToast(`备份完成：${displayText(result?.fileName)}`);
  });
}

async function downloadDataBackup(fileName) {
  const normalizedFileName = String(fileName || "").trim();
  if (!normalizedFileName) {
    throw new Error("缺少备份文件名");
  }
  if (!state.token) {
    throw new Error("请先登录");
  }

  let response;
  try {
    response = await fetch(`/api/backups/${encodeURIComponent(normalizedFileName)}/download`, {
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
    });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    throw new Error(normalizeErrorMessage(message));
  }

  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
  let downloadName = normalizedFileName;
  if (utf8NameMatch?.[1]) {
    try {
      downloadName = decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  } else if (plainNameMatch?.[1]) {
    downloadName = plainNameMatch[1];
  }

  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = downloadName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  showToast(`已下载备份 ${downloadName}`);
}

function displayText(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  return String(value);
}

function hydrateResponsiveTableLabels(root = document) {
  if (!root || typeof document === "undefined") return;
  const tables = [];
  if (typeof root.matches === "function" && root.matches("table")) {
    tables.push(root);
  }
  if (typeof root.querySelectorAll === "function") {
    tables.push(
      ...root.querySelectorAll(
        ".master-product-table-wrap table, .overview-table-wrap table, .manage-table-scroll table",
      ),
    );
  }

  tables.forEach((table) => {
    const headers = Array.from(table.querySelectorAll("thead th")).map((cell) =>
      String(cell.textContent || "").trim().replace(/\s+/g, " "),
    );
    if (!headers.length) return;
    table.querySelectorAll("tbody tr").forEach((row) => {
      Array.from(row.children).forEach((cell, index) => {
        if (!cell || String(cell.tagName || "").toLowerCase() !== "td") return;
        if (Number(cell.getAttribute("colspan") || cell.colSpan || 1) > 1) {
          cell.removeAttribute("data-label");
          return;
        }
        const label = headers[index] || "";
        if (label) {
          cell.setAttribute("data-label", label);
        } else {
          cell.removeAttribute("data-label");
        }
      });
    });
  });
}

function scheduleResponsiveTableLabelHydration() {
  if (responsiveTableLabelFrame) return;
  responsiveTableLabelFrame = requestAnimationFrame(() => {
    responsiveTableLabelFrame = 0;
    hydrateResponsiveTableLabels();
  });
}

function setupResponsiveTableLabels() {
  hydrateResponsiveTableLabels();
  if (typeof MutationObserver !== "function" || responsiveTableLabelObserver) return;
  responsiveTableLabelObserver = new MutationObserver((mutations) => {
    const shouldHydrate = mutations.some((mutation) => {
      if (mutation.type !== "childList") return false;
      return Array.from(mutation.addedNodes).some((node) => {
        if (!node || node.nodeType !== 1) return false;
        if (typeof node.matches === "function" && node.matches("table, tr, td, th")) {
          return true;
        }
        return (
          typeof node.querySelector === "function" &&
          Boolean(node.querySelector("table, tr, td, th"))
        );
      });
    });
    if (shouldHydrate) {
      scheduleResponsiveTableLabelHydration();
    }
  });
  responsiveTableLabelObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function collapseQuickActions() {
  const quickActions = $("employeeQuickActions");
  const toggle = $("toggleQuickActionsBtn");
  if (!quickActions || !toggle) return;
  quickActions.classList.remove("expanded");
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "更多功能";
}

function applyRoleView() {
  const layout = document.querySelector(".layout");
  const quickActions = $("employeeQuickActions");
  const quickActionsToggle = $("toggleQuickActionsBtn");
  const isLoggedIn = Boolean(state.me);
  const isEmployee = Boolean(state.me?.role === "employee");
  const canEditOrders = canCurrentUserEditOrders();

  if (layout) {
    layout.classList.toggle("no-sidebar", isEmployee);
  }
  if (quickActions) {
    quickActions.classList.toggle("hidden", !isLoggedIn);
    if (!isLoggedIn) {
      quickActions.classList.remove("expanded");
    }
  }
  if (quickActionsToggle) {
    quickActionsToggle.classList.toggle("hidden", !isLoggedIn);
    if (!isLoggedIn) {
      quickActionsToggle.setAttribute("aria-expanded", "false");
      quickActionsToggle.textContent = "更多功能";
    }
  }
  document.querySelectorAll(".admin-order-edit-only").forEach((node) => {
    node.classList.toggle("hidden", !canEditOrders);
  });
  if (!canEditOrders) {
    document
      .querySelectorAll("button[data-action='editRakutenOrder'], button[data-action='editAmazonOrder']")
      .forEach((button) => button.remove());
  }
}

function setAuthGate(isLoggedIn) {
  applyInitialAuthStateAttribute(Boolean(isLoggedIn));
  $("loginGate").classList.toggle("hidden", isLoggedIn);
  $("appTopbar").classList.toggle("hidden", !isLoggedIn);
  $("appLayout").classList.toggle("hidden", !isLoggedIn);
}

function setInventoryDisplayMode(searchMode) {
  state.inventorySearchMode = searchMode;
  const listSection = $("inventoryListSection");
  const searchSection = $("inventorySearchSection");
  const backBtn = $("backToInventoryListBtn");
  if (listSection) listSection.classList.toggle("hidden", searchMode);
  if (searchSection) searchSection.classList.toggle("hidden", !searchMode);
  if (backBtn) backBtn.classList.toggle("hidden", !searchMode);
}

function resetInventorySearchState() {
  state.inventorySearchKeyword = "";
  state.inventorySearchPage = 0;
  state.inventorySearchHasMore = false;
  state.inventorySearchLoading = false;
  state.inventorySearchSkus = [];
  state.inventorySearchLocationMap = new Map();
  state.inventorySearchBoxSkuMap = new Map();
}

function focusInventorySearch() {
  const panel = $("inventory");
  if (!panel || !panel.classList.contains("active")) return;
  const input = $("inventoryKeyword");
  if (!input || document.activeElement === input) return;
  setTimeout(() => input.focus(), 0);
}

async function openInventoryHomeDefault({ markAsUserNavigation = false } = {}) {
  switchPanel("inventory", { markAsUserNavigation });
  const keywordInput = $("inventoryKeyword");
  if (keywordInput) {
    keywordInput.value = "";
  }

  state.inventoryHomeKeyword = "";
  state.inventoryHomeSelectedDetail = null;
  setInventoryDisplayMode(false);

  if (state.inventoryHomeProducts.length) {
    renderInventoryTable();
    focusInventorySearch();
    return;
  }

  await loadInventoryHomeProducts({ reset: true });
  focusInventorySearch();
}

async function openInventoryStartupView() {
  if (!state.token) return;
  if (hasUserNavigatedSinceBootstrap) return;
  if (await openPendingMasterProductDetailFromUrl()) return;
  if (hasUserNavigatedSinceBootstrap) return;
  await openInventoryHomeDefault();
}

function switchPanel(targetId, { markAsUserNavigation = true } = {}) {
  if (markAsUserNavigation && state.token) {
    hasUserNavigatedSinceBootstrap = true;
  }
  document.querySelectorAll(".nav-btn").forEach((button) => button.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));

  const button = document.querySelector(`.nav-btn[data-target="${targetId}"]`);
  if (button) button.classList.add("active");

  const panel = $(targetId);
  if (panel) panel.classList.add("active");
  if (targetId === "inventory") {
    focusInventorySearch();
    return;
  }
  if (targetId === "users" && hasAdminAccess(state.me?.role) && !state.users.length) {
    Promise.all([loadUserOptions(), loadUsers()]).catch((error) => showToast(error.message, true));
    return;
  }
  if (targetId === "audit" && hasAdminAccess(state.me?.role) && !state.auditLogs.length) {
    loadAudit().catch((error) => showToast(error.message, true));
    return;
  }
  if (targetId === "rakutenOrderImport" && state.token && !state.orders.length) {
    loadOrders().catch((error) => showToast(error.message, true));
    return;
  }
  if (targetId === "amazonOrderImport" && state.token && !state.amazonOrders.length) {
    loadAmazonOrders().catch((error) => showToast(error.message, true));
    return;
  }
  if (targetId === "manualOrderProcessing" && state.token && !state.manualOrders.length) {
    loadManualOrders().catch((error) => showToast(error.message, true));
    return;
  }
  if (targetId === "overseasOrderProcessing" && state.token) {
    Promise.all([
      state.overseasOrderProcessingOrders.length ? Promise.resolve() : loadOverseasOrderProcessingOrders(),
    ]).catch((error) => showToast(error.message, true));
    return;
  }
  if (targetId === "chinaOrderProcessing" && state.token) {
    Promise.all([
      state.chinaOrderProcessingOrders.length ? Promise.resolve() : loadChinaOrderProcessingOrders(),
    ]).catch((error) => showToast(error.message, true));
    return;
  }
  if (targetId === "overseasPickingBatchManagement" && state.token) {
    Promise.all([loadOverseasPickingBatches(), loadYamatoShipmentBatches()]).catch((error) => showToast(error.message, true));
    return;
  }
  if (targetId === "overview" && !state.overviewDashboard) {
    loadOverviewDashboard().catch((error) => showToast(error.message, true));
  }
}

function ensureBrandingUi() {
  document.title = "日本乐天库存系统2.0";
  document.querySelectorAll(".brand-title").forEach((node) => {
    node.textContent = "日本乐天库存系统2.0";
  });
}

function ensureInventoryPanelUi() {
  const bulkUploadButton = $("openBulkSkuUploadModal");
  if (!bulkUploadButton) return;
  if ($("downloadInventorySkuSummaryBtn")) return;

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.id = "downloadInventorySkuSummaryBtn";
  downloadButton.textContent = "下载系统所有产品";
  downloadButton.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "下载中...", async () => {
        await downloadInventorySkuSummaryCsv();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });
  const unmatchedDownloadButton = document.createElement("button");
  unmatchedDownloadButton.type = "button";
  unmatchedDownloadButton.id = "downloadUnmatchedInventorySkuSummaryBtn";
  unmatchedDownloadButton.textContent = "未匹配产品ID的SKU下载";
  unmatchedDownloadButton.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "下载中...", async () => {
        await downloadUnmatchedInventorySkuSummaryCsv();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });
  const shopManageButton = $("openShopManageModal");
  if (shopManageButton) {
    shopManageButton.insertAdjacentElement("afterend", downloadButton);
    downloadButton.insertAdjacentElement("afterend", unmatchedDownloadButton);
    return;
  }
  bulkUploadButton.insertAdjacentElement("afterend", downloadButton);
  downloadButton.insertAdjacentElement("afterend", unmatchedDownloadButton);
}

function ensureBossStockAdjustmentUi() {
  const originalButton = $("downloadStockAdjustmentCsvBtn");
  if (!originalButton || originalButton.dataset.bound === "boss-filter") return;

  const button = originalButton.cloneNode(true);
  button.dataset.bound = "boss-filter";
  originalButton.replaceWith(button);
  button.addEventListener("click", async () => {
    try {
      await openBossStockAdjustmentModal();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  const form = $("bossStockAdjustmentForm");
  if (form && !form.dataset.bound) {
    form.dataset.bound = "true";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = getSubmitButton(event.currentTarget, event);
      try {
        await withBusyButton(submitButton, "下载中...", async () => {
          await downloadStockAdjustmentCsv(getSelectedBossStockAdjustmentProductTypes());
          closeModal("bossStockAdjustmentModal");
        });
      } catch (error) {
        showToast(error.message, true);
      }
    });
  }
}

function ensureBossMappingDownloadUi() {
  const originalButton = $("downloadBossMappingCsvBtn");
  if (!originalButton || originalButton.dataset.bound === "boss-mapping") return;

  const button = originalButton.cloneNode(true);
  button.dataset.bound = "boss-mapping";
  originalButton.replaceWith(button);
  button.addEventListener("click", async () => {
    try {
      await withBusyButton(button, "下载中...", async () => {
        await downloadBossMappingCsv();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

function ensureBossNewItemDownloadUi() {
  const mappingButton = $("downloadBossMappingCsvBtn");
  if (!mappingButton) return;

  let button = $("downloadBossNewItemZipBtn");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.id = "downloadBossNewItemZipBtn";
    button.textContent = "BOSS系统用新增产品csv下载";
    mappingButton.insertAdjacentElement("afterend", button);
  }
}

async function openProductManagementPanelView() {
  switchPanel("productManagement");
  await Promise.all([loadProductEditRequests({ reset: true }), loadProductEditPendingSummary()]);
}

async function navigateToProductManagement() {
  const entryButton = $("openProductManagementPanel");
  if (entryButton) {
    entryButton.click();
    return;
  }
  await openProductManagementPanelView();
}

function openModal(modalId) {
  const modal = $(modalId);
  if (!modal) return;
  modalZIndexSeed += 1;
  modal.style.zIndex = String(modalZIndexSeed);
  modal.classList.remove("hidden");
}

function closeModal(modalId) {
  const modal = $(modalId);
  if (!modal) return;
  modal.classList.add("hidden");
  modal.style.zIndex = "";
}

function openGlobalLoading(message = "读取中，请稍候...") {
  const overlay = $("globalLoadingOverlay");
  const messageEl = $("globalLoadingMessage");
  if (messageEl) {
    messageEl.textContent = String(message || "读取中，请稍候...");
  }
  if (!overlay) return;
  overlay.style.zIndex = "9999";
  overlay.classList.remove("hidden");
}

function closeGlobalLoading() {
  const overlay = $("globalLoadingOverlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.style.zIndex = "";
}

async function withGlobalLoading(message, task) {
  if (typeof task !== "function") return undefined;
  openGlobalLoading(message);
  try {
    return await task();
  } finally {
    closeGlobalLoading();
  }
}

function ensureOverseasWarehouseQueryUi() {
  const actionRow = document.querySelector("#overseasWarehouse .card .action-row");
  const boxManageForm = $("boxManageForm");
  const shelfManageForm = $("shelfManageForm");
  let boxQueryBtn = $("openBoxContentQueryModal");
  if (!boxQueryBtn) {
    boxQueryBtn = document.createElement("button");
    boxQueryBtn.type = "button";
    boxQueryBtn.id = "openBoxContentQueryModal";
  }
  boxQueryBtn.textContent = "箱内主商品查询";
  if (boxManageForm && boxQueryBtn) {
    boxQueryBtn.classList.add("small-btn", "manage-create-btn");
    const createBtn = $("openCreateBoxFromManage");
    boxManageForm.insertBefore(boxQueryBtn, createBtn || null);
  }

  let shelfQueryBtn = $("openShelfBoxQueryModal");
  if (!shelfQueryBtn) {
    shelfQueryBtn = document.createElement("button");
    shelfQueryBtn.type = "button";
    shelfQueryBtn.id = "openShelfBoxQueryModal";
  }
  shelfQueryBtn.textContent = "货架内主商品查询";
  if (shelfManageForm && shelfQueryBtn) {
    shelfQueryBtn.classList.add("small-btn", "manage-create-btn");
    const createBtn = $("openCreateShelfFromManage");
    shelfManageForm.insertBefore(shelfQueryBtn, createBtn || null);
  } else if (actionRow && shelfQueryBtn && !shelfQueryBtn.parentElement) {
    actionRow.insertBefore(shelfQueryBtn, $("downloadStockAdjustmentCsvBtn") || null);
  }

  if (!$("boxContentQueryModal")) {
    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <div id="boxContentQueryModal" class="modal hidden">
          <div class="modal-card modal-wide modal-manage modal-manage-scroll">
            <div class="modal-head">
              <h3>箱内主商品查询</h3>
              <button type="button" class="ghost" data-action="closeBoxContentQueryModal">关闭</button>
            </div>
            <form id="boxContentQueryForm" class="manage-inline-form manage-inline-form-triple">
              <input id="boxContentQueryBoxCode" inputmode="numeric" maxlength="16" placeholder="请输入箱号" required />
              <button type="submit" class="small-btn manage-create-btn">查询</button>
              <div id="boxContentQuerySummary" class="muted manage-query-summary">请输入箱号后查询。</div>
            </form>
            <div class="manage-table-scroll">
              <table>
                <thead><tr><th>箱号</th><th>货架号</th><th>产品ID</th><th>产品名称</th><th>数量</th><th>操作</th></tr></thead>
                <tbody id="boxContentQueryBody">
                  <tr><td colspan="6" class="muted">请输入箱号后查询。</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `,
    );
  }

  if (!$("shelfBoxQueryModal")) {
    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <div id="shelfBoxQueryModal" class="modal hidden">
          <div class="modal-card modal-wide modal-manage modal-manage-scroll">
            <div class="modal-head">
              <h3>货架内主商品查询</h3>
              <button type="button" class="ghost" data-action="closeShelfBoxQueryModal">关闭</button>
            </div>
            <form id="shelfBoxQueryForm" class="manage-inline-form manage-inline-form-triple">
              <input id="shelfBoxQueryShelfCode" inputmode="text" maxlength="16" placeholder="请输入货架号（00或A0）" required />
              <button type="submit" class="small-btn manage-create-btn">查询</button>
              <div id="shelfBoxQuerySummary" class="muted manage-query-summary">请输入货架号后查询。</div>
            </form>
            <div class="manage-table-scroll">
              <table>
                <thead><tr><th>箱号</th><th>产品ID</th><th>产品名称</th><th>数量</th></tr></thead>
                <tbody id="shelfBoxQueryBody">
                  <tr><td colspan="4" class="muted">请输入货架号后查询。</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `,
    );
  }

  if (!$("stocktakeTaskDetailModal")) {
    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <div id="stocktakeTaskDetailModal" class="modal hidden">
          <div class="modal-card modal-wide modal-manage modal-manage-scroll">
            <div class="modal-head">
              <h3>库存盘点明细</h3>
              <div class="panel-tools">
                <button type="button" class="ghost" id="printStocktakeTaskDetailBtn">打印</button>
                <button type="button" class="ghost" data-action="closeStocktakeTaskDetailModal">关闭</button>
              </div>
            </div>
              <div id="stocktakeTaskDetailMeta" class="batch-detail-meta"></div>
              <div id="stocktakeTaskDetailSummary" class="muted manage-query-summary">请选择盘点任务后查看。</div>
              <div class="manage-table-scroll">
                <table>
                  <thead><tr><th>箱号</th><th>产品ID</th><th>产品名称</th><th>数量</th></tr></thead>
                  <tbody id="stocktakeTaskDetailBody">
                    <tr><td colspan="4" class="muted">请选择盘点任务后查看。</td></tr>
                  </tbody>
                </table>
              </div>
          </div>
        </div>
      `,
    );
  }

  const shelfQueryModalHead = document.querySelector("#shelfBoxQueryModal .modal-head");
  const shelfQueryCloseBtn = shelfQueryModalHead?.querySelector("[data-action='closeShelfBoxQueryModal']");
  if (shelfQueryModalHead && shelfQueryCloseBtn && !$("printShelfBoxQueryLabelsBtn")) {
    const tools = document.createElement("div");
    tools.className = "panel-tools";
    const printBtn = document.createElement("button");
    printBtn.type = "button";
    printBtn.id = "printShelfBoxQueryLabelsBtn";
    printBtn.className = "";
    printBtn.textContent = "批量打印";
    printBtn.disabled = true;
    shelfQueryCloseBtn.replaceWith(tools);
    tools.appendChild(printBtn);
    tools.appendChild(shelfQueryCloseBtn);
  }
}

function ensureOrderProcessingLandingUi() {
  const legacyOrdersWrap = $("ordersTableWrap");
  if (!legacyOrdersWrap) return;
  legacyOrdersWrap.textContent = "";
  legacyOrdersWrap.classList.add("order-processing-landing-wrap");
  const actions = document.createElement("div");
  actions.className = "actions order-import-actions order-processing-exit-actions";
  const overseasBtn = document.createElement("button");
  overseasBtn.type = "button";
  overseasBtn.id = "openOverseasOrderProcessingPanel";
  overseasBtn.textContent = "\u6D77\u5916\u4ED3\u8BA2\u5355\u5904\u7406";
  actions.appendChild(overseasBtn);
  const chinaBtn = document.createElement("button");
  chinaBtn.type = "button";
  chinaBtn.id = "openChinaOrderProcessingPanel";
  chinaBtn.textContent = "\u4E2D\u56FD\u8BA2\u5355\u5904\u7406";
  actions.appendChild(chinaBtn);
  legacyOrdersWrap.appendChild(actions);
}

function getSubmitButton(form, event) {
  if (event?.submitter instanceof HTMLButtonElement) {
    return event.submitter;
  }
  if (!form) return null;
  return form.querySelector("button[type='submit']");
}

async function withBusyButton(button, busyText, task) {
  if (typeof task !== "function") return undefined;
  if (!button) return task();
  if (button.dataset.busy === "1") return undefined;

  const previousText = button.textContent;
  const previousDisabled = button.disabled;
  button.dataset.busy = "1";
  button.disabled = true;
  if (busyText) {
    button.textContent = busyText;
  }

  try {
    return await task();
  } finally {
    button.disabled = previousDisabled;
    if (busyText) {
      button.textContent = previousText;
    }
    delete button.dataset.busy;
  }
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

function openActionConfirmModal(messageText, titleText = "确认操作", confirmText = "确认", options = {}) {
  const title = $("actionConfirmTitle");
  const message = $("actionConfirmMessage");
  const okBtn = $("actionConfirmOkBtn");
  const cancelBtn = $("actionConfirmCancelBtn");
  const showCancel = options?.showCancel !== false;
  if (title) {
    title.innerHTML = `<span class="confirm-icon">!</span>${escapeHtml(titleText)}`;
  }
  if (message) {
    message.textContent = String(messageText || "确认执行当前操作？");
  }
  if (okBtn) {
    okBtn.textContent = String(confirmText || "确认");
  }
  if (cancelBtn) {
    cancelBtn.classList.toggle("hidden", !showCancel);
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
  const normalizedPath = String(path || "").trim();
  const isLoginRequest = normalizedPath === "/auth/login";
  const isDeployVersionRequest = normalizedPath === "/auth/deploy-version";
  if (state.token && !isLoginRequest && !isDeployVersionRequest && !options.skipDeployVersionCheck) {
    await ensureAuthDeployVersion();
  }

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
    const requestError = new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
    requestError.status = 0;
    throw requestError;
  }
  const text = await res.text();

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text || "请求失败" };
  }

  if (!res.ok || payload.code !== 0) {
    const message = normalizeErrorMessage(payload.message || `HTTP ${res.status}`);
    if (res.status === 401 && state.token && !isLoginRequest) {
      expireAuthSession(message, path);
      const silentAuthError = new Error(SILENT_AUTH_ERROR_MESSAGE);
      silentAuthError.status = 401;
      silentAuthError.path = path;
      silentAuthError.responseMessage = message;
      throw silentAuthError;
    }
    const shouldSuppressAuthError =
      res.status === 401 && !isLoginRequest && (!state.token || Date.now() < suppressAuthErrorToastUntil);
    if (shouldSuppressAuthError) {
      const silentAuthError = new Error(SILENT_AUTH_ERROR_MESSAGE);
      silentAuthError.status = 401;
      silentAuthError.path = path;
      silentAuthError.responseMessage = message;
      throw silentAuthError;
    }
    const requestError = new Error(message);
    requestError.status = res.status;
    requestError.path = path;
    requestError.responseMessage = message;
    throw requestError;
  }

  return payload.data;
}

async function fetchAuthorizedResponse(path, options = {}) {
  const normalizedPath = String(path || "").trim();
  const shouldSkipDeployVersionCheck = Boolean(options.skipDeployVersionCheck);
  if (state.token && !shouldSkipDeployVersionCheck) {
    await ensureAuthDeployVersion();
  }

  const headers = { ...(options.headers || {}) };
  const isFormData = options.body instanceof FormData;
  if (!isFormData && options.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  let response;
  try {
    response = await fetch(`/api${path}`, { ...options, headers });
  } catch (error) {
    throw new Error(normalizeErrorMessage(error?.message || "Failed to fetch"));
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = text ? JSON.parse(text) : null;
      if (payload?.message) {
        message = payload.message;
      }
    } catch {}
    const normalizedMessage = normalizeErrorMessage(message);
    if (response.status === 401 && state.token) {
      expireAuthSession(normalizedMessage, normalizedPath);
      const silentAuthError = new Error(SILENT_AUTH_ERROR_MESSAGE);
      silentAuthError.status = 401;
      silentAuthError.path = normalizedPath;
      silentAuthError.responseMessage = normalizedMessage;
      throw silentAuthError;
    }
    throw new Error(normalizedMessage);
  }

  return response;
}

function resolveDownloadFileName(response, fallbackName) {
  const disposition = response.headers.get("content-disposition") || "";
  const utf8NameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainNameMatch = disposition.match(/filename="?([^";]+)"?/i);
  if (utf8NameMatch?.[1]) {
    try {
      return decodeURIComponent(utf8NameMatch[1]);
    } catch {}
  }
  if (plainNameMatch?.[1]) {
    return plainNameMatch[1];
  }
  return fallbackName;
}

async function downloadAuthorizedFile(path, options = {}, fallbackName = "download.bin") {
  const response = await fetchAuthorizedResponse(path, options);
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = resolveDownloadFileName(response, fallbackName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  return link.download;
}

function buildDeleteBlockedMessage(entityLabel, reasons) {
  const list = Array.isArray(reasons)
    ? reasons
        .map((item) => String(item || "").trim())
        .filter((item) => Boolean(item))
    : [];
  if (!list.length) {
    return `${entityLabel}存在关联数据，暂时无法删除`;
  }
  return `${entityLabel}暂时无法删除：${list.join("；")}`;
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

function bindShelfCodeInput(id) {
  const input = $(id);
  if (!input) return;
  input.addEventListener("input", () => {
    const normalized = String(input.value || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 2);
    if (input.value !== normalized) {
      input.value = normalized;
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
  bindShelfCodeInput("newShelfCodeDigits");
  bindDigitInput("newBoxCodeDigits", 3);
  bindDigitInput("modalNewBoxCodeDigits", 3);
  bindDigitInput("boxManageCodeInput", 3);
  bindShelfCodeInput("modalNewShelfCodeDigits");
  bindShelfCodeInput("shelfManageCodeInput");
  bindPositiveIntegerInput("batchCollectBoxCount", { min: 1, max: 500 });
  bindBatchNoInput("batchCollectBatchNo");
}

async function loadMe() {
  if (!state.token) {
    state.me = null;
    $("sessionInfo").textContent = "未登录";
    setAuthGate(false);
    applyRoleView();
    renderAuthGateMessage(readPersistedAuthGateMessage());
    return;
  }

  try {
    await ensureAuthDeployVersion();
    state.me = await request("/auth/me", { skipDeployVersionCheck: true });
    $("sessionInfo").textContent = `${state.me.username}`;
    setAuthGate(true);
    applyRoleView();
    persistAuthGateMessage("");
    renderAuthGateMessage("");
  } catch (error) {
    const status = Number(error?.status ?? 0);
    if (status !== 401) {
      state.me = null;
      $("sessionInfo").textContent = "会话校验失败";
      setAuthGate(true);
      applyRoleView();
      throw error;
    }
    if (String(error?.path || "").trim() === "/auth/deploy-version") {
      state.me = null;
      $("sessionInfo").textContent = "登录失效";
      setAuthGate(false);
      applyRoleView();
      renderAuthGateMessage(readPersistedAuthGateMessage());
      return;
    }
    expireAuthSession(error?.responseMessage || error?.message || "未授权，请重新登录", "/auth/me");
  }
}

function renderDepartmentOptionsTable() {
  const body = $("departmentOptionsBody");
  if (!body) return;

  const items = sortUserOptions(getDepartmentOptionsWithFallback()).filter((item) => Number(item.status) === 1);
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="2" class="muted">-</td></tr>';
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const code = String(item.code || "");
      const editing = state.departmentOptionEditingCodes.has(code);
      return `
        <tr data-user-option-kind="departments" data-user-option-code="${escapeHtml(code)}">
          <td>
            <input
              id="departmentOptionName-${escapeHtml(code)}"
              class="tiny-input user-option-input"
              data-field="name"
              maxlength="64"
              value="${escapeHtml(item.name || "")}"
              data-original-name="${escapeHtml(item.name || "")}"
              ${editing ? "" : "readonly"}
            />
          </td>
          <td>
            <div class="action-row">
              <button type="button" class="tiny-btn" data-action="editDepartmentOption">
                ${editing ? "确认变更" : "变更"}
              </button>
              <button type="button" class="tiny-btn danger" data-action="deleteDepartmentOption">删除</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderRoleOptionsTable() {
  const body = $("roleOptionsBody");
  if (!body) return;

  const items = sortUserOptions(getRoleOptionsWithFallback()).filter((item) => Number(item.status) === 1);
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="2" class="muted">-</td></tr>';
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const code = String(item.code || "");
      const editing = state.roleOptionEditingCodes.has(code);
      return `
        <tr data-user-option-kind="roles" data-user-option-code="${escapeHtml(code)}">
          <td>
            <input
              id="roleOptionName-${escapeHtml(code)}"
              class="tiny-input user-option-input"
              data-field="name"
              maxlength="64"
              value="${escapeHtml(item.name || "")}
              " data-original-name="${escapeHtml(item.name || "")}"
              ${editing ? "" : "readonly"}
            />
          </td>
          <td>
            <div class="action-row">
              <button type="button" class="tiny-btn" data-action="editRoleOption">
                ${editing ? "确认变更" : "变更"}
              </button>
              <button type="button" class="tiny-btn danger" data-action="deleteRoleOption">删除</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderUserOptionsTable() {
  renderDepartmentOptionsTable();
  renderRoleOptionsTable();
  renderDepartmentOptionCreateForm();
  renderRoleOptionCreateForm();
}

function renderDepartmentOptionCreateForm() {
  const form = $("departmentOptionCreateForm");
  const nameInput = $("departmentOptionCreateName");
  const submitBtn = form?.querySelector('button[type="submit"]');
  if (!form || !nameInput || !submitBtn) return;
  nameInput.disabled = false;
  nameInput.placeholder = "\u8bf7\u8f93\u5165\u90e8\u95e8\u540d\u79f0";
  submitBtn.disabled = false;
}

function renderRoleOptionCreateForm() {
  const form = $("roleOptionCreateForm");
  const nameInput = $("roleOptionCreateName");
  const submitBtn = form?.querySelector('button[type="submit"]');
  if (!form || !nameInput || !submitBtn) return;
  const options = getAvailableRoleOptionItems();
  nameInput.disabled = false;
  nameInput.placeholder = options.length === 0
    ? "当前没有可新增角色，如需改名请点下方“变更”"
    : "请输入角色名称";
  submitBtn.disabled = false;
}

function renderUserSelectOptions() {
  const newDepartmentEl = $("newDepartment");
  const newRoleEl = $("newRole");
  const editDepartmentEl = $("editUserDepartment");
  const editRoleEl = $("editUserRole");

  if (newDepartmentEl) {
    const selected = newDepartmentEl.value || "china_warehouse";
    const options = getDepartmentOptionsWithFallback().filter((item) => Number(item.status) === 1);
    newDepartmentEl.innerHTML = options
      .map((item) => `<option value="${escapeHtml(item.code)}">${escapeHtml(item.name || item.code)}</option>`)
      .join("");
    if (!newDepartmentEl.value && options.length) {
      newDepartmentEl.value = options[0].code;
    }
    if (options.some((item) => item.code === selected)) {
      newDepartmentEl.value = selected;
    }
  }

  if (newRoleEl) {
    const selected = newRoleEl.value || "employee";
    const options = getAssignableRoleOptions().filter((item) => Number(item.status) === 1);
    newRoleEl.innerHTML = options
      .map((item) => `<option value="${escapeHtml(item.code)}">${escapeHtml(item.name || item.code)}</option>`)
      .join("");
    if (!newRoleEl.value && options.length) {
      newRoleEl.value = options[0].code;
    }
    if (options.some((item) => item.code === selected)) {
      newRoleEl.value = selected;
    }
  }

  if (editDepartmentEl) {
    const selected = editDepartmentEl.value || "china_warehouse";
    const options = getDepartmentOptionsWithFallback().filter((item) => Number(item.status) === 1 || item.code === selected);
    editDepartmentEl.innerHTML = options
      .map((item) => {
        const suffix = Number(item.status) === 1 ? "" : "（禁用）";
        return `<option value="${escapeHtml(item.code)}">${escapeHtml((item.name || item.code) + suffix)}</option>`;
      })
      .join("");
    if (selected && options.some((item) => item.code === selected)) {
      editDepartmentEl.value = selected;
    }
  }

  if (editRoleEl) {
    const selected = editRoleEl.value || "employee";
    const options = getAssignableRoleOptions().filter(
      (item) => Number(item.status) === 1 || item.code === selected,
    );
    editRoleEl.innerHTML = options
      .map((item) => {
        const suffix = Number(item.status) === 1 ? "" : "（禁用）";
        return `<option value="${escapeHtml(item.code)}">${escapeHtml((item.name || item.code) + suffix)}</option>`;
      })
      .join("");
    if (selected && options.some((item) => item.code === selected)) {
      editRoleEl.value = selected;
    }
  }
}

async function loadUserOptions() {
  const data = await request("/user-options");
  const departments = Array.isArray(data?.departments) ? data.departments : [];
  const roles = Array.isArray(data?.roles) ? data.roles : [];
  state.departmentOptions = sortUserOptions(
    departments.map((item) => ({
      code: String(item.code || ""),
      name: String(item.name || ""),
      status: Number(item.status) === 1 ? 1 : 0,
      sort: Number(item.sort ?? 0),
    })),
  );
  state.roleOptions = sortUserOptions(
    roles.map((item) => ({
      code: String(item.code || ""),
      name: String(item.name || ""),
      status: Number(item.status) === 1 ? 1 : 0,
      sort: Number(item.sort ?? 0),
    })),
  );
  const enabledDepartmentCodes = new Set(
    state.departmentOptions.filter((item) => Number(item.status) === 1).map((item) => String(item.code)),
  );
  const enabledRoleCodes = new Set(
    state.roleOptions.filter((item) => Number(item.status) === 1).map((item) => String(item.code)),
  );
  state.departmentOptionEditingCodes = new Set(
    [...state.departmentOptionEditingCodes].filter((code) => enabledDepartmentCodes.has(String(code))),
  );
  state.roleOptionEditingCodes = new Set(
    [...state.roleOptionEditingCodes].filter((code) => enabledRoleCodes.has(String(code))),
  );
  renderUserOptionsTable();
  renderUserSelectOptions();
  if (state.users.length) {
    renderUsersTable();
  }
}

function renderUsersTable() {
  const body = $("usersBody");
  if (!body) return;
  const users = state.users.slice(0, state.usersVisibleCount);
  body.innerHTML =
    users
      .map((user) => {
        const isProtectedUser = String(user.username || "").trim() === "admin";
        const actions = isProtectedUser
          ? ""
          : `
            <button
              type="button"
              class="tiny-btn"
              data-action="editUser"
              data-id="${escapeHtml(user.id)}"
              data-username="${escapeHtml(user.username)}"
              data-role="${escapeHtml(user.role)}"
              data-department="${escapeHtml(user.department || "")}"
              data-status="${escapeHtml(Number(user.status) === 1 ? 1 : 0)}"
            >
              \u7f16\u8f91
            </button>
            <button
              type="button"
              class="tiny-btn"
              data-action="resetUserPassword"
              data-id="${escapeHtml(user.id)}"
              data-username="${escapeHtml(user.username)}"
              data-password-initialized="${user.passwordInitialized ? "1" : "0"}"
            >
              ${user.passwordInitialized ? "\u91cd\u7f6e\u5bc6\u7801" : "\u6fc0\u6d3b\u7528\u6237"}
            </button>`;
        return `
      <tr>
        <td>${escapeHtml(user.username)}</td>
        <td>${escapeHtml(getDepartmentText(user.department))}</td>
        <td>${escapeHtml(getRoleText(user.role))}</td>
        <td>${getStatusText(user.status)}</td>
        <td>${formatDate(user.updatedAt)}</td>
        <td>
          <div class="action-row">${actions}</div>
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="6" class="muted">-</td></tr>';
}

async function loadUsers() {
  const users = await request("/users");
  state.users = Array.isArray(users) ? users : [];
  state.usersById = new Map(state.users.map((user) => [String(user.id), user]));
  state.usersVisibleCount = state.inventoryPageSize;
  $("statUsers").textContent = state.users.length;
  renderUsersTable();
}

function loadMoreUsersIfNeeded() {
  const panel = $("users");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.usersVisibleCount >= state.users.length) return;
  state.usersVisibleCount += state.inventoryPageSize;
  renderUsersTable();
}

function maybeAutoLoadUsers() {
  const panel = $("users");
  if (!panel || !panel.classList.contains("active")) return;
  const tableWrap = $("usersTableWrap");
  if (!tableWrap) return;
  if (state.usersVisibleCount >= state.users.length) return;

  const threshold = 120;
  const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
  if (currentBottom < tableWrap.scrollHeight - threshold) return;

  loadMoreUsersIfNeeded();
}

function setupUsersLoadObserver() {
  if (usersLoadObserver) {
    usersLoadObserver.disconnect();
    usersLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("usersTableWrap");
  const sentinel = $("usersLoadSentinel");
  if (!tableWrap || !sentinel) return;

  usersLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreUsersIfNeeded();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  usersLoadObserver.observe(sentinel);
}

function findUserById(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;
  return state.usersById.get(id) || null;
}

function syncEditUserActionButtons(userId, status, username) {
  const toggleBtn = $("editUserToggleBtn");
  const deleteBtn = $("editUserDeleteBtn");
  const normalizedUserId = String(userId || "").trim();
  const normalizedUsername = String(username || "").trim();
  const normalizedStatus = Number(status) === 1 ? 1 : 0;
  if (toggleBtn) {
    toggleBtn.dataset.id = normalizedUserId;
    toggleBtn.dataset.username = normalizedUsername;
    toggleBtn.dataset.nextStatus = normalizedStatus === 1 ? "0" : "1";
    toggleBtn.textContent = normalizedStatus === 1 ? "禁用" : "启用";
  }
  if (deleteBtn) {
    deleteBtn.dataset.id = normalizedUserId;
    deleteBtn.dataset.username = normalizedUsername;
  }
}

async function toggleUserStatus(userId, username, nextStatus) {
  if (![0, 1].includes(nextStatus)) {
    throw new Error("状态值无效");
  }
  const actionLabel = nextStatus === 1 ? "启用" : "禁用";
  const ok = await openActionConfirmModal(`确认${actionLabel}用户 ${username} 吗？`, `${actionLabel}用户`, actionLabel);
  if (!ok) return false;

  await request(`/users/${encodeURIComponent(userId)}`, {
    method: "PUT",
    body: JSON.stringify({ status: nextStatus }),
  });
  showToast(`用户已${actionLabel}`);
  await Promise.all([loadUsers(), loadAudit()]);

  if (String(state.me?.id || "") === String(userId) && nextStatus !== 1) {
    state.token = "";
    state.me = null;
    clearPersistedAuthToken();
    showToast("当前用户已被禁用，请重新登录");
    await reloadAll();
  }
  return true;
}

async function removeUser(userId, username) {
  const ok = await openDeleteConfirmModal(`确认删除用户 ${username} 吗？`);
  if (!ok) return false;

  await request(`/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
  showToast("用户已删除");
  await Promise.all([loadUsers(), loadAudit()]);

  if (String(state.me?.id || "") === String(userId)) {
    state.token = "";
    state.me = null;
    clearPersistedAuthToken();
    showToast("当前用户已被删除，请重新登录");
      await reloadAll();
  }
  return true;
}

function openEditUserModal(userId, username, role, department, status = 1) {
  state.selectedEditUserId = String(userId);
  $("editUserId").value = String(userId);
  $("editUsername").value = String(username || "");
  renderUserSelectOptions();
  const normalizedRole = ["employee", "admin"].includes(String(role || "")) ? String(role) : "employee";
  $("editUserRole").value = normalizedRole;
  $("editUserDepartment").value = department || "china_warehouse";
  syncEditUserActionButtons(userId, status, username);
  openModal("editUserModal");
}

function openResetUserPasswordModal(userId, username, passwordInitialized) {
  const mode = passwordInitialized ? "reset" : "activate";
  const generatedPassword = buildDefaultPasswordByUsername(username);
  state.selectedResetPasswordUserId = String(userId);
  $("resetPasswordUserId").value = String(userId);
  $("resetPasswordMode").value = mode;
  $("resetPasswordUsername").value = String(username || "");
  $("resetPasswordNewPassword").value = generatedPassword;
  $("resetUserPasswordModalTitle").textContent = mode === "activate" ? "激活用户" : "重置密码";
  $("resetPasswordSubmitBtn").textContent = mode === "activate" ? "确认激活" : "确认重置";
  openModal("resetUserPasswordModal");
}

function resolveSkuProductId(skuOrId) {
  if (skuOrId && typeof skuOrId === "object") {
    const productId = String(skuOrId.productId || "").trim();
    return productId || "";
  }
  const sku = findSkuById(skuOrId);
  return String(sku?.productId || "").trim();
}

async function getSkuInventoryRows(skuOrId) {
  const productId = resolveSkuProductId(skuOrId);
  if (!productId) {
    return [];
  }
  try {
    return await request(`/inventory/master-product-boxes?productId=${encodeURIComponent(productId)}`);
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

function findBoxByAnyCode(raw) {
  const normalized = normalizeBoxCodeInput(raw);
  if (!normalized) return null;
  return (
    (Array.isArray(state.boxes) ? state.boxes : []).find(
      (box) => normalizeBoxCodeInput(box?.boxCode) === normalized,
    ) || null
  );
}

function findShelfByAnyCode(raw) {
  const normalized = normalizeShelfCodeInput(raw);
  if (!normalized) return null;
  return (
    (Array.isArray(state.shelves) ? state.shelves : []).find(
      (shelf) => normalizeShelfCodeInput(shelf?.shelfCode) === normalized,
    ) || null
  );
}

function resetBoxContentQueryResult() {
  const summary = $("boxContentQuerySummary");
  const body = $("boxContentQueryBody");
  if (summary) {
    summary.textContent = "请输入箱号后查询。";
    summary.classList.remove("is-error");
  }
  if (body) {
    body.innerHTML = '<tr><td colspan="6" class="muted">请输入箱号后查询。</td></tr>';
  }
}

function renderBoxContentQueryNotFound(boxCode = "") {
  const summary = $("boxContentQuerySummary");
  const body = $("boxContentQueryBody");
  if (summary) {
    summary.textContent = boxCode ? `未找到箱号 ${boxCode}` : "未找到该箱号";
    summary.classList.add("is-error");
  }
  if (body) {
    body.innerHTML = '<tr><td colspan="6" class="muted">请输入箱号后查询。</td></tr>';
  }
}

function resetShelfBoxQueryResult() {
  const summary = $("shelfBoxQuerySummary");
  const body = $("shelfBoxQueryBody");
  const printButton = $("printShelfBoxQueryLabelsBtn");
  state.selectedShelfBoxQueryShelfCode = "";
  state.selectedShelfBoxQueryRows = [];
  if (summary) {
    summary.textContent = "请输入货架号后查询。";
    summary.classList.remove("is-error");
  }
  if (body) {
    body.innerHTML = '<tr><td colspan="4" class="muted">请输入货架号后查询。</td></tr>';
  }
  if (printButton) {
    printButton.disabled = true;
  }
}

function renderShelfBoxQueryNotFound(shelfCode = "") {
  const summary = $("shelfBoxQuerySummary");
  const body = $("shelfBoxQueryBody");
  const printButton = $("printShelfBoxQueryLabelsBtn");
  state.selectedShelfBoxQueryShelfCode = String(shelfCode || "").trim();
  state.selectedShelfBoxQueryRows = [];
  if (summary) {
    summary.textContent = "未找到该货架号";
    summary.classList.add("is-error");
  }
  if (body) {
    body.innerHTML = '<tr><td colspan="4" class="muted">请输入货架号后查询。</td></tr>';
  }
  if (printButton) {
    printButton.disabled = true;
  }
}

function setQueryModalDirectResultMode(kind, enabled) {
  const isBox = kind === "box";
  const form = $(isBox ? "boxContentQueryForm" : "shelfBoxQueryForm");
  const input = $(isBox ? "boxContentQueryBoxCode" : "shelfBoxQueryShelfCode");
  const submitButton = form?.querySelector("button[type='submit']");

  if (form) {
    form.classList.toggle("manage-inline-form-direct-result", Boolean(enabled));
  }
  if (input) {
    input.classList.toggle("hidden", Boolean(enabled));
  }
  if (submitButton) {
    submitButton.classList.toggle("hidden", Boolean(enabled));
  }
}

async function openBoxContentQueryModalForBoxCode(boxCode, preferredBoxId = "") {
  await Promise.all([loadShelves(), loadBoxes()]);
  const normalizedBoxCode = normalizeBoxCodeInput(boxCode);
  const box =
    (Array.isArray(state.boxes) ? state.boxes : []).find(
      (item) => String(item?.id || "") === String(preferredBoxId || ""),
    ) || findBoxByAnyCode(normalizedBoxCode);
  if (!box) {
    throw new Error("未找到对应箱号");
  }

  setQueryModalDirectResultMode("box", true);
  $("boxContentQueryBoxCode").value = box?.boxCode || normalizedBoxCode;
  const rows = await getBoxSkuInventoryRows(box.id);
  renderBoxContentQueryResult(box, rows);
  openModal("boxContentQueryModal");
}

async function openShelfBoxQueryModalForShelfCode(shelfCode, preferredShelfId = "") {
  await Promise.all([loadShelves(), loadBoxes()]);
  const normalizedShelfCode = normalizeShelfCodeInput(shelfCode);
  const shelf =
    (Array.isArray(state.shelves) ? state.shelves : []).find(
      (item) => String(item?.id || "") === String(preferredShelfId || ""),
    ) || findShelfByAnyCode(normalizedShelfCode);
  setQueryModalDirectResultMode("shelf", true);
  $("shelfBoxQueryShelfCode").value = shelf?.shelfCode || normalizedShelfCode;
  if (!shelf) {
    renderShelfBoxQueryNotFound(normalizedShelfCode);
    openModal("shelfBoxQueryModal");
    return;
  }
  const { boxCount, rows } = await getShelfBoxQueryRows(shelf);
  renderShelfBoxQueryResult(shelf, rows, boxCount);
  openModal("shelfBoxQueryModal");
}

function renderBoxContentQueryActions(box) {
  const actions = [];
  if (box?.canArchiveRelease) {
    actions.push(
      `<button class="tiny-btn secondary" data-action="archiveReleaseBoxQuery" data-id="${escapeHtml(box?.id || "")}" data-code="${escapeHtml(box?.boxCode || "")}">归档释放</button>`,
    );
  }
  if (Number(box?.status ?? 1) === 1) {
    actions.push(
      `<button class="tiny-btn" data-action="editBoxQuery" data-id="${escapeHtml(box?.id || "")}" data-code="${escapeHtml(box?.boxCode || "")}">变更</button>`,
    );
  }
  return actions.join(" ");
}

function renderBoxContentQueryResult(box, rows) {
  const summary = $("boxContentQuerySummary");
  const body = $("boxContentQueryBody");
  if (!summary || !body) return;
  summary.classList.remove("is-error");

  const boxCode = displayText(box?.boxCode);
  const shelfCode = displayText(box?.shelf?.shelfCode || box?.shelfCode);
  const sortedRows = [...(Array.isArray(rows) ? rows : [])].sort((a, b) =>
    String(a?.product?.productId || "").localeCompare(String(b?.product?.productId || ""), "en", { numeric: true }),
  );
  const reasonLines = collectBoxBlockedReasonLines(box);
  const summaryText = (baseText) => (reasonLines.length ? `${baseText}\n${reasonLines.join("\n")}` : baseText);

  if (!sortedRows.length) {
    summary.textContent = summaryText(`箱号 ${boxCode} 当前没有箱内主商品。`);
    body.innerHTML = `
      <tr>
        <td>${escapeHtml(boxCode)}</td>
        <td>${escapeHtml(shelfCode)}</td>
        <td class="muted">-</td>
        <td class="muted">-</td>
        <td class="muted">0</td>
        <td>${renderBoxContentQueryActions(box) || '<span class="muted">-</span>'}</td>
      </tr>
    `;
    return;
  }

  summary.textContent = summaryText(`箱号 ${boxCode} 共 ${sortedRows.length} 个主商品。`);
  body.innerHTML = sortedRows
    .map(
      (row, index) => `
        <tr>
          <td>${escapeHtml(boxCode)}</td>
          <td>${escapeHtml(shelfCode)}</td>
          <td>${renderMasterProductDetailLink(displayText(row?.product?.productId))}</td>
          <td>${escapeHtml(displayText(row?.product?.productName))}</td>
          <td>${escapeHtml(displayText(row?.qty))}</td>
          <td>${index === 0 ? (renderBoxContentQueryActions(box) || '<span class="muted">-</span>') : ""}</td>
        </tr>
      `,
    )
    .join("");
}

async function archiveReleaseBox(boxId, boxCode) {
  const ok = await openActionConfirmModal(
    `确认归档旧箱并释放箱号 ${boxCode} ？`,
    "旧箱会保留历史审计并隐藏，原箱号将重新可用。",
    "归档释放",
  );
  if (!ok) return null;

  const result = await request(`/boxes/${boxId}/archive-release`, { method: "POST" });
  state.boxEditingIds.delete(String(boxId));
  showToast(
    `箱号 ${result?.releasedBoxCode || boxCode} 已释放，旧箱已归档为 ${result?.archivedBoxCode || "-"}`,
  );
  await reloadBoxesAfterManageMutation();
  return result;
}

async function openBoxManageModalForEdit(boxId) {
  const targetId = String(boxId || "").trim();
  if (!targetId) return;

  state.boxEditingIds = new Set([targetId]);
  await Promise.all([loadShelves(), loadBoxes()]);
  const rows = getBoxesSortedForManage();
  const targetIndex = rows.findIndex((item) => String(item?.id || "") === targetId);
  state.boxManageVisibleCount = Math.max(
    state.manageModalInitialPageSize,
    targetIndex >= 0 ? targetIndex + 1 : state.manageModalInitialPageSize,
  );

  renderBoxesManageTable();
  openModal("boxManageModal");
  setupBoxManageLoadObserver();
  maybeAutoLoadBoxesManage();

  const focusInput = $(`boxCodeManage-${targetId}`);
  if (focusInput) {
    focusInput.scrollIntoView({ block: "center", behavior: "smooth" });
    focusInput.focus();
    focusInput.select?.();
  }
}

async function getShelfBoxQueryRows(shelf) {
  const boxes = (Array.isArray(state.boxes) ? state.boxes : [])
    .filter((box) => Number(box?.shelf?.id) === Number(shelf?.id))
    .sort((a, b) => String(a?.boxCode || "").localeCompare(String(b?.boxCode || ""), "en", { numeric: true }));

  const rowsByBox = await Promise.all(
    boxes.map(async (box) => {
      const sortedRows = [...(await getBoxSkuInventoryRows(box.id))].sort((a, b) =>
        String(a?.product?.productId || "").localeCompare(String(b?.product?.productId || ""), "en", { numeric: true }),
      );

      if (!sortedRows.length) {
        return [
          {
            boxCode: displayText(box?.boxCode),
            productId: "-",
            productName: "-",
            qty: 0,
          },
        ];
      }

      return sortedRows.map((row, index) => ({
        boxCode: index === 0 ? displayText(box?.boxCode) : "",
        productId: displayText(row?.product?.productId),
        productName: displayText(row?.product?.productName),
        qty: displayText(row?.qty),
      }));
    }),
  );

  return {
    boxCount: boxes.length,
    rows: rowsByBox.flat(),
  };
}

function renderShelfBoxQueryResult(shelf, rows, boxCount = 0) {
  const summary = $("shelfBoxQuerySummary");
  const body = $("shelfBoxQueryBody");
  const printButton = $("printShelfBoxQueryLabelsBtn");
  if (!summary || !body) return;
  summary.classList.remove("is-error");

  const shelfCode = displayText(shelf?.shelfCode);
  const safeRows = Array.isArray(rows) ? rows : [];
  state.selectedShelfBoxQueryShelfCode = shelfCode;
  state.selectedShelfBoxQueryRows = safeRows.map((row) => ({
    productId: displayText(row?.productId),
    qty: Number(row?.qty ?? 0),
  }));
  if (printButton) {
    printButton.disabled = !state.selectedShelfBoxQueryRows.some(
      (row) => String(row?.productId || "").trim() && Number(row?.qty ?? 0) > 0,
    );
  }

  if (!boxCount) {
    summary.textContent = `货架 ${shelfCode} 当前没有箱号。`;
    body.innerHTML = `<tr><td colspan="4" class="muted">货架 ${escapeHtml(shelfCode)} 当前没有箱号。</td></tr>`;
    return;
  }

  summary.textContent = `货架 ${shelfCode} 共 ${boxCount} 个箱号。`;
  body.innerHTML = safeRows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(displayText(row?.boxCode))}</td>
          <td>${renderMasterProductDetailLink(displayText(row?.productId))}</td>
          <td>${escapeHtml(displayText(row?.productName))}</td>
          <td>${escapeHtml(displayText(row?.qty))}</td>
        </tr>
      `,
    )
    .join("");
}

function getEligibleStocktakeShelves() {
  return getEnabledShelvesSorted().filter((shelf) => {
    const shelfCode = normalizeShelfCodeInput(shelf?.shelfCode);
    return Boolean(shelfCode) && shelfCode !== "00" && !shelfCode.startsWith("S");
  });
}

async function loadStocktakeTasks() {
  const items = await request("/stocktake-planner/tasks");
  state.stocktakeTasks = Array.isArray(items) ? items : [];
  state.stocktakeVisibleCount = Math.min(state.inventoryPageSize, state.stocktakeTasks.length);
}

function buildStocktakeTaskStatusText(task) {
  if (task?.status === "confirmed") return "已确认";
  if (task?.status === "confirming") return "确认中";
  if (task?.status === "canceled") return "已取消";
  return "待确认";
}

async function generateStocktakeTasks() {
  const items = await request("/stocktake-planner/tasks/generate", {
    method: "POST",
    body: "{}",
  });
  state.stocktakeTasks = Array.isArray(items) ? items : [];
  state.stocktakeVisibleCount = Math.min(
    Math.max(state.stocktakeVisibleCount || 0, state.inventoryPageSize),
    state.stocktakeTasks.length,
  );
}

async function confirmStocktakeTask(taskId) {
  const updated = await request(`/stocktake-planner/tasks/${encodeURIComponent(taskId)}/confirm`, {
    method: "POST",
    body: "{}",
  });
  const items = Array.isArray(state.stocktakeTasks) ? [...state.stocktakeTasks] : [];
  const index = items.findIndex((item) => String(item?.id || "") === String(taskId || ""));
  if (index >= 0) {
    items[index] = updated;
  }
  state.stocktakeTasks = items;
  return updated;
}

async function markStocktakeTaskConfirming(taskId) {
  const updated = await request(`/stocktake-planner/tasks/${encodeURIComponent(taskId)}/mark-confirming`, {
    method: "POST",
    body: "{}",
  });
  const items = Array.isArray(state.stocktakeTasks) ? [...state.stocktakeTasks] : [];
  const index = items.findIndex((item) => String(item?.id || "") === String(taskId || ""));
  if (index >= 0) {
    items[index] = updated;
  }
  state.stocktakeTasks = items;
  return updated;
}

async function cancelStocktakeTask(taskId) {
  const updated = await request(`/stocktake-planner/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
    body: "{}",
  });
  const items = Array.isArray(state.stocktakeTasks) ? [...state.stocktakeTasks] : [];
  const index = items.findIndex((item) => String(item?.id || "") === String(taskId || ""));
  if (index >= 0) {
    items[index] = updated;
  }
  state.stocktakeTasks = items;
  return updated;
}

function renderStocktakePlanner() {
  const body = $("stocktakePlannerBody");
  const summary = $("stocktakePlannerSummary");
  if (!body || !summary) return;

  const tasks = [...(Array.isArray(state.stocktakeTasks) ? state.stocktakeTasks : [])].sort((a, b) =>
    String(b?.createdAt || "").localeCompare(String(a?.createdAt || ""), "en", { numeric: true }),
  );
  const visibleTasks = tasks.slice(0, Math.max(state.stocktakeVisibleCount || 0, state.inventoryPageSize));

  if (!tasks.length) {
    summary.textContent = "点击“生成库存盘点任务”后，会按规则生成盘点任务。";
    body.innerHTML = '<tr><td colspan="7" class="muted">暂无盘点任务。</td></tr>';
    return;
  }

  const plannedDates = tasks
    .map((task) => String(task?.plannedDateText || task?.plannedDate || ""))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const confirmedCount = tasks.filter((task) => task?.status === "confirmed").length;
  const latestDate = displayText(plannedDates[plannedDates.length - 1] || "-");
  const earliestDate = displayText(plannedDates[0] || "-");
  summary.textContent = `已确认 ${confirmedCount} 条库存盘点任务，日期范围 ${earliestDate} - ${latestDate}。`;
  body.innerHTML = visibleTasks
    .map(
      (task) => `
        <tr>
          <td>${escapeHtml(displayText(task?.plannedDateWithWeekday) || formatDateOnlyWithWeekdayInTimeZone(task?.plannedDate))}</td>
          <td>${escapeHtml(displayText(task?.taskNo))}</td>
          <td>${escapeHtml(displayText(task?.shelfCode))}</td>
          <td>${escapeHtml(buildStocktakeTaskStatusText(task))}</td>
          <td>${escapeHtml(formatDate(task?.confirmedAt))}</td>
          <td>${escapeHtml(displayText(task?.confirmedByName) || "-")}</td>
          <td>
            <div class="action-row">
              ${(task?.status === "pending" || task?.status === "confirming") ? `<button type="button" class="tiny-btn secondary" data-action="printStocktakeTask" data-id="${escapeHtml(displayText(task?.id))}">打印</button>` : ""}
              ${(task?.status === "pending" || task?.status === "confirming") ? `<button type="button" class="tiny-btn danger" data-action="cancelStocktakeTask" data-id="${escapeHtml(displayText(task?.id))}">删除</button>` : ""}
              ${(task?.status === "pending" || task?.status === "confirming") ? `<button type="button" class="tiny-btn" data-action="confirmStocktakeTask" data-id="${escapeHtml(displayText(task?.id))}">确认</button>` : ""}
            </div>
          </td>
        </tr>
      `,
    )
    .join("");
}

function loadMoreStocktakeTasksIfNeeded() {
  const panel = $("stocktakePlanner");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.stocktakeVisibleCount >= state.stocktakeTasks.length) return;
  state.stocktakeVisibleCount = Math.min(
    state.stocktakeTasks.length,
    state.stocktakeVisibleCount + state.inventoryPageSize,
  );
  renderStocktakePlanner();
}

function maybeAutoLoadStocktakeTasks() {
  const panel = $("stocktakePlanner");
  if (!panel || !panel.classList.contains("active")) return;
  const tableWrap = $("stocktakePlannerTableWrap");
  if (!tableWrap) return;
  if (state.stocktakeVisibleCount >= state.stocktakeTasks.length) return;

  const threshold = 120;
  const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
  if (currentBottom < tableWrap.scrollHeight - threshold) return;

  loadMoreStocktakeTasksIfNeeded();
}

function maybeAutoLoadDataBackups() {
  const panel = $("dataBackup");
  if (!panel || !panel.classList.contains("active")) return;
  const tableWrap = $("dataBackupTableWrap");
  if (!tableWrap) return;
  if (state.dataBackupsVisibleCount >= state.dataBackups.length) return;

  const threshold = 120;
  const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
  if (currentBottom < tableWrap.scrollHeight - threshold) return;

  loadMoreDataBackupsIfNeeded();
}

function setupStocktakePlannerLoadObserver() {
  if (stocktakePlannerLoadObserver) {
    stocktakePlannerLoadObserver.disconnect();
    stocktakePlannerLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("stocktakePlannerTableWrap");
  const sentinel = $("stocktakePlannerLoadSentinel");
  if (!tableWrap || !sentinel) return;

  stocktakePlannerLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreStocktakeTasksIfNeeded();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  stocktakePlannerLoadObserver.observe(sentinel);
}

function setupDataBackupLoadObserver() {
  if (dataBackupLoadObserver) {
    dataBackupLoadObserver.disconnect();
    dataBackupLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("dataBackupTableWrap");
  const sentinel = $("dataBackupLoadSentinel");
  if (!tableWrap || !sentinel) return;

  dataBackupLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreDataBackupsIfNeeded();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  dataBackupLoadObserver.observe(sentinel);
}

function renderStocktakeTaskDetail(task, rows, boxCount = 0) {
  const meta = $("stocktakeTaskDetailMeta");
  const summary = $("stocktakeTaskDetailSummary");
  const body = $("stocktakeTaskDetailBody");
  if (!meta || !summary || !body) return;

  state.selectedStocktakeTask = task || null;
  state.selectedStocktakeTaskRows = Array.isArray(rows) ? rows : [];

  if (!task) {
    meta.innerHTML = "";
    summary.textContent = "请选择盘点任务后查看。";
    body.innerHTML = '<tr><td colspan="4" class="muted">请选择盘点任务后查看。</td></tr>';
    return;
  }

  meta.innerHTML = `
    <div><strong>任务编号：</strong>${escapeHtml(displayText(task?.taskNo))}</div>
    <div><strong>任务日期：</strong>${escapeHtml(displayText(task?.plannedDateWithWeekday) || displayText(task?.plannedDateText) || formatDateOnlyInTimeZone(task?.plannedDate))}</div>
    <div><strong>货架号：</strong>${escapeHtml(displayText(task?.shelfCode))}</div>
    <div><strong>状态：</strong>${escapeHtml(buildStocktakeTaskStatusText(task))}</div>
    <div><strong>确认日期：</strong>${escapeHtml(formatDate(task?.confirmedAt))}</div>
    <div><strong>确认人：</strong>${escapeHtml(displayText(task?.confirmedByName) || "-")}</div>
  `;

  if (!boxCount) {
    summary.textContent = `货架 ${displayText(task?.shelfCode)} 当前没有箱号。`;
    body.innerHTML = `<tr><td colspan="4" class="muted">货架 ${escapeHtml(displayText(task?.shelfCode))} 当前没有箱号。</td></tr>`;
    return;
  }

  summary.textContent = `货架 ${displayText(task?.shelfCode)} 共 ${boxCount} 个箱号。`;
  body.innerHTML = state.selectedStocktakeTaskRows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(displayText(row?.boxCode))}</td>
          <td>${escapeHtml(displayText(row?.productId))}</td>
          <td>${escapeHtml(displayText(row?.productName))}</td>
          <td>${escapeHtml(displayText(row?.qty))}</td>
        </tr>
      `,
    )
    .join("");
}

function openStocktakePrintWindow(task, rows) {
  if (!task) {
    throw new Error("未找到盘点任务");
  }
  const safeRows = Array.isArray(rows) ? rows : [];
  const popup = window.open("", "_blank", "width=960,height=720");
  if (!popup) {
    throw new Error("打印窗口被拦截，请允许浏览器打开新窗口");
  }

  popup.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(displayText(task?.taskNo))}</title>
    <style>
      body { font-family: "Microsoft YaHei", sans-serif; margin: 24px; color: #111; }
      h1 { font-size: 24px; margin: 0 0 12px; }
      .meta { margin-bottom: 16px; display: grid; gap: 6px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #cfdad0; padding: 8px 10px; text-align: left; }
      th { background: #eef5f0; }
      @media print { body { margin: 12mm; } }
    </style>
  </head>
  <body>
    <h1>库存盘点任务明细</h1>
    <div class="meta">
      <div><strong>任务编号：</strong>${escapeHtml(displayText(task?.taskNo))}</div>
      <div><strong>任务日期：</strong>${escapeHtml(displayText(task?.plannedDateWithWeekday) || displayText(task?.plannedDateText) || formatDateOnlyInTimeZone(task?.plannedDate))}</div>
      <div><strong>货架号：</strong>${escapeHtml(displayText(task?.shelfCode))}</div>
      <div><strong>状态：</strong>${escapeHtml(buildStocktakeTaskStatusText(task))}</div>
      <div><strong>确认日期：</strong>${escapeHtml(formatDate(task?.confirmedAt))}</div>
      <div><strong>确认人：</strong>${escapeHtml(displayText(task?.confirmedByName) || "-")}</div>
    </div>
    <table>
      <thead><tr><th>箱号</th><th>产品ID</th><th>产品名称</th><th>数量</th></tr></thead>
      <tbody>
        ${
          safeRows.length
            ? safeRows
                .map(
                  (row) =>
                    `<tr><td>${escapeHtml(displayText(row?.boxCode))}</td><td>${escapeHtml(displayText(row?.productId))}</td><td>${escapeHtml(displayText(row?.productName))}</td><td>${escapeHtml(displayText(row?.qty))}</td></tr>`,
                )
                .join("")
            : `<tr><td colspan="4">当前没有盘点明细。</td></tr>`
        }
      </tbody>
    </table>
  </body>
</html>`);
  popup.document.close();
  popup.focus();
  popup.print();
}

async function openStocktakeTaskDetail(taskId) {
  await Promise.all([loadShelves(), loadBoxes()]);
  const task = (Array.isArray(state.stocktakeTasks) ? state.stocktakeTasks : []).find(
    (item) => String(item?.id || "") === String(taskId || ""),
  );
  if (!task) {
    throw new Error("未找到盘点任务");
  }
  const shelf =
    (Array.isArray(state.shelves) ? state.shelves : []).find(
      (item) => String(item?.id || "") === String(task?.shelfId || ""),
    ) || findShelfByAnyCode(task?.shelfCode);
  if (!shelf) {
    throw new Error("未找到任务对应货架");
  }
  const { boxCount, rows } = await getShelfBoxQueryRows(shelf);
  renderStocktakeTaskDetail(task, rows, boxCount);
  openModal("stocktakeTaskDetailModal");
}

async function printStocktakeTask(taskId) {
  await Promise.all([loadShelves(), loadBoxes()]);
  const task = (Array.isArray(state.stocktakeTasks) ? state.stocktakeTasks : []).find(
    (item) => String(item?.id || "") === String(taskId || ""),
  );
  if (!task) {
    throw new Error("未找到盘点任务");
  }
  const shelf =
    (Array.isArray(state.shelves) ? state.shelves : []).find(
      (item) => String(item?.id || "") === String(task?.shelfId || ""),
    ) || findShelfByAnyCode(task?.shelfCode);
  if (!shelf) {
    throw new Error("未找到任务对应货架");
  }
  const { rows } = await getShelfBoxQueryRows(shelf);
  const printableTask = task?.status === "pending" ? await markStocktakeTaskConfirming(taskId) : task;
  renderStocktakePlanner();
  openStocktakePrintWindow(printableTask, rows);
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

function renderSkuManagementActions(skuId, skuCode = "") {
  const editButton = renderEditButton(skuId);
  if (!isCurrentUserSystemAdmin()) {
    return editButton;
  }
  return `
    <div class="action-row">
      ${editButton}
      <button class="tiny-btn danger" data-action="deleteSkuRow" data-sku-id="${escapeHtml(skuId)}" data-sku-code="${escapeHtml(displayText(skuCode))}">删除</button>
    </div>
  `;
}

function renderInventoryFbaJumpButton(skuCode) {
  const keyword = String(skuCode || "").trim();
  return `<button class="tiny-btn" data-action="inventoryFbaJump" data-sku-code="${escapeHtml(keyword)}">查看</button>`;
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
  const body = $("inventoryBody");
  const loadMoreBtn = $("loadMoreInventoryHomeBtn");
  if (!body) return;

  const rows = Array.isArray(state.inventoryHomeProducts) ? state.inventoryHomeProducts : [];
  body.innerHTML =
    rows
      .map((item) => {
        const productId = String(item?.productId || "").trim();
        return `
          <tr class="inventory-main-row">
            <td>${escapeHtml(displayText(productId))}</td>
            <td>${escapeHtml(displayText(item?.productName))}</td>
            <td class="master-product-current-cell">${escapeHtml(displayText(item?.stockQty ?? 0))}</td>
            <td>
              <button type="button" class="tiny-btn" data-action="inventoryOpenMasterProductDetail" data-product-id="${escapeHtml(productId)}">查看</button>
            </td>
          </tr>
        `;
      })
      .join("") || '<tr><td colspan="4" class="muted">-</td></tr>';

  if (loadMoreBtn) {
    loadMoreBtn.classList.add("hidden");
  }
}

function maybeAutoLoadInventoryHome() {
  if (state.inventorySearchMode) return;
  if (!state.token) return;
  const inventoryPanel = $("inventory");
  if (!inventoryPanel || !inventoryPanel.classList.contains("active")) return;
  if (state.inventoryHomeLoading || !state.inventoryHomeHasMore) return;

  const threshold = 120;
  const tableWrap = $("inventoryHomeTableWrap");
  if (tableWrap && !tableWrap.classList.contains("hidden")) {
    const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
    if (currentBottom < tableWrap.scrollHeight - threshold) return;
  } else {
    const doc = document.documentElement;
    const body = document.body;
    const scrollHeight = Math.max(
      Number(doc?.scrollHeight || 0),
      Number(body?.scrollHeight || 0),
    );
    const currentBottom = window.innerHeight + window.scrollY;
    if (currentBottom < scrollHeight - threshold) return;
  }

  loadInventoryHomeProducts({ reset: false }).catch((error) => {
    showToast(error.message, true);
  });
}

function setupInventoryHomeLoadObserver() {
  if (inventoryHomeLoadObserver) {
    inventoryHomeLoadObserver.disconnect();
    inventoryHomeLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("inventoryHomeTableWrap");
  const sentinel = $("inventoryHomeLoadSentinel");
  if (!tableWrap || !sentinel) return;

  inventoryHomeLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreInventoryIfNeeded();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  inventoryHomeLoadObserver.observe(sentinel);
}

function getSkuManagementFilteredRows() {
  const rows = Array.isArray(state.inventorySortedSkus) ? state.inventorySortedSkus : [];
  const keyword = String(state.skuManagementKeyword || "").trim().toLowerCase();
  if (!keyword) {
    return rows;
  }

  return rows.filter((item) =>
    [
      item?.sku,
      item?.asin,
      item?.fnsku,
      item?.fbmSku,
      item?.rbSku,
      item?.shop,
      item?.remark,
    ].some((value) => String(value || "").toLowerCase().includes(keyword)),
  );
}

function renderSkuManagementTable() {
  const body = $("skuManagementBody");
  const summary = $("skuManagementSummary");
  if (!body) return;

  const filteredRows = getSkuManagementFilteredRows();
  const visibleCount = Math.max(
    state.inventoryListPageSize,
    Number(state.skuManagementVisibleCount || 0),
  );
  const rows = filteredRows.slice(0, visibleCount);

  body.innerHTML =
    rows
      .map((item) => {
        const skuId = Number(item?.id || 0);
        return `
          <tr>
            <td>${escapeHtml(displayText(item?.sku))}</td>
            <td>${escapeHtml(displayText(item?.asin))}</td>
            <td>${escapeHtml(displayText(item?.fnsku))}</td>
            <td>${escapeHtml(displayText(item?.fbmSku))}</td>
            <td>${escapeHtml(displayText(item?.rbSku))}</td>
            <td>${escapeHtml(displayText(item?.shop))}</td>
            <td>${escapeHtml(displayText(item?.remark))}</td>
            <td>${renderSkuManagementActions(skuId, item?.sku)}</td>
          </tr>
        `;
      })
      .join("") || '<tr><td colspan="8" class="muted">-</td></tr>';

  if (summary) {
    const keyword = String(state.skuManagementKeyword || "").trim();
    summary.textContent = keyword
      ? `检索到 ${filteredRows.length} 条SKU`
      : `共 ${filteredRows.length} 条SKU`;
  }

  setupSkuManagementLoadObserver();
  maybeAutoLoadSkuManagement();
}

function renderProductSummaryMeta(containerId, product) {
  const meta = $(containerId);
  if (!meta) return;
  if (!product) {
    meta.innerHTML = "";
    return;
  }
  const fields = [
    ["产品ID", product.productId],
    ["产品名称", product.productName],
    ["产品类型", product.productType],
    ["包包品牌", product.bagBrand],
    ["颜色", product.color],
    ["包名", product.bagName],
    ["包型", product.bagType],
    ["拉链款式", product.zipperStyle],
    ["款式", product.style],
    ["花纹", product.pattern],
    ["扣子类型", product.buckleType],
    ["对应包型", product.matchingBagType],
    ["长度", product.length],
    ["宽度", product.width],
    ["花纹类型", product.patternType],
    ["尺寸", product.size],
    ["Yamato打印机", product.yamatoPrinterName],
    ["在库数", product.stockQty],
  ];
  meta.innerHTML = fields
    .map(
      ([label, value]) => `
        <div class="summary-item">
          <span class="summary-label">${escapeHtml(label)}</span>
          <span class="summary-value">${escapeHtml(displayText(value))}</span>
        </div>
      `,
    )
    .join("");
}

function renderAmazonAsinCell(asin) {
  const value = String(asin || "").trim();
  if (!value) {
    return escapeHtml(displayText(value));
  }
  const href = `https://www.amazon.co.jp/dp/${encodeURIComponent(value)}?th=1`;
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a>`;
}

function buildMasterProductDetailUrl(productId) {
  const value = String(productId || "").trim();
  if (!value) return "";
  const url = new URL(window.location.href);
  url.searchParams.set("view", "master-product-detail");
  url.searchParams.set("productId", value);
  const token = String(state.token || "").trim();
  const deployVersion = String(state.authDeployVersion || state.currentDeployVersion || "").trim();
  if (token) {
    const hashParams = new URLSearchParams([[AUTH_HASH_PARAM, token]]);
    if (deployVersion) {
      hashParams.set(AUTH_DEPLOY_VERSION_HASH_PARAM, deployVersion);
    }
    url.hash = hashParams.toString();
  }
  return url.toString();
}

function getPendingMasterProductDetailIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const view = String(params.get("view") || "").trim();
  const productId = String(params.get("productId") || "").trim();
  if (view !== "master-product-detail" || !productId) return "";
  return productId;
}

function clearPendingMasterProductDetailUrlState() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("view") && !url.searchParams.has("productId")) return;
  url.searchParams.delete("view");
  url.searchParams.delete("productId");
  window.history.replaceState({}, "", url.toString());
}

function bootstrapAuthTokenFromLocationHash() {
  const hash = String(window.location.hash || "").replace(/^#/, "").trim();
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  const token = String(params.get(AUTH_HASH_PARAM) || "").trim();
  const deployVersion = String(params.get(AUTH_DEPLOY_VERSION_HASH_PARAM) || "").trim();
  if (!token) return false;
  state.token = persistAuthToken(token);
  if (deployVersion) {
    state.authDeployVersion = persistAuthDeployVersion(deployVersion);
    state.currentDeployVersion = deployVersion;
  }
  params.delete(AUTH_HASH_PARAM);
  params.delete(AUTH_DEPLOY_VERSION_HASH_PARAM);
  const url = new URL(window.location.href);
  const nextHash = params.toString();
  url.hash = nextHash ? `#${nextHash}` : "";
  window.history.replaceState({}, "", url.toString());
  return true;
}

async function openPendingMasterProductDetailFromUrl() {
  const productId = getPendingMasterProductDetailIdFromUrl();
  if (!productId) return false;
  await loadInventoryHomeProductDetail(productId);
  clearPendingMasterProductDetailUrlState();
  return true;
}

function renderMasterProductDetailLink(productId) {
  const value = String(productId || "").trim();
  if (!value) {
    return escapeHtml(displayText(value));
  }
  const href = buildMasterProductDetailUrl(value);
  return `<a class="inline-link-btn" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a>`;
}

function renderProductSkuTable(detail, { bodyId, selectId = "" } = {}) {
  const body = $(bodyId);
  const select = selectId ? $(selectId) : null;
  if (!body) return;
  const rows = Array.isArray(detail?.skus) ? detail.skus : [];
  body.innerHTML =
    rows
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(displayText(item?.sku))}</td>
            <td>${renderAmazonAsinCell(item?.asin)}</td>
            <td>${escapeHtml(displayText(item?.fnsku))}</td>
            <td>${escapeHtml(displayText(item?.fbmSku))}</td>
            <td>${escapeHtml(displayText(item?.rbSku))}</td>
            <td>${escapeHtml(displayText(item?.shop))}</td>
          </tr>
        `,
      )
      .join("") || '<tr><td colspan="6" class="muted">-</td></tr>';

  if (!select) return;
  const prev = select.value;
  select.innerHTML = `<option value="">请选择SKU</option>${rows
    .map(
      (item) =>
        `<option value="${escapeHtml(displayText(item?.id))}">${escapeHtml(
          `${displayText(item?.sku)} / ${displayText(item?.shop)}`,
        )}</option>`,
    )
    .join("")}`;
  if (prev && rows.some((item) => String(item?.id) === prev)) {
    select.value = prev;
  }
}

function buildProductBoxFillButtons(boxCode, actionPrefix) {
  const safeBoxCode = escapeHtml(String(boxCode || "").trim());
  return `
    <div class="master-product-box-actions">
      <button type="button" class="tiny-btn ghost" data-action="fill${actionPrefix}InboundBox" data-box-code="${safeBoxCode}">填入入库</button>
      <button type="button" class="tiny-btn ghost" data-action="fill${actionPrefix}OutboundBox" data-box-code="${safeBoxCode}">填入出库</button>
      <button type="button" class="tiny-btn ghost" data-action="fill${actionPrefix}FbaBox" data-box-code="${safeBoxCode}">填入FBA</button>
    </div>
  `;
}

function buildInventoryDetailBoxActionButtons(box) {
  const boxCode = String(box?.boxCode || "").trim();
  const qty = Number(box?.qty ?? 0);
  if (!boxCode || qty <= 0) {
    return '<span class="muted">-</span>';
  }
  const safeBoxCode = escapeHtml(boxCode);
  return `
    <div class="master-product-box-actions">
      <button type="button" class="tiny-btn" data-action="openInventoryDetailInboundBox" data-box-code="${safeBoxCode}">入库</button>
      <button type="button" class="tiny-btn" data-action="openInventoryDetailFbaBox" data-box-code="${safeBoxCode}">FBA入库</button>
      <button type="button" class="tiny-btn" data-action="inventoryDetailOutboundOne" data-box-code="${safeBoxCode}">出库1件</button>
    </div>
  `;
}

function buildInventoryDetailBoxRows(detail) {
  const boxes = Array.isArray(detail?.boxes) ? [...detail.boxes] : [];
  const currentProductId = String(detail?.product?.productId || "").trim();
  const currentProductName = String(detail?.product?.productName || "").trim();
  const rows = [];

  boxes.sort((a, b) => {
    const qtyDiff = Number(a?.qty ?? 0) - Number(b?.qty ?? 0);
    if (qtyDiff !== 0) return qtyDiff;
    return String(a?.boxCode || "").localeCompare(String(b?.boxCode || ""), "en", {
      numeric: true,
    });
  });

  boxes.forEach((box) => {
    const boxCode = String(box?.boxCode || "").trim();
    const shelfCode = String(box?.shelfCode || "").trim();
    const items = Array.isArray(box?.items) && box.items.length
      ? [...box.items]
      : [{
          productId: currentProductId,
          productName: currentProductName || null,
          qty: Number(box?.qty ?? 0),
          isCurrentProduct: true,
        }];

    const sortedItems = items
      .sort((a, b) => {
        const currentDelta = Number(Boolean(b?.isCurrentProduct)) - Number(Boolean(a?.isCurrentProduct));
        if (currentDelta !== 0) return currentDelta;
        return String(a?.productId || "").localeCompare(String(b?.productId || ""), "en", {
          numeric: true,
        });
      });

    sortedItems.forEach((item, index) => {
        const isCurrentProduct = Boolean(item?.isCurrentProduct);
        const isFirstRow = index === 0;
        const isLastRow = index === sortedItems.length - 1;
        const rowClasses = [
          isCurrentProduct ? "master-product-current-row" : "",
          isLastRow ? "inventory-detail-box-group-end" : "inventory-detail-box-group-continue",
        ]
          .filter(Boolean)
          .join(" ");
        rows.push(`
          <tr${rowClasses ? ` class="${rowClasses}"` : ""}>
            <td>${isFirstRow ? escapeHtml(displayText(boxCode)) : ""}</td>
            <td>${isFirstRow ? escapeHtml(displayText(shelfCode)) : ""}</td>
            <td>${escapeHtml(displayText(item?.productName))}</td>
            <td>${escapeHtml(displayText(item?.productId))}</td>
            <td class="${isCurrentProduct ? "master-product-current-cell" : ""}">${escapeHtml(displayText(item?.qty ?? 0))}</td>
            <td>${
              isCurrentProduct
                ? buildInventoryDetailBoxActionButtons({
                    boxCode,
                    qty: item?.qty ?? 0,
                  })
                : '<span class="muted">-</span>'
            }</td>
          </tr>
        `);
      });
  });

  return rows.join("");
}

function renderProductBoxTable(detail, { bodyId, actionPrefix = "", actionRenderer = null } = {}) {
  const body = $(bodyId);
  if (!body) return;
  const rows = Array.isArray(detail?.boxes) ? detail.boxes : [];
  if (bodyId === "inventoryDetailBoxBody") {
    body.innerHTML = buildInventoryDetailBoxRows(detail) || '<tr><td colspan="6" class="muted">-</td></tr>';
    return;
  }
  const hasActionColumn = Boolean(actionPrefix) || typeof actionRenderer === "function";
  body.innerHTML =
    rows
      .map((box) => {
        const boxCode = String(box?.boxCode || "").trim();
        const actionContent =
          typeof actionRenderer === "function"
            ? actionRenderer(box)
            : actionPrefix
              ? buildProductBoxFillButtons(boxCode, actionPrefix)
              : "";
        return `
          <tr>
            <td>${escapeHtml(displayText(boxCode))}</td>
            <td>${escapeHtml(displayText(box?.shelfCode))}</td>
            <td class="master-product-current-cell">${escapeHtml(displayText(box?.qty ?? 0))}</td>
            <td>${escapeHtml(formatDate(box?.updatedAt))}</td>
            <td>${buildMasterProductRelatedItems(box?.items)}</td>
            ${hasActionColumn ? `<td>${actionContent || '<span class="muted">-</span>'}</td>` : ""}
          </tr>
        `;
      })
      .join("") || `<tr><td colspan="${hasActionColumn ? 6 : 5}" class="muted">-</td></tr>`;
}

function renderInventoryHomeDetail(detail) {
  state.inventoryHomeSelectedDetail = detail || null;
  $("inventoryDetailTitle").textContent = "";
  $("inventoryDetailSubtitle").textContent = "";
  renderProductSummaryMeta("inventoryDetailMeta", detail?.product);
  renderProductSkuTable(detail, { bodyId: "inventoryDetailSkuBody", selectId: "inventoryDetailFbaSkuId" });
  renderProductBoxTable(detail, {
    bodyId: "inventoryDetailBoxBody",
    actionRenderer: buildInventoryDetailBoxActionButtons,
  });
  const skuSummary = $("inventoryDetailSkuSummary");
  if (skuSummary) {
    const skuCount = Array.isArray(detail?.skus) ? detail.skus.length : 0;
    skuSummary.textContent = `共 ${skuCount} 条关联 SKU`;
  }
  const boxSummary = $("inventoryDetailBoxSummary");
  if (boxSummary) {
    const boxes = Array.isArray(detail?.boxes) ? detail.boxes : [];
    const boxCount = boxes.length;
    const totalQty = boxes.reduce((sum, item) => sum + Number(item?.qty ?? 0), 0);
    boxSummary.textContent = `相关箱子 ${boxCount} 个，当前产品箱内合计 ${totalQty}`;
  }
}

async function loadInventoryHomeProducts({ reset = false } = {}) {
  if (state.inventoryHomeLoading) return;
  const page = reset ? 1 : state.inventoryHomePage + 1;
  const keyword = String(state.inventoryHomeKeyword || "").trim();
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(state.inventoryHomePageSize),
  });
  if (keyword) {
    params.set("keyword", keyword);
  }
  state.inventoryHomeLoading = true;
  try {
    const result = await request(`/master-products?${params.toString()}`);
    const items = Array.isArray(result?.items) ? result.items : [];
    state.inventoryHomeProducts = reset ? items : [...state.inventoryHomeProducts, ...items];
    state.inventoryHomePage = Number(result?.page || page);
    state.inventoryHomeHasMore = Boolean(result?.hasMore);
    renderInventoryTable();
    requestAnimationFrame(() => {
      maybeAutoLoadInventoryHome();
    });
  } finally {
    state.inventoryHomeLoading = false;
  }
}

async function loadInventoryHomeProductDetail(productId) {
  const detail = await request(`/master-products/${encodeURIComponent(productId)}/detail`);
  renderInventoryHomeDetail(detail);
  setInventoryDisplayMode(true);
  return detail;
}

function loadMoreInventoryIfNeeded() {
  if (state.inventorySearchMode) return;
  if (!state.token) return;
  const inventoryPanel = $("inventory");
  if (!inventoryPanel || !inventoryPanel.classList.contains("active")) return;
  if (state.inventoryHomeLoading) return;
  if (!state.inventoryHomeHasMore) return;
  loadInventoryHomeProducts({ reset: false }).catch((error) => {
    showToast(error.message, true);
  });
}

function loadMoreInventorySearchIfNeeded() {
  return;
}

async function loadInventory({ preserveSearch = false } = {}) {
  const [skus, totals] = await Promise.all([
    request("/skus"),
    request("/inventory/sku-totals"),
    loadFbaPendingSummary(),
  ]);
  state.inventorySkus = skus;
  state.inventoryTotalsBySku = totals || {};
  state.inventoryLocations = new Map();
  $("statSkus").textContent = skus.length;
  renderMasterProductOptionsForInput("moveProductProductId", "moveProductProductIdList");

  state.inventorySortedSkus = [...skus].sort((a, b) => {
    const qtyA = Number(state.inventoryTotalsBySku?.[String(a.id)] ?? 0);
    const qtyB = Number(state.inventoryTotalsBySku?.[String(b.id)] ?? 0);
    return qtyB - qtyA;
  });
  state.inventoryVisibleCount = state.inventoryListPageSize;
  if (!preserveSearch) {
    state.skuManagementKeyword = "";
  }
  state.skuManagementVisibleCount = state.inventoryListPageSize;
  renderSkuManagementTable();
  if (!preserveSearch) {
    resetInventorySearchState();
    setInventoryDisplayMode(false);
    renderInventoryTable();
  }
  await refreshMoveProductOldBoxOptionsByProduct();
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
        ["产品ID", displayText(sku.productId)],
        ["产品名称", displayText(sku.productName)],
        ["备注", displayText(sku.remark)],
        ["店铺", displayText(sku.shop)],
      ];
      const rightRows = [
        ["SKU", displayText(sku.sku)],
        ["ASIN", displayText(sku.asin)],
        ["FNSKU", displayText(sku.fnsku)],
        ["FBMSKU", displayText(sku.fbmSku)],
        ["rbSKU", displayText(sku.rbSku)],
        ["库存总数量", totalQty],
      ];
      const boxTable = totalQty > 0 ? renderBoxSkuFlatTable(sku, rows, boxSkuMap) : "";
      const topActionRow = `
        <div class="action-row">
          ${renderEditButton(sku.id)}
          ${renderInboundButton(sku.id, "", "新增入库")}
        </div>
      `;
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

async function searchInventoryProducts(keyword, { append = false } = {}) {
  const normalizedKeyword = String(keyword || "").trim();
  if (!normalizedKeyword) {
    resetInventorySearchState();
    setInventoryDisplayMode(false);
    renderInventoryTable();
    focusInventorySearch();
    return;
  }

  if (append && normalizedKeyword !== state.inventorySearchKeyword) {
    return searchInventoryProducts(normalizedKeyword);
  }

  if (append) {
    if (state.inventorySearchLoading || !state.inventorySearchHasMore) {
      return;
    }
  } else {
    state.inventorySearchKeyword = normalizedKeyword;
    state.inventorySearchPage = 0;
    state.inventorySearchHasMore = true;
    state.inventorySearchSkus = [];
    state.inventorySearchLocationMap = new Map();
    state.inventorySearchBoxSkuMap = new Map();
  }

  const nextPage = append ? state.inventorySearchPage + 1 : 1;
  const pageSize = state.inventorySearchPageSize;
  state.inventorySearchLoading = true;

  try {
    const skus = await request(
      `/inventory/search?keyword=${encodeURIComponent(normalizedKeyword)}&page=${nextPage}&pageSize=${pageSize}`,
    );
    const existingSkuIds = new Set(state.inventorySearchSkus.map((sku) => String(sku.id)));
    const nextSkus = append ? [...state.inventorySearchSkus] : [];
    const pageSkus = skus.filter((sku) => {
      const skuId = String(sku?.id || "");
      if (!skuId || existingSkuIds.has(skuId)) {
        return false;
      }
      existingSkuIds.add(skuId);
      return true;
    });
    nextSkus.push(...pageSkus);

    const locationEntries = await Promise.all(
      pageSkus.map(async (sku) => [String(sku.id), await getSkuInventoryRows(sku)]),
    );
    const nextLocationMap = append ? new Map(state.inventorySearchLocationMap) : new Map();
    locationEntries.forEach(([skuId, rows]) => {
      nextLocationMap.set(String(skuId), rows);
    });

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
    const nextBoxSkuMap = append ? new Map(state.inventorySearchBoxSkuMap) : new Map();
    boxSkuEntries.forEach(([boxId, rows]) => {
      nextBoxSkuMap.set(String(boxId), rows);
    });

    await loadFbaPendingSummary();
    state.inventorySearchKeyword = normalizedKeyword;
    state.inventorySearchPage = nextPage;
    state.inventorySearchHasMore = skus.length >= pageSize;
    state.inventorySearchSkus = nextSkus;
    state.inventorySearchLocationMap = nextLocationMap;
    state.inventorySearchBoxSkuMap = nextBoxSkuMap;

    setInventoryDisplayMode(true);
    renderInventorySearchResults(
      state.inventorySearchSkus,
      state.inventorySearchLocationMap,
      state.inventorySearchBoxSkuMap,
    );
  } finally {
    state.inventorySearchLoading = false;
  }
}

function findSkuById(skuId) {
  return (
    (Array.isArray(state.inventorySkus) ? state.inventorySkus : []).find(
      (sku) => Number(sku.id) === Number(skuId),
    ) ||
    (Array.isArray(state.inventorySearchSkus) ? state.inventorySearchSkus : []).find(
      (sku) => Number(sku.id) === Number(skuId),
    ) ||
    null
  );
}

function ensureSkuReadyForFbaReplenishment(skuId) {
  const sku = findSkuById(skuId);
  if (!sku) {
    throw new Error("未找到SKU");
  }

  const fnsku = String(sku.fnsku || "").trim();
  if (!fnsku) {
    throw new Error("该SKU缺少FNSKU，无法发起FBA补货");
  }

  const shop = String(sku.shop || "").trim();
  if (!shop) {
    throw new Error("该SKU缺少所属店铺，无法发起FBA补货");
  }

  return sku;
}

async function openEditSkuModal(skuId) {
  const sku = findSkuById(skuId);
  if (!sku) {
    throw new Error("未找到SKU");
  }
  await loadShops();

  $("editSkuId").value = String(sku.id);
  $("editProductId").value = sku.productId || "";
  $("editProductName").value = sku.productName || "";
  renderShopOptionsForSelect("editShop", "请选择店铺", sku.shop || "");
  $("editRemark").value = sku.remark || "";
  $("editSku").value = sku.sku || "";
  $("editErpSku").value = sku.rbSku || "";
  $("editAsin").value = sku.asin || "";
  $("editFnsku").value = sku.fnsku || "";
  $("editFbmSku").value = sku.fbmSku || "";
  await syncSkuProductName("editProductId", "editProductName");
  openModal("editSkuModal");
}

async function submitEditSkuForm() {
  const skuId = Number($("editSkuId").value);
  if (!Number.isInteger(skuId) || skuId <= 0) {
    throw new Error("请选择SKU");
  }

  const toNullableValue = (id) => {
    const value = String($(id)?.value ?? "").trim();
    return value ? value : null;
  };

  const payload = {
    skuId,
    // SKU is read-only and not submitted for editing.
    productId: toNullableValue("editProductId"),
    shop: toNullableValue("editShop"),
    remark: toNullableValue("editRemark"),
    rbSku: toNullableValue("editErpSku"),
    asin: toNullableValue("editAsin"),
    fnsku: toNullableValue("editFnsku"),
    fbmSku: toNullableValue("editFbmSku"),
  };

  if (payload.productId) {
    const matchedProduct = await syncSkuProductName("editProductId", "editProductName");
    if (!matchedProduct?.productId) {
      throw new Error("未匹配到产品名称，请确认产品ID");
    }
    payload.productId = matchedProduct.productId;
  }

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
  const control = $(selectId);
  if (!control) return;

  const rows = [...state.inventorySkus].sort((a, b) =>
    String(a.sku || "").localeCompare(String(b.sku || ""), "en", { numeric: true }),
  );

  if (String(control.tagName || "").toUpperCase() === "SELECT") {
    const prev = control.value;
    const options = rows
      .map((sku) => `<option value="${escapeHtml(sku.id)}">${escapeHtml(sku.sku)}</option>`)
      .join("");
    control.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options}`;
    if (prev && state.inventorySkus.some((sku) => String(sku.id) === String(prev))) {
      control.value = prev;
    }
    return;
  }

  const listId = control.getAttribute("list");
  const datalist = listId ? $(listId) : null;
  if (!datalist) return;
  const prev = String(control.value || "").trim();
  datalist.innerHTML = rows
    .map((sku) => `<option value="${escapeHtml(sku.sku)}"></option>`)
    .join("");
  if (prev) {
    const exact = rows.find(
      (sku) => String(sku.sku || "").trim().toUpperCase() === prev.toUpperCase(),
    );
    if (exact?.sku) {
      control.value = exact.sku;
    }
  }
}

function getKnownMasterProductsSorted() {
  const productMap = new Map();
  const pushProduct = (productId, productName = "") => {
    const normalizedId = String(productId || "").trim();
    if (!normalizedId) return;
    const current = productMap.get(normalizedId) || { productId: normalizedId, productName: "" };
    if (!current.productName && productName) {
      current.productName = String(productName || "").trim();
    }
    productMap.set(normalizedId, current);
  };

  (Array.isArray(state.inventorySkus) ? state.inventorySkus : []).forEach((item) => {
    pushProduct(item?.productId, item?.productName);
  });
  (Array.isArray(state.inventoryHomeProducts) ? state.inventoryHomeProducts : []).forEach((item) => {
    pushProduct(item?.productId, item?.productName);
  });
  (Array.isArray(state.masterProducts) ? state.masterProducts : []).forEach((item) => {
    pushProduct(item?.productId, item?.productName);
  });
  pushProduct(state.inventoryHomeSelectedDetail?.product?.productId, state.inventoryHomeSelectedDetail?.product?.productName);
  pushProduct(state.selectedMasterProductDetail?.product?.productId, state.selectedMasterProductDetail?.product?.productName);

  return [...productMap.values()].sort((a, b) =>
    String(a.productId || "").localeCompare(String(b.productId || ""), "en", { numeric: true }),
  );
}

async function findMasterProductByProductId(productId) {
  const normalizedId = String(productId || "").trim();
  if (!normalizedId) return null;

  const localMatch = getKnownMasterProductsSorted().find(
    (item) => String(item?.productId || "").trim().toUpperCase() === normalizedId.toUpperCase(),
  );
  if (localMatch) {
    return localMatch;
  }

  try {
    const detail = await request(`/master-products/${encodeURIComponent(normalizedId)}/detail`);
    const product = detail?.product;
    if (String(product?.productId || "").trim().toUpperCase() === normalizedId.toUpperCase()) {
      return {
        productId: String(product.productId || "").trim(),
        productName: String(product.productName || "").trim(),
      };
    }
  } catch {}

  return null;
}

async function syncSkuProductName(productInputId, productNameInputId, { normalizeProductId = true } = {}) {
  const productInput = $(productInputId);
  const productNameInput = $(productNameInputId);
  if (!productInput || !productNameInput) return null;

  const rawProductId = String(productInput.value || "").trim();
  if (!rawProductId) {
    productNameInput.value = "";
    return null;
  }

  const lookupToken = ++skuProductLookupToken;
  const matched = await findMasterProductByProductId(rawProductId);
  if (lookupToken !== skuProductLookupToken) {
    return matched;
  }

  if (matched?.productId) {
    if (normalizeProductId) {
      productInput.value = matched.productId;
    }
    productNameInput.value = String(matched.productName || "").trim();
    return matched;
  }

  productNameInput.value = "";
  return null;
}

function renderMasterProductOptionsForInput(inputId, listId) {
  const input = $(inputId);
  const datalist = $(listId);
  if (!input || !datalist) return;
  const prev = input.value;
  datalist.innerHTML = getKnownMasterProductsSorted()
    .map(
      (item) =>
        `<option value="${escapeHtml(item.productId)}">${escapeHtml(
          item.productName ? `${item.productId} / ${item.productName}` : item.productId,
        )}</option>`,
    )
    .join("");
  if (prev) input.value = prev;
}

function resolveMoveProductProductId() {
  const control = $("moveProductProductId");
  if (!control) return "";
  const rawProductId = String(control.value || "").trim();
  if (!rawProductId) return "";
  const matched = getKnownMasterProductsSorted().find(
    (item) => String(item?.productId || "").trim().toUpperCase() === rawProductId.toUpperCase(),
  );
  return matched?.productId || rawProductId;
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

function getShelvesSortedForManage() {
  return [...(Array.isArray(state.shelves) ? state.shelves : [])].sort((a, b) =>
    String(a?.shelfCode || "").localeCompare(String(b?.shelfCode || ""), "en", { numeric: true }),
  );
}

function getBoxesSortedForManage() {
  return [...(Array.isArray(state.boxManageRows) ? state.boxManageRows : [])].sort((a, b) =>
    String(a?.boxCode || "").localeCompare(String(b?.boxCode || ""), "en", { numeric: true }),
  );
}

function resetShelfManageVisibleCount() {
  state.shelfManageVisibleCount = state.manageModalInitialPageSize;
}

function resetBoxManageVisibleCount() {
  state.boxManageVisibleCount = state.boxManagePageSize;
}

function increaseShelvesManageVisibleCount() {
  const total = getShelvesSortedForManage().length;
  if (state.shelfManageVisibleCount >= total) return false;
  state.shelfManageVisibleCount = Math.min(total, state.shelfManageVisibleCount + state.manageModalLoadStep);
  renderShelvesManageTable();
  return true;
}

function increaseBoxesManageVisibleCount() {
  const total = getBoxesSortedForManage().length;
  if (state.boxManageVisibleCount >= total) {
    if (state.boxManageHasMore) {
      loadBoxManagePage({ reset: false }).catch((error) => showToast(error.message, true));
    }
    return false;
  }
  state.boxManageVisibleCount = Math.min(total, state.boxManageVisibleCount + state.boxManagePageSize);
  renderBoxesManageTable();
  return true;
}

function loadMoreShelvesManageIfNeeded() {
  const wrap = $("shelfManageTableWrap");
  if (!wrap) return;
  const total = getShelvesSortedForManage().length;
  if (state.shelfManageVisibleCount >= total) return;
  if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 24) return;
  increaseShelvesManageVisibleCount();
}

function loadMoreBoxesManageIfNeeded() {
  const wrap = $("boxManageTableWrap");
  if (!wrap) return;
  const total = getBoxesSortedForManage().length;
  if (state.boxManageVisibleCount >= total) {
    if (state.boxManageHasMore) {
      loadBoxManagePage({ reset: false }).catch((error) => showToast(error.message, true));
    }
    return;
  }
  if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 24) return;
  increaseBoxesManageVisibleCount();
}

function maybeAutoLoadShelvesManage() {
  const modal = $("shelfManageModal");
  if (!modal || modal.classList.contains("hidden")) return;
  const tableWrap = $("shelfManageTableWrap");
  if (!tableWrap) return;
  const total = getShelvesSortedForManage().length;
  if (state.shelfManageVisibleCount >= total) return;

  const threshold = 120;
  const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
  if (currentBottom < tableWrap.scrollHeight - threshold) return;

  loadMoreShelvesManageIfNeeded();
}

function maybeAutoLoadBoxesManage() {
  const modal = $("boxManageModal");
  if (!modal || modal.classList.contains("hidden")) return;
  const tableWrap = $("boxManageTableWrap");
  if (!tableWrap) return;
  const total = getBoxesSortedForManage().length;
  if (state.boxManageVisibleCount >= total && !state.boxManageHasMore) return;

  const threshold = 120;
  const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
  if (currentBottom < tableWrap.scrollHeight - threshold) return;

  loadMoreBoxesManageIfNeeded();
}

function setupShelfManageLoadObserver() {
  if (shelfManageLoadObserver) {
    shelfManageLoadObserver.disconnect();
    shelfManageLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("shelfManageTableWrap");
  const sentinel = $("shelfManageLoadSentinel");
  if (!tableWrap || !sentinel) return;

  shelfManageLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        increaseShelvesManageVisibleCount();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  shelfManageLoadObserver.observe(sentinel);
}

function setupBoxManageLoadObserver() {
  if (boxManageLoadObserver) {
    boxManageLoadObserver.disconnect();
    boxManageLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("boxManageTableWrap");
  const sentinel = $("boxManageLoadSentinel");
  if (!tableWrap || !sentinel) return;

  boxManageLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        increaseBoxesManageVisibleCount();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  boxManageLoadObserver.observe(sentinel);
}

function buildShelfManageSelectOptions(selectedShelfId) {
  const selected = String(selectedShelfId || "");
  const rows = getShelvesSortedForManage();
  return rows
    .map((shelf) => {
      const shelfId = String(shelf.id || "");
      const selectedAttr = shelfId === selected ? " selected" : "";
      const statusSuffix = Number(shelf?.status) === 1 ? "" : "（禁用）";
      const nameSuffix = shelf?.name ? ` / ${shelf.name}` : "";
      return `<option value="${escapeHtml(shelfId)}"${selectedAttr}>${escapeHtml(
        `${shelf?.shelfCode || "-"}${nameSuffix}${statusSuffix}`,
      )}</option>`;
    })
    .join("");
}

function renderShelvesManageTable() {
  const body = $("shelfManageBody");
  if (!body) return;
  const rows = getShelvesSortedForManage();
  const visibleCount = Math.min(
    rows.length,
    Math.max(state.shelfManageVisibleCount || 0, state.manageModalInitialPageSize),
  );
  state.shelfManageVisibleCount = visibleCount;
  const visibleRows = rows.slice(0, visibleCount);
  body.innerHTML =
    visibleRows
      .map((item) => {
        const itemId = String(item.id);
        const editing = state.shelfEditingIds.has(itemId);
        return `
      <tr>
        <td>
          <input
            id="shelfCodeManage-${escapeHtml(item.id)}"
            value="${escapeHtml(item.shelfCode || "")}"
            maxlength="64"
            ${editing ? "" : "readonly"}
            data-original-code="${escapeHtml(item.shelfCode || "")}"
          />
        </td>
        <td>
          <input
            id="shelfNameManage-${escapeHtml(item.id)}"
            value="${escapeHtml(item.name || "")}"
            maxlength="128"
            ${editing ? "" : "readonly"}
            data-original-name="${escapeHtml(item.name || "")}"
          />
        </td>
        <td>
          <button class="tiny-btn" data-action="editShelfManage" data-id="${escapeHtml(item.id)}">${editing ? "确认变更" : "变更"}</button>
          <button class="tiny-btn danger" data-action="deleteShelfManage" data-id="${escapeHtml(item.id)}" data-code="${escapeHtml(item.shelfCode || "")}">删除</button>
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="3" class="muted">-</td></tr>';
  const tableRows = body.querySelectorAll("tr");
  visibleRows.forEach((item, index) => {
    const actionCell = tableRows[index]?.lastElementChild;
    if (!actionCell) return;
    actionCell.insertAdjacentHTML(
      "afterbegin",
      `<button class="tiny-btn secondary" data-action="queryShelfManage" data-id="${escapeHtml(item.id)}" data-code="${escapeHtml(item.shelfCode || "")}">查询</button>`,
    );
  });
  setupShelfManageLoadObserver();
  maybeAutoLoadShelvesManage();
}

function renderBoxesManageTable() {
  const body = $("boxManageBody");
  if (!body) return;
  const rows = getBoxesSortedForManage();
  const visibleCount = Math.min(
    rows.length,
    Math.max(state.boxManageVisibleCount || 0, state.manageModalInitialPageSize),
  );
  state.boxManageVisibleCount = visibleCount;
  const visibleRows = rows.slice(0, visibleCount);
  const rowHtml =
    visibleRows
      .map((item) => {
        const itemId = String(item.id);
        const editing = state.boxEditingIds.has(itemId);
        const shelfOptions = buildShelfManageSelectOptions(item?.shelf?.id);
        const archiveReleaseAction = item?.canArchiveRelease
          ? `<button class="tiny-btn secondary" data-action="archiveReleaseBoxManage" data-id="${escapeHtml(item.id)}" data-code="${escapeHtml(item.boxCode || "")}">归档释放</button>`
          : "";
        return `
      <tr>
        <td>
          <input
            id="boxCodeManage-${escapeHtml(item.id)}"
            value="${escapeHtml(item.boxCode || "")}"
            maxlength="128"
            ${editing ? "" : "readonly"}
            data-original-code="${escapeHtml(item.boxCode || "")}"
          />
        </td>
        <td>
          <select
            id="boxShelfManage-${escapeHtml(item.id)}"
            ${editing ? "" : "disabled"}
            data-original-shelf-id="${escapeHtml(item?.shelf?.id || "")}"
          >
            ${shelfOptions}
          </select>
        </td>
        <td>
          <button class="tiny-btn secondary" data-action="queryBoxManage" data-id="${escapeHtml(item.id)}" data-code="${escapeHtml(item.boxCode || "")}">查询</button>
          ${archiveReleaseAction}
          <button class="tiny-btn" data-action="editBoxManage" data-id="${escapeHtml(item.id)}">${editing ? "确认变更" : "变更"}</button>
        </td>
      </tr>
    `;
      })
      .join("");
  const loadingRow = state.boxManageLoading
    ? '<tr><td colspan="3" class="muted">正在加载箱号...</td></tr>'
    : "";
  const moreRow = !state.boxManageLoading && state.boxManageHasMore
    ? '<tr><td colspan="3" class="muted">继续下滑加载更多箱号。</td></tr>'
    : "";
  body.innerHTML = rowHtml || loadingRow || '<tr><td colspan="3" class="muted">-</td></tr>';
  if (rowHtml && (loadingRow || moreRow)) {
    body.insertAdjacentHTML("beforeend", loadingRow || moreRow);
  }
  setupBoxManageLoadObserver();
  maybeAutoLoadBoxesManage();
}

function collectBoxBlockedReasonLines(box) {
  const lines = [];
  const archiveReleaseBlockedReasons = Array.isArray(box?.archiveReleaseBlockedReasons)
    ? box.archiveReleaseBlockedReasons.map((reason) => String(reason || "").trim()).filter((reason) => Boolean(reason))
    : [];

  if (!box?.canArchiveRelease && archiveReleaseBlockedReasons.length) {
    lines.push(`不可归档释放：${archiveReleaseBlockedReasons.join("；")}`);
  }

  return lines;
}

function renderEmptyBoxManageBadge() {
  const badge = $("emptyBoxManageBadge");
  if (!badge) return;
  const count = Array.isArray(state.emptyBoxes) ? state.emptyBoxes.length : 0;
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count <= 0);
}

function renderEmptyBoxManageTable() {
  const body = $("emptyBoxManageBody");
  if (!body) return;
  const rows = Array.isArray(state.emptyBoxes) ? state.emptyBoxes : [];
  body.innerHTML =
    rows
      .map((item) => {
        const shelfLabel = formatShelfCodeWithName({
          shelfCode: item?.shelfCode,
          name: item?.shelfName,
        });
        return `
      <tr>
        <td>${escapeHtml(displayText(item?.boxCode))}</td>
        <td>${escapeHtml(displayText(shelfLabel))}</td>
        <td>
          <button
            class="tiny-btn danger"
            data-action="deleteEmptyBox"
            data-id="${escapeHtml(item?.id || "")}"
            data-code="${escapeHtml(item?.boxCode || "")}"
          >
            废除
          </button>
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="3" class="muted">-</td></tr>';
}

function canSelectProductEditRequestForBatchConfirm(item) {
  if (!item || String(item?.status || "") !== "pending") {
    return false;
  }
  const permission = resolveProductEditConfirmPermission(item?.changedFields);
  return permission.allowed;
}

function syncSelectedProductEditRequestIds() {
  const selectableIds = new Set(
    state.skuEditRequests
      .filter((item) => canSelectProductEditRequestForBatchConfirm(item))
      .map((item) => String(item.id)),
  );
  state.selectedProductEditRequestIds = new Set(
    [...state.selectedProductEditRequestIds].filter((id) => selectableIds.has(String(id))),
  );
}

function updateProductEditRequestSelectAll() {
  const selectAll = $("productEditSelectAll");
  if (!selectAll) return;
  const visibleRows = state.skuEditRequests;
  const selectableRows = visibleRows.filter((item) => canSelectProductEditRequestForBatchConfirm(item));

  if (!selectableRows.length) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }

  const selectedCount = selectableRows.filter((item) =>
    state.selectedProductEditRequestIds.has(String(item.id)),
  ).length;

  selectAll.checked = selectedCount > 0 && selectedCount === selectableRows.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < selectableRows.length;
}

function renderProductEditRequestTable() {
  const body = $("productEditRequestBody");
  if (!body) return;
  const rows = state.skuEditRequests;

  body.innerHTML =
      rows
        .map((item) => {
          const requestId = String(item?.id || "");
          const skuText = getProductEditRequestSkuText(item);
          const statusText = getProductEditRequestStatusText(item?.status);
          const creatorText = item?.creator?.username || "-";
          const canDelete = item?.status === "pending";
        const canBatchConfirm = canSelectProductEditRequestForBatchConfirm(item);
        const checkedAttr = canBatchConfirm && state.selectedProductEditRequestIds.has(requestId) ? " checked" : "";
        return `
      <tr>
        <td><input type="checkbox" data-action="toggleProductEditRequestSelect" data-id="${escapeHtml(requestId)}"${
          canBatchConfirm ? "" : " disabled"
        }${checkedAttr} /></td>
        <td>${escapeHtml(formatDate(item?.createdAt))}</td>
        <td>${escapeHtml(displayText(skuText))}</td>
        <td><span class="edit-request-status">${escapeHtml(statusText)}</span></td>
        <td>${escapeHtml(displayText(creatorText))}</td>
        <td>
          <button class="tiny-btn" data-action="openProductEditRequestDetail" data-id="${escapeHtml(item?.id)}">编辑详情</button>
          ${
            canDelete
              ? `<button class="tiny-btn danger" data-action="deleteProductEditRequestRow" data-id="${escapeHtml(item?.id)}">删除</button>`
              : ""
          }
        </td>
      </tr>
    `;
      })
      .join("") || '<tr><td colspan="6" class="muted">-</td></tr>';
  updateProductEditRequestSelectAll();
}

function loadMoreProductEditRequestsIfNeeded() {
  const panel = $("productManagement");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.skuEditRequestsLoading || !state.skuEditRequestsHasMore) return;
  loadProductEditRequests({ reset: false }).catch((error) => showToast(error.message, true));
}

function setupProductEditRequestLoadObserver() {
  if (productEditRequestLoadObserver) {
    productEditRequestLoadObserver.disconnect();
    productEditRequestLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("productEditRequestTableWrap");
  const sentinel = $("productEditRequestLoadSentinel");
  if (!tableWrap || !sentinel) return;

  productEditRequestLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreProductEditRequestsIfNeeded();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  productEditRequestLoadObserver.observe(sentinel);
}

function loadMoreSkuManagementIfNeeded() {
  const panel = $("skuManagement");
  if (!panel || !panel.classList.contains("active")) return;
  const total = getSkuManagementFilteredRows().length;
  if (state.skuManagementVisibleCount >= total) return;
  state.skuManagementVisibleCount += state.inventoryListPageSize;
  renderSkuManagementTable();
}

function maybeAutoLoadSkuManagement() {
  const panel = $("skuManagement");
  if (!panel || !panel.classList.contains("active")) return;
  const tableWrap = $("skuManagementTableWrap");
  if (!tableWrap || tableWrap.classList.contains("hidden")) return;
  const total = getSkuManagementFilteredRows().length;
  if (state.skuManagementVisibleCount >= total) return;

  const threshold = 120;
  const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
  if (currentBottom < tableWrap.scrollHeight - threshold) return;

  loadMoreSkuManagementIfNeeded();
}

function setupSkuManagementLoadObserver() {
  if (skuManagementLoadObserver) {
    skuManagementLoadObserver.disconnect();
    skuManagementLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("skuManagementTableWrap");
  const sentinel = $("skuManagementLoadSentinel");
  if (!tableWrap || !sentinel) return;

  skuManagementLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreSkuManagementIfNeeded();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  skuManagementLoadObserver.observe(sentinel);
}

function renderProductEditRequestDetail(item) {
  const meta = $("productEditRequestMeta");
  const compare = $("productEditRequestCompare");
  const confirmBtn = $("confirmProductEditRequestBtn");
  if (!meta || !compare || !confirmBtn) return;

  if (!item) {
    state.selectedProductEditRequestId = null;
    state.selectedProductEditRequestChangedFields = [];
    meta.innerHTML = "";
    compare.innerHTML = '<div class="muted">暂无数据</div>';
    confirmBtn.classList.add("hidden");
    return;
  }

  state.selectedProductEditRequestId = Number(item.id);
  state.selectedProductEditRequestChangedFields = normalizeProductEditChangedFields(item?.changedFields);
  const skuText = getProductEditRequestSkuText(item);
  meta.innerHTML = `
    <div><strong>SKU：</strong>${escapeHtml(displayText(skuText))}</div>
    <div><strong>申请人：</strong>${escapeHtml(displayText(item?.creator?.username))}</div>
    <div><strong>申请时间：</strong>${escapeHtml(formatDate(item?.createdAt))}</div>
    <div><strong>状态：</strong>${escapeHtml(getProductEditRequestStatusText(item?.status))}</div>
  `;

  const fieldDefs = [
    ["productId", "产品ID"],
    ["productName", "产品名称"],
    ["shop", "所属亚马逊店铺"],
    ["remark", "备注"],
    ["sku", "SKU"],
    ["asin", "ASIN"],
    ["fnsku", "FNSKU"],
    ["fbmSku", "FBMSKU"],
    ["rbSku", "rbSKU"],
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
  const canShowConfirmButton = item?.status === "pending";
  confirmBtn.classList.toggle("hidden", !canShowConfirmButton);
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
  if (/^\d{1,6}$/.test(value)) {
    return value.padStart(Math.max(3, value.length), "0");
  }
  return value;
}

function resolveEnabledBoxCode(raw) {
  const normalized = normalizeBoxCodeInput(raw);
  if (!normalized) return "";
  const found = getEnabledBoxesSorted().find((box) => normalizeBoxCodeInput(box?.boxCode) === normalized);
  return found?.boxCode || "";
}

function findEnabledBoxByCode(raw) {
  const normalized = normalizeBoxCodeInput(raw);
  if (!normalized) return null;
  return (
    getEnabledBoxesSorted().find((box) => normalizeBoxCodeInput(box?.boxCode) === normalized) || null
  );
}

function upsertEnabledBox(box) {
  if (!box || !box.id) return;
  const next = Array.isArray(state.boxes) ? [...state.boxes] : [];
  const index = next.findIndex((item) => String(item?.id) === String(box.id));
  if (index >= 0) {
    next[index] = { ...next[index], ...box };
  } else {
    next.push(box);
  }
  state.boxes = next;
}

async function resolveEnabledBoxCodeLive(raw) {
  const local = resolveEnabledBoxCode(raw);
  if (local) return local;

  const normalized = normalizeBoxCodeInput(raw);
  if (!normalized) return "";

  try {
    const boxes = await request(`/boxes?q=${encodeURIComponent(normalized)}`);
    const matched = (Array.isArray(boxes) ? boxes : []).find(
      (box) => normalizeBoxCodeInput(box?.boxCode) === normalized && Number(box?.status) === 1,
    );
    if (!matched?.boxCode) return "";
    upsertEnabledBox(matched);
    return matched.boxCode;
  } catch {
    return "";
  }
}

function getEnabledShelvesSorted() {
  return state.shelves
    .filter((shelf) => Number(shelf.status) === 1)
    .sort((a, b) => String(a.shelfCode).localeCompare(String(b.shelfCode), "en", { numeric: true }));
}

function formatShelfCodeWithName(shelf) {
  const rawCode = shelf && typeof shelf === "object" ? shelf?.shelfCode : shelf;
  const shelfCode = normalizeShelfCodeInput(rawCode);
  if (!shelfCode) return "";

  let shelfName = "";
  if (shelf && typeof shelf === "object") {
    shelfName = String(shelf?.name || "").trim();
  }
  if (!shelfName) {
    const matched = (Array.isArray(state.shelves) ? state.shelves : []).find(
      (item) => normalizeShelfCodeInput(item?.shelfCode) === shelfCode,
    );
    shelfName = String(matched?.name || "").trim();
  }

  return shelfName ? `${shelfCode}-${shelfName}` : shelfCode;
}

function normalizeShelfCodeInput(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (!value) return "";
  const labeled = value.match(/^((?:00)|(?:[A-Z][0-9]))\s*[-_/].*$/);
  if (labeled) {
    return labeled[1];
  }
  if (/^(?:00|[A-Z][0-9])$/.test(value)) {
    return value;
  }
  return value;
}

function resolveEnabledShelfCode(raw, excludeShelfId = null) {
  const normalized = normalizeShelfCodeInput(raw);
  if (!normalized) return "";
  const found = getEnabledShelvesSorted().find((shelf) => {
    if (excludeShelfId && String(shelf.id) === String(excludeShelfId)) return false;
    return normalizeShelfCodeInput(shelf?.shelfCode) === normalized;
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
    const shelfCode = String(shelf.shelfCode || "");
    const shelfName = String(shelf.name || "");
    const shelfLabel = formatShelfCodeWithName(shelf);
    if (digits) return shelfCode.replace(/\D/g, "").includes(digits);
    return (
      shelfCode.toUpperCase().includes(raw) ||
      shelfName.toUpperCase().includes(raw) ||
      shelfLabel.toUpperCase().includes(raw)
    );
  });
  datalist.innerHTML = matches
    .map((shelf) => `<option value="${escapeHtml(formatShelfCodeWithName(shelf))}"></option>`)
    .join("");
  if (prev) input.value = prev;
}

function syncMoveShelfCurrentDisplay() {
  const currentInput = $("moveShelfCurrentCode");
  if (!currentInput) return;
  const box = findEnabledBoxByCode($("moveShelfBoxCode")?.value || "");
  currentInput.value = formatShelfCodeWithName(box?.shelf);
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
  shelfInput.value = formatShelfCodeWithName(box?.shelf);
}

function syncMoveProductNewShelfDisplay() {
  const shelfInput = $("moveProductNewShelfCode");
  if (!shelfInput) return;
  const newBoxCode = resolveEnabledBoxCode($("moveProductNewBoxCode")?.value || "");
  const box = findEnabledBoxByCode(newBoxCode);
  shelfInput.value = formatShelfCodeWithName(box?.shelf);
}

async function refreshMoveProductOldBoxOptionsByProduct() {
  const productId = resolveMoveProductProductId();
  const select = $("moveProductOldBoxCode");
  const hint = $("moveProductOldBoxHint");
  if (!select) return;

  if (!productId) {
    select.innerHTML = '<option value="">请先选择产品ID</option>';
    if (hint) hint.classList.add("hidden");
    syncMoveProductOldShelfDisplay();
    return;
  }

  const rows = (await request(`/inventory/master-product-boxes?productId=${encodeURIComponent(productId)}`))
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

async function loadProductEditRequests({ reset = true } = {}) {
  if (state.skuEditRequestsLoading) return;
  state.skuEditRequestsLoading = true;
  const targetPage = reset ? 1 : state.skuEditRequestsPage;
  try {
    const result = await request(
      `/sku-edit-requests?page=${targetPage}&pageSize=${state.skuEditRequestsPageSize}`,
    );
    const items = Array.isArray(result?.items) ? result.items : [];
    state.skuEditRequests = reset ? items : state.skuEditRequests.concat(items);
    state.skuEditRequestsHasMore = Boolean(result?.hasMore);
    state.skuEditRequestsPage = targetPage + 1;
    syncSelectedProductEditRequestIds();
    renderProductEditRequestTable();
  } finally {
    state.skuEditRequestsLoading = false;
  }
}

function getMasterProductSyncOperationText(value) {
  const map = {
    bulk_upload: "批量上传",
    manual_sync: "手动同步",
    scheduled_sync: "定时同步",
  };
  return map[String(value || "")] || displayText(value);
}

function getMasterProductSyncStatusText(value) {
  const map = {
    running: "执行中",
    success: "成功",
    failed: "失败",
  };
  return map[String(value || "")] || displayText(value);
}

function setMasterProductView(view) {
  state.masterProductView = view;
  $("masterProductListSection")?.classList.toggle("hidden", view !== "list");
  $("masterProductDetailSection")?.classList.toggle("hidden", view !== "detail");
  $("masterProductSyncRecordsSection")?.classList.toggle("hidden", view !== "syncRecords");
}

function renderMasterProductTable() {
  const body = $("masterProductBody");
  const loadMoreBtn = $("loadMoreMasterProductsBtn");
  if (!body) return;

  const rows = Array.isArray(state.masterProducts) ? state.masterProducts : [];
  body.innerHTML =
    rows
      .map((item) => {
        const productId = String(item?.productId || "").trim();
        return `
          <tr>
            <td>${escapeHtml(displayText(productId))}</td>
            <td>${escapeHtml(displayText(item?.productName))}</td>
            <td>${escapeHtml(displayText(item?.productType))}</td>
            <td>${escapeHtml(displayText(item?.bagBrand))}</td>
            <td>${escapeHtml(displayText(item?.color))}</td>
            <td>${escapeHtml(displayText(item?.bagType))}</td>
            <td>${escapeHtml(displayText(item?.size))}</td>
            <td class="master-product-current-cell">${escapeHtml(displayText(item?.stockQty ?? 0))}</td>
            <td>
              <button type="button" class="tiny-btn" data-action="openMasterProductDetail" data-product-id="${escapeHtml(productId)}">查看详情</button>
            </td>
          </tr>
        `;
      })
      .join("") || '<tr><td colspan="9" class="muted">-</td></tr>';

  if (loadMoreBtn) {
    loadMoreBtn.classList.toggle("hidden", !state.masterProductsHasMore);
  }
}

async function loadMasterProducts({ reset = false } = {}) {
  const page = reset ? 1 : state.masterProductsPage + 1;
  const keyword = String(state.masterProductKeyword || "").trim();
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(state.masterProductsPageSize),
  });
  if (keyword) {
    params.set("keyword", keyword);
  }

  const result = await request(`/master-products?${params.toString()}`);
  const items = Array.isArray(result?.items) ? result.items : [];
  state.masterProducts = reset ? items : [...state.masterProducts, ...items];
  state.masterProductsPage = Number(result?.page || page);
  state.masterProductsHasMore = Boolean(result?.hasMore);
  renderMasterProductTable();
}

function renderMasterProductExportOptions(field, values) {
  const select = $(`masterProductExport_${field}`);
  if (!select) return;
  const prev = select.value;
  const items = Array.isArray(values) ? values : [];
  select.innerHTML = `<option value="">全部</option>${items
    .map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
    .join("")}`;
  if (prev && items.includes(prev)) {
    select.value = prev;
  }
}

async function loadMasterProductExportFilterOptions(force = false) {
  if (!force && state.masterProductExportFilterOptions) {
    return state.masterProductExportFilterOptions;
  }
  const result = await request("/master-products/export-filter-options");
  state.masterProductExportFilterOptions = result || {};
  [
    "productType",
    "bagBrand",
    "color",
    "bagType",
    "patternType",
    "size",
  ].forEach((field) => renderMasterProductExportOptions(field, state.masterProductExportFilterOptions?.[field]));
  return state.masterProductExportFilterOptions;
}

function renderMasterProductDetailMeta(product) {
  renderProductSummaryMeta("masterProductDetailMeta", product);
}

function renderMasterProductSkuTable(detail) {
  renderProductSkuTable(detail, { bodyId: "masterProductSkuBody", selectId: "masterProductFbaSkuId" });
}

function renderMasterProductBoxTable(detail) {
  renderProductBoxTable(detail, { bodyId: "masterProductBoxBody", actionPrefix: "MasterProduct" });
}

function renderMasterProductDetail(detail) {
  state.selectedMasterProductDetail = detail || null;
  state.selectedMasterProductId = String(detail?.product?.productId || "");
  $("masterProductDetailTitle").textContent = detail?.product?.productName
    ? `主商品详情：${detail.product.productName}`
    : "主商品详情";
  $("masterProductDetailSubtitle").textContent = detail?.product?.productId
    ? `产品ID：${detail.product.productId}`
    : "-";
  renderMasterProductDetailMeta(detail?.product);
  renderMasterProductSkuTable(detail);
  renderMasterProductBoxTable(detail);
  resetMasterProductDetailForms();
  const printerInput = $("masterProductYamatoPrinterName");
  if (printerInput) {
    printerInput.value = String(detail?.product?.yamatoPrinterName || "").trim();
  }
}

async function loadMasterProductDetail(productId) {
  const detail = await request(`/master-products/${encodeURIComponent(productId)}/detail`);
  renderMasterProductDetail(detail);
  setMasterProductView("detail");
  return detail;
}

async function updateMasterProductPrintSettings(productId, payload) {
  return request(`/master-products/${encodeURIComponent(productId)}/print-settings`, {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

function renderMasterProductSyncRecords() {
  const body = $("masterProductSyncRecordBody");
  const loadMoreBtn = $("loadMoreMasterProductSyncRecordsBtn");
  if (!body) return;
  const rows = Array.isArray(state.masterProductSyncRecords) ? state.masterProductSyncRecords : [];
  body.innerHTML =
    rows
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(formatDate(item?.executedAt))}</td>
            <td>${escapeHtml(getMasterProductSyncOperationText(item?.operationType))}</td>
            <td><span class="master-product-status-chip ${escapeHtml(String(item?.status || ""))}">${escapeHtml(
              getMasterProductSyncStatusText(item?.status),
            )}</span></td>
            <td>${escapeHtml(displayText(item?.operatorName))}</td>
            <td>${escapeHtml(displayText(item?.fetchedCount ?? 0))}</td>
            <td>${escapeHtml(displayText(item?.createdCount ?? 0))}</td>
            <td>${escapeHtml(displayText(item?.updatedCount ?? 0))}</td>
            <td>${escapeHtml(displayText(item?.errorMessage))}</td>
          </tr>
        `,
      )
      .join("") || '<tr><td colspan="8" class="muted">-</td></tr>';
  if (loadMoreBtn) {
    loadMoreBtn.classList.toggle("hidden", !state.masterProductSyncRecordsHasMore);
  }
}

async function loadMasterProductSyncRecords({ reset = false } = {}) {
  const page = reset ? 1 : state.masterProductSyncRecordsPage + 1;
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(state.masterProductSyncRecordsPageSize),
  });
  const result = await request(`/master-products/sync-records?${params.toString()}`);
  const items = Array.isArray(result?.items) ? result.items : [];
  state.masterProductSyncRecords = reset ? items : [...state.masterProductSyncRecords, ...items];
  state.masterProductSyncRecordsPage = Number(result?.page || page);
  state.masterProductSyncRecordsHasMore = Boolean(result?.hasMore);
  renderMasterProductSyncRecords();
}

function renderRakutenComboProductItems(items) {
  if (!Array.isArray(items) || !items.length) {
    return '<span class="muted">-</span>';
  }
  return items
    .map((item) => {
      const productId = String(item?.productId || "").trim();
      const productName = String(item?.productName || "").trim();
      return `${escapeHtml(productId)}：${escapeHtml(productName || "-")}`;
    })
    .join("<br />");
}

function renderRakutenComboProductTable() {
  const body = $("rakutenComboProductBody");
  const summary = $("rakutenComboProductSummary");
  if (!body) return;
  const rows = Array.isArray(state.rakutenComboProducts) ? state.rakutenComboProducts : [];
  if (summary) {
    const shown = rows.length;
    summary.textContent = `共 ${state.rakutenComboProductsTotal || 0} 个组合产品，已显示 ${shown} 个`;
  }
  body.innerHTML =
    rows
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(displayText(item?.comboName))}</td>
            <td>${escapeHtml(displayText(item?.itemCount ?? 0))}</td>
            <td>${renderRakutenComboProductItems(item?.items)}</td>
            <td>${escapeHtml(formatDate(item?.updatedAt))}</td>
            <td>
              <button type="button" class="tiny-btn" data-action="editRakutenComboProduct" data-combo-id="${escapeHtml(String(item?.id || ""))}">更改</button>
            </td>
          </tr>
        `,
      )
      .join("") || '<tr><td colspan="5" class="muted">-</td></tr>';
}

async function loadRakutenComboProducts({ reset = false } = {}) {
  if (state.rakutenComboProductsLoading) return;
  const page = reset ? 1 : state.rakutenComboProductsPage + 1;
  const keyword = String(state.rakutenComboProductKeyword || "").trim();
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(state.rakutenComboProductsPageSize),
  });
  if (keyword) {
    params.set("keyword", keyword);
  }
  state.rakutenComboProductsLoading = true;
  try {
    const result = await request(`/rakuten-combo-products?${params.toString()}`);
    const items = Array.isArray(result?.items) ? result.items : [];
    state.rakutenComboProducts = reset ? items : [...state.rakutenComboProducts, ...items];
    state.rakutenComboProductsPage = Number(result?.page || page);
    state.rakutenComboProductsHasMore = Boolean(result?.hasMore);
    state.rakutenComboProductsTotal = Number(result?.total ?? state.rakutenComboProducts.length);
    renderRakutenComboProductTable();
    requestAnimationFrame(() => {
      maybeAutoLoadRakutenComboProducts();
    });
  } finally {
    state.rakutenComboProductsLoading = false;
  }
}

function loadMoreRakutenComboProductsIfNeeded() {
  const panel = $("rakutenComboProductManagement");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.rakutenComboProductsLoading || !state.rakutenComboProductsHasMore) return;
  loadRakutenComboProducts({ reset: false }).catch((error) => showToast(error.message, true));
}

function maybeAutoLoadRakutenComboProducts() {
  const panel = $("rakutenComboProductManagement");
  if (!panel || !panel.classList.contains("active")) return;
  const tableWrap = $("rakutenComboProductTableWrap");
  if (!tableWrap) return;
  if (state.rakutenComboProductsLoading || !state.rakutenComboProductsHasMore) return;

  const threshold = 120;
  const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
  if (currentBottom < tableWrap.scrollHeight - threshold) return;

  loadMoreRakutenComboProductsIfNeeded();
}

function setupRakutenComboProductLoadObserver() {
  if (rakutenComboProductLoadObserver) {
    rakutenComboProductLoadObserver.disconnect();
    rakutenComboProductLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("rakutenComboProductTableWrap");
  const sentinel = $("rakutenComboProductLoadSentinel");
  if (!tableWrap || !sentinel) return;

  rakutenComboProductLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreRakutenComboProductsIfNeeded();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  rakutenComboProductLoadObserver.observe(sentinel);
}

function addRakutenComboProductDraftItem(productId = "", productName = "") {
  if (state.rakutenComboProductDraftItems.length >= 10) {
    showToast("组合产品最多添加 10 个产品", true);
    return;
  }
  state.rakutenComboProductDraftItems.push({
    productId: String(productId || "").trim(),
    productName: String(productName || "").trim(),
    loading: false,
  });
  renderRakutenComboProductDraftItems();
}

function removeRakutenComboProductDraftItem(index) {
  state.rakutenComboProductDraftItems.splice(index, 1);
  if (!state.rakutenComboProductDraftItems.length) {
    addRakutenComboProductDraftItem();
    return;
  }
  renderRakutenComboProductDraftItems();
}

function renderRakutenComboProductDraftItems() {
  const container = $("rakutenComboProductItems");
  if (!container) return;
  container.innerHTML = state.rakutenComboProductDraftItems
    .map((item, index) => {
      const productNameText = item.loading ? "查询中..." : displayText(item.productName);
      return `
        <div class="rakuten-combo-product-item-row" data-index="${index}">
          <label>
            产品ID
            <input class="rakuten-combo-product-id-input" data-index="${index}" value="${escapeHtml(item.productId)}" placeholder="输入产品ID" />
          </label>
          <label>
            产品名称
            <div class="rakuten-combo-product-name-display">${escapeHtml(productNameText)}</div>
          </label>
          <button type="button" class="tiny-btn ghost" data-action="removeRakutenComboProductItem" data-index="${index}">删除</button>
        </div>
      `;
    })
    .join("");
  const addBtn = $("addRakutenComboProductItemBtn");
  if (addBtn) {
    addBtn.disabled = state.rakutenComboProductDraftItems.length >= 10;
  }
}

function openCreateRakutenComboProductModal() {
  $("createRakutenComboProductForm")?.reset();
  state.rakutenComboProductEditingId = "";
  if ($("rakutenComboProductEditingId")) {
    $("rakutenComboProductEditingId").value = "";
  }
  if ($("rakutenComboProductModalTitle")) {
    $("rakutenComboProductModalTitle").textContent = "新增乐天组合产品";
  }
  state.rakutenComboProductDraftItems = [];
  addRakutenComboProductDraftItem();
  openModal("createRakutenComboProductModal");
}

function openEditRakutenComboProductModal(comboId) {
  const combo = state.rakutenComboProducts.find((item) => String(item?.id || "") === String(comboId || ""));
  if (!combo) {
    showToast("未找到组合产品，请刷新后重试", true);
    return;
  }
  $("createRakutenComboProductForm")?.reset();
  state.rakutenComboProductEditingId = String(combo.id || "");
  if ($("rakutenComboProductEditingId")) {
    $("rakutenComboProductEditingId").value = state.rakutenComboProductEditingId;
  }
  if ($("rakutenComboProductModalTitle")) {
    $("rakutenComboProductModalTitle").textContent = "更改乐天组合产品";
  }
  if ($("rakutenComboProductName")) {
    $("rakutenComboProductName").value = String(combo.comboName || "");
  }
  state.rakutenComboProductDraftItems = [];
  const items = Array.isArray(combo.items) ? combo.items : [];
  items.forEach((item) => {
    state.rakutenComboProductDraftItems.push({
      productId: String(item?.productId || "").trim(),
      productName: String(item?.productName || "").trim(),
      loading: false,
    });
  });
  if (!state.rakutenComboProductDraftItems.length) {
    state.rakutenComboProductDraftItems.push({
      productId: "",
      productName: "",
      loading: false,
    });
  }
  renderRakutenComboProductDraftItems();
  openModal("createRakutenComboProductModal");
}

async function lookupRakutenComboProductDraftItem(index) {
  const item = state.rakutenComboProductDraftItems[index];
  if (!item) return;
  const productId = String(item.productId || "").trim();
  if (!productId) {
    item.productName = "";
    renderRakutenComboProductDraftItems();
    return;
  }
  item.loading = true;
  renderRakutenComboProductDraftItems();
  try {
    const detail = await request(`/master-products/${encodeURIComponent(productId)}/detail`);
    item.productName = String(detail?.product?.productName || "").trim();
  } catch (error) {
    item.productName = "";
    showToast(error.message, true);
  } finally {
    item.loading = false;
    renderRakutenComboProductDraftItems();
  }
}

function collectRakutenComboProductPayload() {
  const comboName = String($("rakutenComboProductName")?.value || "").trim();
  const productIds = state.rakutenComboProductDraftItems
    .map((item) => String(item.productId || "").trim())
    .filter(Boolean);
  return {
    id: String($("rakutenComboProductEditingId")?.value || state.rakutenComboProductEditingId || "").trim(),
    comboName,
    productIds,
  };
}

function buildMasterProductExportPayload() {
  const payload = {};
  [
    "keyword",
    "productId",
    "productName",
    "productType",
    "bagBrand",
    "color",
    "bagType",
    "patternType",
    "size",
  ].forEach((field) => {
    const value = String($(`masterProductExport_${field}`)?.value || "").trim();
    if (value) {
      payload[field] = value;
    }
  });
  ["stockQtyMin", "stockQtyMax"].forEach((field) => {
    const raw = String($(`masterProductExport_${field}`)?.value || "").trim();
    if (!raw) return;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 0) {
      payload[field] = value;
    }
  });
  return payload;
}

function resetMasterProductExportForm() {
  $("masterProductExportForm")?.reset();
  if (state.masterProductExportFilterOptions) {
    loadMasterProductExportFilterOptions(true).catch(() => {});
  }
}

function resetMasterProductDetailForms() {
  $("masterProductManualAdjustForm")?.reset();
  $("masterProductOutboundOneForm")?.reset();
  $("masterProductFbaForm")?.reset();
}

function getSelectedInventoryDetailProductId() {
  return String(state.inventoryHomeSelectedDetail?.product?.productId || "").trim();
}

function renderInventoryDetailInboundBoxSuggestions(keyword = "") {
  const input = $("inventoryDetailInboundBoxCode");
  if (input?.readOnly) {
    return;
  }
  renderBoxOptionsForInput(
    "inventoryDetailInboundBoxCode",
    "inventoryDetailInboundBoxCodeList",
    "输入数字或选择已有箱号",
    keyword,
  );
  const hint = $("inventoryDetailInboundBoxHint");
  if (!hint) return;
  const raw = String(keyword ?? "").trim();
  if (!raw) {
    hint.classList.add("hidden");
    return;
  }
  hint.classList.toggle("hidden", filterAdjustBoxes(keyword).length > 0);
}

async function validateInventoryDetailInboundBoxInput(raw, { normalizeInput = false } = {}) {
  const input = $("inventoryDetailInboundBoxCode");
  const hint = $("inventoryDetailInboundBoxHint");
  if (!input) return "";
  if (input.readOnly) {
    return normalizeBoxCodeInput(input.value);
  }

  const token = ++inventoryDetailInboundBoxValidationToken;
  const normalized = normalizeBoxCodeInput(raw);
  if (!normalized) {
    if (hint) hint.classList.add("hidden");
    return "";
  }

  const resolved = await resolveEnabledBoxCodeLive(normalized);
  if (token !== inventoryDetailInboundBoxValidationToken) return "";

  if (resolved) {
    renderInventoryDetailInboundBoxSuggestions(resolved);
    if (normalizeInput) {
      input.value = resolved;
    }
    if (hint) hint.classList.add("hidden");
    return resolved;
  }

  renderInventoryDetailInboundBoxSuggestions(normalized);
  if (normalizeInput) {
    input.value = normalized;
  }
  if (hint) hint.classList.remove("hidden");
  return "";
}

function resetInventoryDetailInboundForm() {
  $("inventoryDetailInboundForm")?.reset();
  const qtyInput = $("inventoryDetailInboundQty");
  if (qtyInput) {
    qtyInput.value = "1";
  }
  $("inventoryDetailInboundBoxHint")?.classList.add("hidden");
  renderInventoryDetailInboundBoxSuggestions("");
  setInventoryDetailInboundBoxMode();
}

function setInventoryDetailInboundBoxMode(prefillBoxCode = "", locked = false) {
  const input = $("inventoryDetailInboundBoxCode");
  const createButton = $("openCreateBoxFromInventoryDetailInbound");
  const datalist = $("inventoryDetailInboundBoxCodeList");
  const hint = $("inventoryDetailInboundBoxHint");
  if (!input) return;

  input.readOnly = locked;
  input.value = String(prefillBoxCode || "").trim();
  input.dataset.locked = locked ? "1" : "";
  if (locked) {
    hint?.classList.add("hidden");
    if (datalist) {
      datalist.innerHTML = "";
    }
  } else {
    renderInventoryDetailInboundBoxSuggestions(input.value);
  }
  if (createButton) {
    createButton.classList.toggle("hidden", locked);
  }
}

function openInventoryDetailInboundModal(prefillBoxCode = "", { lockBoxCode = false } = {}) {
  const productId = getSelectedInventoryDetailProductId();
  if (!productId) {
    throw new Error("请先选择主商品");
  }
  resetInventoryDetailInboundForm();
  setInventoryDetailInboundBoxMode(prefillBoxCode, lockBoxCode);
  openModal("inventoryDetailInboundModal");
}

async function submitInventoryDetailInbound() {
  const productId = getSelectedInventoryDetailProductId();
  if (!productId) {
    throw new Error("请先选择主商品");
  }
  const rawBoxCode = $("inventoryDetailInboundBoxCode").value;
  const boxCode = await validateInventoryDetailInboundBoxInput(rawBoxCode, { normalizeInput: true });
  if (!boxCode) {
    throw new Error("箱号不存在，请选择已有箱号或者先新增箱号");
  }
  const qtyDelta = Math.abs(Number($("inventoryDetailInboundQty").value));
  if (!Number.isFinite(qtyDelta) || !Number.isInteger(qtyDelta) || qtyDelta <= 0) {
    throw new Error("入库数量必须为正整数");
  }
  const payload = {
    boxCode,
    qtyDelta,
  };
  await request(`/master-products/${encodeURIComponent(productId)}/box-inventories/manual-adjust`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function resetInventoryDetailFbaForm() {
  $("inventoryDetailFbaForm")?.reset();
  const qtyInput = $("inventoryDetailFbaQty");
  if (qtyInput) {
    qtyInput.value = "1";
  }
  $("inventoryDetailFbaRemark").value = "";
}

function openInventoryDetailFbaModal(prefillBoxCode = "") {
  const productId = getSelectedInventoryDetailProductId();
  if (!productId) {
    throw new Error("请先选择主商品");
  }
  const skuSelect = $("inventoryDetailFbaSkuId");
  if (!skuSelect || skuSelect.options.length <= 1) {
    throw new Error("当前主商品没有可用的关联SKU");
  }
  resetInventoryDetailFbaForm();
  $("inventoryDetailFbaBoxCode").value = String(prefillBoxCode || "").trim();
  if (skuSelect.options.length === 2) {
    skuSelect.value = String(skuSelect.options[1].value || "");
  }
  openModal("inventoryDetailFbaModal");
}

async function submitInventoryDetailFba() {
  const productId = getSelectedInventoryDetailProductId();
  if (!productId) {
    throw new Error("请先选择主商品");
  }
  const skuId = Number($("inventoryDetailFbaSkuId").value || 0);
  if (!Number.isInteger(skuId) || skuId <= 0) {
    throw new Error("请选择关联SKU");
  }
  const boxCode = normalizeBoxCodeInput($("inventoryDetailFbaBoxCode").value);
  if (!boxCode) {
    throw new Error("请填写FBA箱号");
  }
  const qty = Math.abs(Number($("inventoryDetailFbaQty").value));
  if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
    throw new Error("申请数量必须为正整数");
  }
  const payload = {
    skuId,
    boxCode,
    qty,
    remark: String($("inventoryDetailFbaRemark").value || "").trim() || undefined,
  };
  await request(`/master-products/${encodeURIComponent(productId)}/fba-replenishments`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function quickInventoryDetailOutboundOne(boxCode) {
  const productId = getSelectedInventoryDetailProductId();
  if (!productId) {
    throw new Error("请先选择主商品");
  }
  const normalizedBoxCode = normalizeBoxCodeInput(boxCode);
  if (!normalizedBoxCode) {
    throw new Error("请填写箱号");
  }
  await request(`/master-products/${encodeURIComponent(productId)}/box-inventories/outbound-one`, {
    method: "POST",
    body: JSON.stringify({
      boxCode: normalizedBoxCode,
      remark: "默认：主商品库存出库",
    }),
  });
}

async function refreshMasterProductPanel() {
  if (state.masterProductView === "detail" && state.selectedMasterProductId) {
    await loadMasterProductDetail(state.selectedMasterProductId);
    return;
  }
  state.masterProductView = "syncRecords";
  setMasterProductView("syncRecords");
  await loadMasterProductSyncRecords({ reset: true });
}

function prefillMasterProductBoxInputs(boxCode, target) {
  const normalized = String(boxCode || "").trim();
  if (!normalized) return;
  if (target === "inbound" || target === "all") {
    $("masterProductAdjustBoxCode").value = normalized;
  }
  if (target === "outbound" || target === "all") {
    $("masterProductOutboundBoxCode").value = normalized;
  }
  if (target === "fba" || target === "all") {
    $("masterProductFbaBoxCode").value = normalized;
  }
}

function hasPendingProductEditRequestBySkuId(skuId) {
  const targetSkuId = Number(skuId);
  if (!Number.isInteger(targetSkuId) || targetSkuId <= 0) {
    return false;
  }
  return state.skuEditRequests.some((item) => {
    const status = String(item?.status || "");
    const itemSkuId = Number(item?.skuId ?? item?.sku?.id ?? 0);
    return status === "pending" && Number.isInteger(itemSkuId) && itemSkuId === targetSkuId;
  });
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

async function deleteSku(id) {
  return request(`/skus/${id}`, {
    method: "DELETE",
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

async function validateAdjustBoxInput(raw, { normalizeInput = false } = {}) {
  const input = $("adjustBoxCode");
  const hint = $("adjustBoxHint");
  if (!input) return "";
  if (input.readOnly) return normalizeBoxCodeInput(input.value);

  const token = ++adjustBoxValidationToken;
  const normalized = normalizeBoxCodeInput(raw);
  if (!normalized) {
    if (hint) hint.classList.add("hidden");
    return "";
  }

  const resolved = await resolveEnabledBoxCodeLive(normalized);
  if (token !== adjustBoxValidationToken) return "";

  if (resolved) {
    renderAdjustBoxSuggestions(resolved);
    if (normalizeInput) {
      input.value = resolved;
    }
    if (hint) hint.classList.add("hidden");
    return resolved;
  }

  renderAdjustBoxSuggestions(normalized);
  if (normalizeInput) {
    input.value = normalized;
  }
  if (hint) hint.classList.remove("hidden");
  return "";
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
  const latestIds = new Set((Array.isArray(shelves) ? shelves : []).map((item) => String(item.id)));
  state.shelfEditingIds = new Set(
    [...state.shelfEditingIds].filter((id) => latestIds.has(String(id))),
  );
  $("statShelves").textContent = shelves.length;

  renderShelfOptionsForSelect("newBoxShelfId", "请选择货架号");
  renderShelfOptionsForSelect("modalNewBoxShelfId", "请选择货架号");
  renderShelfOptionsForSelect("boxManageShelfId", "请选择货架号");
  renderMoveShelfTargetOptions($("moveShelfTargetCode")?.value || "");
  syncMoveShelfCurrentDisplay();
  syncMoveProductOldShelfDisplay();
  syncMoveProductNewShelfDisplay();
  renderShelvesManageTable();
  renderBoxesManageTable();

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
  const latestIds = new Set((Array.isArray(boxes) ? boxes : []).map((item) => String(item.id)));
  state.boxEditingIds = new Set(
    [...state.boxEditingIds].filter((id) => latestIds.has(String(id))),
  );
  $("statBoxes").textContent = boxes.length;
  renderAdjustBoxSuggestions($("adjustBoxCode")?.value || "");
  renderMoveShelfBoxOptions($("moveShelfBoxCode")?.value || "");
  syncMoveShelfCurrentDisplay();
  renderMoveShelfTargetOptions($("moveShelfTargetCode")?.value || "");
  renderMoveProductNewBoxOptions($("moveProductNewBoxCode")?.value || "");
  syncMoveProductOldShelfDisplay();
  syncMoveProductNewShelfDisplay();
  renderBoxesManageTable();
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

async function loadBoxManagePage({ reset = false } = {}) {
  if (state.boxManageLoading) return;
  if (!reset && !state.boxManageHasMore) return;

  if (reset) {
    state.boxManageRows = [];
    state.boxManagePage = 1;
    state.boxManageHasMore = false;
    resetBoxManageVisibleCount();
    renderBoxesManageTable();
  }

  state.boxManageLoading = true;
  renderBoxesManageTable();
  try {
    const page = reset ? 1 : Number(state.boxManagePage || 1);
    const result = await request(
      `/boxes/manage?page=${encodeURIComponent(page)}&pageSize=${encodeURIComponent(state.boxManagePageSize)}`,
    );
    const items = Array.isArray(result?.items) ? result.items : [];
    const nextRows = reset ? items : [...state.boxManageRows, ...items];
    const latestIds = new Set(nextRows.map((item) => String(item.id)));
    state.boxManageRows = nextRows;
    state.boxManageHasMore = Boolean(result?.hasMore);
    state.boxManagePage = page + 1;
    state.boxManageVisibleCount = Math.max(state.boxManageVisibleCount, state.boxManageRows.length);
    state.boxEditingIds = new Set(
      [...state.boxEditingIds].filter((id) => latestIds.has(String(id))),
    );
  } finally {
    state.boxManageLoading = false;
    renderBoxesManageTable();
  }
}

async function reloadBoxesAfterManageMutation() {
  const boxManageModal = $("boxManageModal");
  const isBoxManageOpen = boxManageModal && !boxManageModal.classList.contains("hidden");
  if (isBoxManageOpen) {
    await Promise.all([loadShelves(), loadBoxManagePage({ reset: true }), loadInventory(), loadAudit()]);
    return;
  }
  await Promise.all([loadShelves(), loadBoxes(), loadInventory(), loadAudit()]);
}

async function loadEmptyBoxes() {
  const rows = await request("/boxes/empty");
  state.emptyBoxes = Array.isArray(rows) ? rows : [];
  renderEmptyBoxManageBadge();
  renderEmptyBoxManageTable();
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
  const orders = state.batchInboundOrders.slice(0, state.batchInboundVisibleCount);
  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">-</td></tr>';
    return;
  }

  tbody.innerHTML = orders
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

function loadMoreBatchInboundOrdersIfNeeded() {
  const panel = $("batchInbound");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.batchInboundVisibleCount >= state.batchInboundOrders.length) return;
  state.batchInboundVisibleCount += state.inventoryPageSize;
  renderBatchInboundOrders();
}

function maybeAutoLoadOrders() {
  const panel = $("rakutenOrderImport");
  if (!panel || !panel.classList.contains("active")) return;
  const tableWrap = $("rakutenOrdersTableWrap");
  if (!tableWrap) return;
  if (state.ordersVisibleCount >= state.orders.length) return;

  const threshold = 120;
  const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
  if (currentBottom < tableWrap.scrollHeight - threshold) return;

  loadMoreOrdersIfNeeded();
}

function maybeAutoLoadBatchInboundOrders() {
  const panel = $("batchInbound");
  if (!panel || !panel.classList.contains("active")) return;
  const tableWrap = $("batchInboundTableWrap");
  if (!tableWrap) return;
  if (state.batchInboundVisibleCount >= state.batchInboundOrders.length) return;

  const threshold = 120;
  const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
  if (currentBottom < tableWrap.scrollHeight - threshold) return;

  loadMoreBatchInboundOrdersIfNeeded();
}

function setupOrdersLoadObserver() {
  if (ordersLoadObserver) {
    ordersLoadObserver.disconnect();
    ordersLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("rakutenOrdersTableWrap");
  const sentinel = $("rakutenOrdersLoadSentinel");
  if (!tableWrap || !sentinel) return;

  ordersLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreOrdersIfNeeded();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  ordersLoadObserver.observe(sentinel);
}

function setupBatchInboundLoadObserver() {
  if (batchInboundLoadObserver) {
    batchInboundLoadObserver.disconnect();
    batchInboundLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("batchInboundTableWrap");
  const sentinel = $("batchInboundLoadSentinel");
  if (!tableWrap || !sentinel) return;

  batchInboundLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreBatchInboundOrdersIfNeeded();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  batchInboundLoadObserver.observe(sentinel);
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
  state.batchInboundVisibleCount = state.inventoryPageSize;
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

function toAuditRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

async function refreshAuditFbaRequestNoMap() {
  const map = {};
  const sourceRows = Array.isArray(state.fbaReplenishments) && state.fbaReplenishments.length
    ? state.fbaReplenishments
    : await request("/inventory/fba-replenishments");

  (Array.isArray(sourceRows) ? sourceRows : []).forEach((item) => {
    const id = String(item?.id || "").trim();
    const requestNo = String(item?.requestNo || "").trim();
    if (id && requestNo) {
      map[id] = requestNo;
    }
  });

  state.auditFbaRequestNoById = map;
}

function pickAuditEntityName(item, entityType) {
  const after = toAuditRecord(item?.afterData);
  const before = toAuditRecord(item?.beforeData);
  const pick = (...keys) => {
    for (const key of keys) {
      const afterValue = String(after?.[key] ?? "").trim();
      if (afterValue) return afterValue;
      const beforeValue = String(before?.[key] ?? "").trim();
      if (beforeValue) return beforeValue;
    }
    return "";
  };

  if (entityType === "sku") return pick("sku", "model");
  if (entityType === "box") return pick("boxCode", "box_code");
  if (entityType === "shelf") return pick("shelfCode", "shelf_code", "name");
  if (entityType === "user") return pick("username");
  if (entityType === "brand") return pick("name", "brand");
  if (entityType === "sku_type") return pick("name", "type");
  if (entityType === "shop") return pick("name", "shop");
  if (entityType === "inbound_order" || entityType === "outbound_order") return pick("orderNo", "order_no");
  if (entityType === "stocktake_task") return pick("taskNo", "task_no");
  if (entityType === "inventory_adjust_order") return pick("adjustNo", "adjust_no");
  if (entityType === "fba_replenishment") {
    const requestNo = pick("requestNo", "request_no");
    if (requestNo) return requestNo;
    const id = String(item?.entityId ?? "").trim();
    return String(state.auditFbaRequestNoById?.[id] || "").trim();
  }
  if (entityType === "product_edit_request") return pick("sku", "skuCode", "requestNo");

  return pick("name", "code", "no", "sku");
}

function formatAuditEntity(item) {
  const entityType = String(item?.entityType || "").trim();
  const entityText = AUDIT_ENTITY_TEXT_MAP[entityType] || entityType || "实体";
  const entityName = pickAuditEntityName(item, entityType);
  if (!entityName) {
    return entityText;
  }
  return `${entityText}：${entityName}`;
}

function getAuditEventText(eventType) {
  const code = String(eventType || "").trim();
  if (!code) return "-";
  return AUDIT_EVENT_TEXT_MAP[code] || code;
}

function renderAuditTable() {
  const body = $("auditBody");
  if (!body) return;
  const items = state.auditLogs.slice(0, state.auditVisibleCount);
  body.innerHTML =
    items
      .map(
        (item) => `
      <tr>
        <td>${formatDate(item.createdAt)}</td>
        <td>${escapeHtml(formatAuditEntity(item))}</td>
        <td>${escapeHtml(getAuditEventText(item.eventType))}</td>
        <td>${escapeHtml(item.operator?.username)}</td>
      </tr>
    `,
      )
      .join("") || '<tr><td colspan="4" class="muted">-</td></tr>';
}

function loadMoreAuditIfNeeded() {
  const panel = $("audit");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.auditVisibleCount >= state.auditLogs.length) return;
  state.auditVisibleCount += state.inventoryPageSize;
  renderAuditTable();
}

function maybeAutoLoadAudit() {
  const panel = $("audit");
  if (!panel || !panel.classList.contains("active")) return;
  const tableWrap = $("auditTableWrap");
  if (!tableWrap) return;
  if (state.auditVisibleCount >= state.auditLogs.length) return;

  const threshold = 120;
  const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
  if (currentBottom < tableWrap.scrollHeight - threshold) return;

  loadMoreAuditIfNeeded();
}

function setupAuditLoadObserver() {
  if (auditLoadObserver) {
    auditLoadObserver.disconnect();
    auditLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("auditTableWrap");
  const sentinel = $("auditLoadSentinel");
  if (!tableWrap || !sentinel) return;

  auditLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreAuditIfNeeded();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  auditLoadObserver.observe(sentinel);
}

async function loadAudit() {
  await refreshAuditFbaRequestNoMap();
  const result = await request("/audit-logs?page=1&pageSize=2000");
  state.auditLogs = Array.isArray(result.items) ? result.items : [];
  state.auditVisibleCount = state.inventoryPageSize;
  renderAuditTable();
}

function renderMyAuditTable() {
  const body = $("myAuditBody");
  if (!body) return;
  const items = state.myAuditLogs.slice(0, state.myAuditVisibleCount);
  body.innerHTML =
    items
      .map(
        (item) => `
      <tr>
        <td>${formatDate(item.createdAt)}</td>
        <td>${escapeHtml(formatAuditEntity(item))}</td>
        <td>${escapeHtml(getAuditEventText(item.eventType))}</td>
      </tr>
    `,
      )
      .join("") || '<tr><td colspan="3" class="muted">-</td></tr>';
}

function loadMoreMyAuditIfNeeded() {
  const modal = $("myAuditModal");
  if (!modal || modal.classList.contains("hidden")) return;
  const tableWrap = $("myAuditTableWrap");
  if (!tableWrap) return;
  const threshold = 80;
  const nearBottom = tableWrap.scrollTop + tableWrap.clientHeight >= tableWrap.scrollHeight - threshold;
  if (!nearBottom) return;
  if (state.myAuditVisibleCount >= state.myAuditLogs.length) return;
  state.myAuditVisibleCount += state.inventoryPageSize;
  renderMyAuditTable();
}

async function loadMyAudit() {
  if (!state.me?.id) {
    state.myAuditLogs = [];
    state.myAuditVisibleCount = 0;
    renderMyAuditTable();
    return;
  }
  await refreshAuditFbaRequestNoMap();
  const result = await request(`/audit-logs?page=1&pageSize=2000&operatorId=${state.me.id}`);
  state.myAuditLogs = Array.isArray(result.items) ? result.items : [];
  state.myAuditVisibleCount = state.inventoryPageSize;
  renderMyAuditTable();
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

function renderOrdersTable() {
  const tbody = $("rakutenOrdersBody");
  if (!tbody) return;
  syncSelectedRakutenOrderIds();
  const canEdit = canCurrentUserEditOrders();
  const visibleCount = Math.max(state.inventoryPageSize, Number(state.ordersVisibleCount || 0));
  const list = state.orders.slice(0, visibleCount);

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="${canEdit ? 15 : 14}" class="muted">暂无订单数据</td></tr>`;
    updateRakutenOrdersSelectAll();
    updateRakutenBatchDeleteButtonState();
    return;
  }

  tbody.innerHTML = list
    .map(
      (item) => {
        const needsRemarkFix = shouldHighlightRakutenOrderRemark(item);
        const editButtonClass = needsRemarkFix
          ? "ghost compact-btn admin-order-edit-only danger-solid"
          : "ghost compact-btn admin-order-edit-only";
        const editButtonTitle = needsRemarkFix ? '订单备注不是 "[配送日時指定:]"，请点击编辑确认' : "编辑订单";
        return `
      <tr>
        <td><input type="checkbox" data-action="rakutenOrderToggleRow" data-id="${escapeHtml(item.id)}" ${
          state.selectedRakutenOrderIds.has(String(item.id)) ? "checked" : ""
        } /></td>
        <td>${escapeHtml(formatDate(item.csvImportedAt || item.createdAt))}</td>
        <td><button type="button" class="inline-link-btn" data-action="openRakutenOrderDetail" data-id="${escapeHtml(
          item.id,
        )}">${escapeHtml(displayText(item.orderId))}</button></td>
        <td>${escapeHtml(displayText(item.skuCode))}</td>
        <td>${escapeHtml(displayText(item.resolvedProductId || item.skuCode))}</td>
        <td>${escapeHtml(displayText(item.resolvedProductName))}</td>
        <td>${escapeHtml(displayText(item.orderQuantity))}</td>
        <td>${escapeHtml(displayText(item.mallName))}</td>
        <td>${escapeHtml(displayText(normalizeOrderDispatchModeForDisplay(item, item.fulfillmentMode)))}</td>
        <td>${escapeHtml(displayText(item.shopName))}</td>
        <td>${escapeHtml(displayText(item.shippingName))}</td>
        <td>${escapeHtml(displayText(item.shipmentCompany))}</td>
        <td>${escapeHtml(displayText(item.shipmentNo))}</td>
        <td>${escapeHtml(formatDate(item.shipmentNoRegisteredAt))}</td>
        ${
          canEdit
            ? `<td><button type="button" class="${editButtonClass}" title="${escapeHtml(editButtonTitle)}" data-action="editRakutenOrder" data-id="${escapeHtml(
                item.id,
              )}">编辑</button></td>`
            : ""
        }
      </tr>
    `;
      },
    )
    .join("");
  updateRakutenOrdersSelectAll();
  updateRakutenBatchDeleteButtonState();
}

function shouldHighlightRakutenOrderRemark(item) {
  return String(item?.orderRemark ?? "").trim() !== "[配送日時指定:]";
}

function formatOrderFulfillmentMode(mode) {
  if (mode === "overseas_warehouse") return "日本発";
  if (mode === "xiya_api") return "中国発";
  return mode;
}

function getRakutenRawValue(item, key) {
  const rawPayload = item?.rawPayload;
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return "";
  }
  const value = rawPayload[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

function joinRakutenParts(parts, separator = "") {
  return parts
    .map((value) => String(value || "").trim())
    .filter((value) => value.length > 0)
    .join(separator);
}

function formatRakutenOrderDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  const normalized = text.replace(/\//g, "-");
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return text;
  }

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  const seconds = String(parsed.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function buildRakutenOrderDetailFields(item) {
  const orderNo = getRakutenRawValue(item, "注文番号") || item?.orderId || item?.mallOrderNo || "";
  const orderCreatedAt = formatRakutenOrderDateTime(
    getRakutenRawValue(item, "注文日時") || item?.orderImportedAtRaw || "",
  );
  const productName = getRakutenRawValue(item, "商品名") || item?.productName || "";
  const skuInfo = getRakutenRawValue(item, "SKU情報") || item?.productNameExtra || "";
  const resolvedProductId = item?.resolvedProductId || item?.skuCode || getRakutenRawValue(item, "SKU管理番号") || "";
  const resolvedProductName = item?.resolvedProductName || "";
  const quantity = getRakutenRawValue(item, "個数") || item?.orderQuantity || "";
  const recipientName =
    joinRakutenParts([getRakutenRawValue(item, "送付先姓"), getRakutenRawValue(item, "送付先名")]) ||
    item?.shippingName ||
    "";
  const phone =
    joinRakutenParts(
      [
        getRakutenRawValue(item, "送付先電話番号1"),
        getRakutenRawValue(item, "送付先電話番号2"),
        getRakutenRawValue(item, "送付先電話番号3"),
      ],
      "-",
    ) || item?.shippingPhone || "";
  const postalCode =
    joinRakutenParts(
      [getRakutenRawValue(item, "送付先郵便番号1"), getRakutenRawValue(item, "送付先郵便番号2")],
      "-",
    ) || item?.shippingPostalCode || "";
  const address1 =
    joinRakutenParts([getRakutenRawValue(item, "送付先住所都道府県"), getRakutenRawValue(item, "送付先住所郡市区")]) ||
    joinRakutenParts([item?.shippingPrefecture, item?.shippingCity]) ||
    "";
  const address2 = getRakutenRawValue(item, "送付先住所それ以降の住所") || item?.shippingAddress || "";
  const deliveryDate = getRakutenRawValue(item, "お届け日指定") || item?.deliveryDateRaw || "";
  const deliveryTimeSlot = getRakutenRawValue(item, "お届け時間帯") || item?.deliveryTimeSlot || "";

  return [
    ["注文番号", orderNo],
    ["注文日時", orderCreatedAt],
    ["商品名", productName],
    ["SKU情報", skuInfo],
    ["产品ID", resolvedProductId],
    ["产品名称", resolvedProductName],
    ["個数", quantity],
    ["收件人", recipientName],
    ["电话", phone],
    ["邮编", postalCode],
    ["地址1", address1],
    ["地址2", address2],
    ["お届け日指定", deliveryDate],
    ["お届け時間帯", deliveryTimeSlot],
  ];
}

function openRakutenOrderDetailModal(orderId) {
  const item = state.orders.find((row) => String(row?.id || "") === String(orderId || ""));
  openRakutenOrderDetailModalFromItem(item);
}

function openRakutenOrderDetailModalFromItem(item) {
  if (!item) {
    throw new Error("未找到对应的乐天订单");
  }

  const meta = $("rakutenOrderDetailMeta");
  if (!meta) return;
  meta.innerHTML = buildRakutenOrderDetailFields(item)
    .map(
      ([label, value]) => `
        <div class="summary-item">
          <span class="summary-label">${escapeHtml(label)}</span>
          <span class="summary-value">${escapeHtml(displayText(value))}</span>
        </div>
      `,
    )
    .join("");
  openModal("rakutenOrderDetailModal");
}

function getAmazonRawValue(item, key) {
  const rawPayload = item?.rawPayload;
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return "";
  }
  const value = rawPayload[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

function buildAmazonOrderDetailFields(item) {
  const orderNo = getAmazonRawValue(item, "order-id") || item?.orderId || "";
  const orderCreatedAt = getAmazonRawValue(item, "purchase-date") || item?.purchaseDateRaw || "";
  const productName = getAmazonRawValue(item, "product-name") || item?.productName || "";
  const resolvedProductId = item?.resolvedProductId || "";
  const resolvedProductName = item?.resolvedProductName || "";
  const skuInfo = getAmazonRawValue(item, "sku") || item?.sku || "";
  const quantity = getAmazonRawValue(item, "quantity-purchased") || item?.quantityPurchased || item?.orderQuantity || "";
  const recipientName = getAmazonRawValue(item, "recipient-name") || item?.recipientName || item?.shippingName || "";
  const phone = getAmazonRawValue(item, "buyer-phone-number") || item?.buyerPhoneNumber || "";
  const postalCode = getAmazonRawValue(item, "ship-postal-code") || item?.shipPostalCode || "";
  const address1 = joinRakutenParts(
    [getAmazonRawValue(item, "ship-state") || item?.shipState, getAmazonRawValue(item, "ship-address-1") || item?.shipAddress1],
    " ",
  );
  const address2 = joinRakutenParts(
    [getAmazonRawValue(item, "ship-address-2") || item?.shipAddress2, getAmazonRawValue(item, "ship-address-3") || item?.shipAddress3],
    " ",
  );

  return [
    ["注文番号", orderNo],
    ["注文日時", orderCreatedAt],
    ["商品名", productName],
    ["产品ID", resolvedProductId],
    ["SKU情報", skuInfo],
    ["产品名称", resolvedProductName],
    ["個数", quantity],
    ["收件人", recipientName],
    ["电话", phone],
    ["邮编", postalCode],
    ["地址1", address1],
    ["地址2", address2],
    ["お届け日指定", "-"],
    ["お届け時間帯", "-"],
  ];
}

function openAmazonOrderDetailModal(orderId, source = "amazon") {
  const normalizedSource = String(source || "").trim();
  const list = normalizedSource === "manual" ? state.manualOrders : [...state.amazonOrders, ...state.manualOrders];
  const item = list.find((row) => String(row?.id || "") === String(orderId || ""));
  openAmazonOrderDetailModalFromItem(item, normalizedSource);
}

function openAmazonOrderDetailModalFromItem(item, source = "amazon") {
  const normalizedSource = String(source || "").trim();
  if (!item) {
    throw new Error(normalizedSource === "manual" ? "未找到对应的手动订单" : "未找到对应的亚马逊订单");
  }

  const title = $("amazonOrderDetailModalTitle");
  const meta = $("amazonOrderDetailMeta");
  if (!meta) return;
  if (title) {
    title.textContent = normalizedSource === "manual" ? "手动订单详情" : "亚马逊订单详情";
  }
  meta.innerHTML = buildAmazonOrderDetailFields(item)
    .map(
      ([label, value]) => `
        <div class="summary-item">
          <span class="summary-label">${escapeHtml(label)}</span>
          <span class="summary-value">${escapeHtml(displayText(value))}</span>
        </div>
      `,
    )
    .join("");
  openModal("amazonOrderDetailModal");
}

function formatAmazonShippingOriginAsMode(origin) {
  const value = String(origin || "").trim();
  if (!value) return "-";
  if (value.includes("日本")) return "日本発";
  if (value.includes("中国")) return "中国発";
  return value;
}

function canCurrentUserEditOrders() {
  return Boolean(state.me);
}

function normalizeOrderDispatchModeForDisplay(item, fallbackMode = "") {
  const dispatchMode = String(item?.dispatchMode || "").trim();
  if (dispatchMode === "china_pending") return "中国発";
  if (dispatchMode === "overseas") return "日本発";
  if (fallbackMode === "overseas_warehouse") return "日本発";
  if (fallbackMode === "xiya_api") return "中国発";
  return fallbackMode || "-";
}

function resolveOrderEditDispatchMode(item, source) {
  const dispatchMode = String(item?.dispatchMode || "").trim();
  if (dispatchMode === "overseas" || dispatchMode === "china_pending") return dispatchMode;
  if (source === "amazon") {
    const origin = String(item?.shippingOrigin || "").trim();
    if (origin.includes("日本")) return "overseas";
    if (origin.includes("中国")) return "china_pending";
  }
  if (item?.fulfillmentMode === "overseas_warehouse") return "overseas";
  if (item?.fulfillmentMode === "xiya_api") return "china_pending";
  return "";
}

function formatOrderEditDispatchMode(value) {
  const mode = String(value || "").trim();
  if (mode === "overseas" || mode === "日本発" || mode === "日本发") return "日本发";
  if (mode === "china_pending" || mode === "中国発" || mode === "中国发") return "中国发";
  return "保存后自动判断";
}

function normalizeOrderEditSkuLookupKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function setOrderEditFieldValue(id, value) {
  const input = $(id);
  if (!input) return;
  input.value = value === null || value === undefined ? "" : String(value);
}

function getOrderEditFieldValue(id) {
  return String($(id)?.value || "").trim();
}

function setOrderEditSourceMode(source) {
  const isAmazon = source === "amazon" || source === "manual";
  document.querySelectorAll(".order-edit-amazon-only").forEach((node) => {
    node.classList.toggle("hidden", !isAmazon);
  });
  document.querySelectorAll(".order-edit-rakuten-only").forEach((node) => {
    node.classList.toggle("hidden", isAmazon);
  });
}

function setOrderEditProductMeta(productId, productName) {
  setOrderEditFieldValue("orderEditResolvedProductId", productId);
  setOrderEditFieldValue("orderEditResolvedProductName", productName);
}

async function resolveOrderEditProductMeta(source, skuCode) {
  const code = String(skuCode || "").trim();
  if (!code) {
    return { productId: "", productName: "" };
  }
  if (source === "rakuten") {
    const matched = await findMasterProductByProductId(code);
    return {
      productId: matched?.productId || code,
      productName: matched?.productName || "",
    };
  }

  const skuRows = await request(`/skus?q=${encodeURIComponent(code)}`);
  const normalizedCode = normalizeOrderEditSkuLookupKey(code);
  const matched = (Array.isArray(skuRows) ? skuRows : []).find((row) =>
    [row?.sku, row?.rbSku, row?.fbmSku].some((value) => {
      const rawValue = String(value || "").trim();
      return rawValue === code || normalizeOrderEditSkuLookupKey(rawValue) === normalizedCode;
    }),
  );
  return {
    productId: String(matched?.productId || "").trim(),
    productName: String(matched?.productName || "").trim(),
  };
}

async function syncOrderEditProductMeta({ markDispatchAsAuto = true } = {}) {
  const source = getOrderEditFieldValue("orderEditSource");
  const skuCode = getOrderEditFieldValue("orderEditSku");
  const meta = await resolveOrderEditProductMeta(source, skuCode);
  setOrderEditProductMeta(meta.productId, meta.productName);
  if (markDispatchAsAuto) {
    setOrderEditFieldValue("orderEditDispatchMode", "保存后自动判断");
  }
  return meta;
}

async function syncOrderEditProductNameFromProductId() {
  const source = getOrderEditFieldValue("orderEditSource");
  const productId = getOrderEditFieldValue("orderEditResolvedProductId");
  if (source === "rakuten") {
    setOrderEditFieldValue("orderEditSku", productId);
  }
  if (!productId) {
    setOrderEditFieldValue("orderEditResolvedProductName", "");
    return null;
  }
  const matched = await findMasterProductByProductId(productId);
  setOrderEditFieldValue("orderEditResolvedProductName", matched?.productName || "");
  setOrderEditFieldValue("orderEditDispatchMode", "保存后自动判断");
  return matched;
}

function getAmazonManualFieldValue(id) {
  return String($(id)?.value || "").trim();
}

async function syncAmazonManualProductName() {
  const productId = getAmazonManualFieldValue("amazonManualProductId");
  if (!productId) {
    setOrderEditFieldValue("amazonManualProductName", "");
    setOrderEditFieldValue("amazonManualDispatchMode", "保存后自动判断");
    return null;
  }
  const matched = await findMasterProductByProductId(productId);
  setOrderEditFieldValue("amazonManualProductName", matched?.productName || "");
  if (!getAmazonManualFieldValue("amazonManualItemName") && matched?.productName) {
    setOrderEditFieldValue("amazonManualItemName", matched.productName);
  }
  setOrderEditFieldValue("amazonManualDispatchMode", "保存后自动判断");
  return matched;
}

function openAmazonManualOrderModal() {
  const form = $("amazonManualOrderForm");
  if (form) form.reset();
  setOrderEditFieldValue("amazonManualMallName", "");
  setOrderEditFieldValue("amazonManualDispatchMode", "保存后自动判断");
  openModal("amazonManualOrderModal");
}

async function createAmazonManualOrder() {
  return request("/orders/manual", {
    method: "POST",
    body: JSON.stringify({
      orderId: getAmazonManualFieldValue("amazonManualOrderId"),
      orderItemId: getAmazonManualFieldValue("amazonManualOrderItemId"),
      sku: getAmazonManualFieldValue("amazonManualSku"),
      productId: getAmazonManualFieldValue("amazonManualProductId"),
      quantityPurchased: getAmazonManualFieldValue("amazonManualQuantity"),
      productName: getAmazonManualFieldValue("amazonManualItemName"),
      mallName: getAmazonManualFieldValue("amazonManualMallName"),
      shopName: getAmazonManualFieldValue("amazonManualShopName"),
      recipientName: getAmazonManualFieldValue("amazonManualRecipientName"),
      buyerPhoneNumber: getAmazonManualFieldValue("amazonManualPhone"),
      shipPostalCode: getAmazonManualFieldValue("amazonManualPostalCode"),
      shipState: getAmazonManualFieldValue("amazonManualState"),
      shipAddress1: getAmazonManualFieldValue("amazonManualAddress1"),
      shipAddress2: getAmazonManualFieldValue("amazonManualAddress2"),
      shipAddress3: getAmazonManualFieldValue("amazonManualAddress3"),
      shipmentCompany: getAmazonManualFieldValue("amazonManualShipmentCompany"),
      shipmentNo: getAmazonManualFieldValue("amazonManualShipmentNo"),
    }),
  });
}

function openOrderEditModal(source, id) {
  const normalizedSource = String(source || "").trim();
  const list =
    normalizedSource === "rakuten"
      ? state.orders
      : normalizedSource === "manual"
        ? state.manualOrders
        : [...state.amazonOrders, ...state.manualOrders];
  const item = list.find((row) => String(row?.id || "") === String(id || ""));
  if (!item) {
    throw new Error("未找到对应订单");
  }

  const isManual = normalizedSource === "manual";
  const isAmazon = normalizedSource === "amazon" || isManual;
  setOrderEditSourceMode(normalizedSource);
  $("orderEditModalTitle").textContent = isManual ? "编辑手动订单" : isAmazon ? "编辑亚马逊订单" : "编辑乐天订单";
  setOrderEditFieldValue("orderEditSource", normalizedSource);
  setOrderEditFieldValue("orderEditId", item.id);
  setOrderEditFieldValue("orderEditOrderId", item.orderId);
  setOrderEditFieldValue("orderEditOrderItemId", item.orderItemId);
  setOrderEditFieldValue("orderEditSku", isAmazon ? item.sku : item.skuCode);
  setOrderEditFieldValue("orderEditQuantity", isAmazon ? item.quantityPurchased : item.orderQuantity);
  setOrderEditFieldValue("orderEditProductName", item.productName);
  setOrderEditFieldValue("orderEditMallName", item.mallName || (isAmazon ? "亚马逊" : ""));
  setOrderEditFieldValue("orderEditShopName", isAmazon ? item.resolvedShopName || item.shopName : item.shopName);
  setOrderEditProductMeta(item.resolvedProductId || (!isAmazon ? item.skuCode : ""), item.resolvedProductName || "");
  setOrderEditFieldValue("orderEditDispatchMode", formatOrderEditDispatchMode(resolveOrderEditDispatchMode(item, normalizedSource)));
  setOrderEditFieldValue("orderEditRecipientName", isAmazon ? item.recipientName : item.shippingName);
  setOrderEditFieldValue("orderEditPhone", isAmazon ? item.buyerPhoneNumber : item.shippingPhone);
  setOrderEditFieldValue("orderEditPostalCode", isAmazon ? item.shipPostalCode : item.shippingPostalCode);
  setOrderEditFieldValue("orderEditState", isAmazon ? item.shipState : item.shippingPrefecture);
  setOrderEditFieldValue("orderEditCity", item.shippingCity);
  setOrderEditFieldValue("orderEditAddress1", isAmazon ? item.shipAddress1 : item.shippingAddress);
  setOrderEditFieldValue("orderEditAddress2", item.shipAddress2);
  setOrderEditFieldValue("orderEditAddress3", item.shipAddress3);
  setOrderEditFieldValue("orderEditShipmentCompany", item.shipmentCompany);
  setOrderEditFieldValue("orderEditShipmentNo", item.shipmentNo);
  setOrderEditFieldValue("orderEditDeliveryDate", item.deliveryDateRaw);
  setOrderEditFieldValue("orderEditDeliveryTimeSlot", item.deliveryTimeSlot);
  setOrderEditFieldValue("orderEditRemark", item.orderRemark);
  openModal("orderEditModal");
  syncOrderEditProductMeta({ markDispatchAsAuto: false }).catch(() => {});
}

async function submitOrderEditForm() {
  const source = getOrderEditFieldValue("orderEditSource");
  const id = getOrderEditFieldValue("orderEditId");
  if (!source || !id) {
    throw new Error("缺少订单标识");
  }
  const common = {
    orderId: getOrderEditFieldValue("orderEditOrderId"),
    productName: getOrderEditFieldValue("orderEditProductName"),
    mallName: getOrderEditFieldValue("orderEditMallName"),
    shopName: getOrderEditFieldValue("orderEditShopName"),
    productId: getOrderEditFieldValue("orderEditResolvedProductId"),
    shipmentCompany: getOrderEditFieldValue("orderEditShipmentCompany"),
    shipmentNo: getOrderEditFieldValue("orderEditShipmentNo"),
  };

  if (source === "amazon" || source === "manual") {
    const endpoint = source === "manual" ? `/orders/manual/${encodeURIComponent(id)}` : `/orders/amazon/${encodeURIComponent(id)}`;
    return request(endpoint, {
      method: "PUT",
      body: JSON.stringify({
        ...common,
        orderItemId: getOrderEditFieldValue("orderEditOrderItemId"),
        sku: getOrderEditFieldValue("orderEditSku"),
        quantityPurchased: getOrderEditFieldValue("orderEditQuantity"),
        recipientName: getOrderEditFieldValue("orderEditRecipientName"),
        buyerPhoneNumber: getOrderEditFieldValue("orderEditPhone"),
        shipPostalCode: getOrderEditFieldValue("orderEditPostalCode"),
        shipState: getOrderEditFieldValue("orderEditState"),
        shipAddress1: getOrderEditFieldValue("orderEditAddress1"),
        shipAddress2: getOrderEditFieldValue("orderEditAddress2"),
        shipAddress3: getOrderEditFieldValue("orderEditAddress3"),
      }),
    });
  }

  return request(`/orders/rakuten/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({
      ...common,
      skuCode: getOrderEditFieldValue("orderEditSku"),
      orderQuantity: getOrderEditFieldValue("orderEditQuantity"),
      shippingName: getOrderEditFieldValue("orderEditRecipientName"),
      shippingPhone: getOrderEditFieldValue("orderEditPhone"),
      shippingPostalCode: getOrderEditFieldValue("orderEditPostalCode"),
      shippingPrefecture: getOrderEditFieldValue("orderEditState"),
      shippingCity: getOrderEditFieldValue("orderEditCity"),
      shippingAddress: getOrderEditFieldValue("orderEditAddress1"),
      deliveryDateRaw: getOrderEditFieldValue("orderEditDeliveryDate"),
      deliveryTimeSlot: getOrderEditFieldValue("orderEditDeliveryTimeSlot"),
      orderRemark: getOrderEditFieldValue("orderEditRemark"),
    }),
  });
}

function renderOrdersPanels() {
  const tbodies = [$("ordersBody"), $("amazonOrdersBody")].filter(Boolean);
  if (!tbodies.length) return;

  if (!state.orders.length) {
    tbodies.forEach((tbody) => {
      tbody.innerHTML = '<tr><td colspan="11" class="muted">暂无订单数据</td></tr>';
    });
    return;
  }

  const html = state.orders
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(formatDate(item.csvImportedAt || item.createdAt))}</td>
        <td>${escapeHtml(displayText(item.orderId))}</td>
        <td>${escapeHtml(displayText(item.skuCode))}</td>
        <td>${escapeHtml(displayText(item.orderQuantity))}</td>
        <td>${escapeHtml(displayText(item.mallName))}</td>
        <td>${escapeHtml(displayText(item.shopName))}</td>
        <td>${escapeHtml(displayText(item.mallOrderNo))}</td>
        <td>${escapeHtml(displayText(item.shippingName))}</td>
        <td>${escapeHtml(displayText(item.shipmentCompany))}</td>
        <td>${escapeHtml(displayText(item.shipmentNo))}</td>
        <td>${escapeHtml(formatDate(item.shipmentNoRegisteredAt))}</td>
      </tr>
    `,
    )
    .join("");

  tbodies.forEach((tbody) => {
    tbody.innerHTML = html;
  });
}

async function loadOrders() {
  if (!state.token) {
    state.orders = [];
    state.ordersVisibleCount = 0;
    state.selectedRakutenOrderIds = new Set();
    renderOrdersTable();
    return;
  }

  const list = await request("/orders");
  state.orders = Array.isArray(list) ? list : [];
  state.ordersVisibleCount = state.inventoryPageSize;
  renderOrdersTable();
}

function loadMoreOrdersIfNeeded() {
  const panel = $("rakutenOrderImport");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.ordersVisibleCount >= state.orders.length) return;
  state.ordersVisibleCount += state.inventoryPageSize;
  renderOrdersTable();
}

async function importOrdersFile(file) {
  const formData = new FormData();
  formData.append("file", file);
  return request("/orders/rakuten/import-csv", {
    method: "POST",
    body: formData,
  });
}

function renderAmazonOrdersTable() {
  const tbody = $("amazonOrdersBody");
  if (!tbody) return;
  syncSelectedAmazonOrderIds();
  const canEdit = canCurrentUserEditOrders();
  const visibleCount = Math.max(state.inventoryPageSize, Number(state.amazonOrdersVisibleCount || 0));
  const list = state.amazonOrders.slice(0, visibleCount);

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="${canEdit ? 15 : 14}" class="muted">暂无亚马逊订单数据</td></tr>`;
    updateAmazonOrdersSelectAll();
    updateAmazonBatchDeleteButtonState();
    return;
  }

  tbody.innerHTML = list
    .map(
      (item) => `
      <tr>
        <td><input type="checkbox" data-action="amazonOrderToggleRow" data-id="${escapeHtml(item.id)}" ${
          state.selectedAmazonOrderIds.has(String(item.id)) ? "checked" : ""
        } /></td>
        <td>${escapeHtml(formatDate(item.csvImportedAt || item.createdAt))}</td>
        <td><button type="button" class="inline-link-btn" data-action="openAmazonOrderDetail" data-id="${escapeHtml(
          item.id,
        )}">${escapeHtml(displayText(item.orderId))}</button></td>
        <td>${escapeHtml(displayText(item.sku))}</td>
        <td>${escapeHtml(displayText(item.resolvedProductId))}</td>
        <td>${escapeHtml(displayText(item.resolvedProductName))}</td>
        <td>${escapeHtml(displayText(item.quantityPurchased))}</td>
        <td>${escapeHtml(displayText(item.mallName || "亚马逊"))}</td>
        <td>${escapeHtml(displayText(normalizeOrderDispatchModeForDisplay(item, formatAmazonShippingOriginAsMode(item.shippingOrigin))))}</td>
        <td>${escapeHtml(displayText(item.resolvedShopName || item.shopName))}</td>
        <td>${escapeHtml(displayText(item.recipientName))}</td>
        <td>${escapeHtml(displayText(item.shipmentCompany))}</td>
        <td>${escapeHtml(displayText(item.shipmentNo))}</td>
        <td>${escapeHtml(formatDate(item.shipmentNoRegisteredAt))}</td>
        ${
          canEdit
            ? `<td><button type="button" class="ghost compact-btn admin-order-edit-only" data-action="editAmazonOrder" data-id="${escapeHtml(
                item.id,
              )}">编辑</button></td>`
            : ""
        }
      </tr>
    `,
    )
    .join("");
  updateAmazonOrdersSelectAll();
  updateAmazonBatchDeleteButtonState();
}

function renderManualOrdersTable() {
  const tbody = $("manualOrdersBody");
  if (!tbody) return;
  syncSelectedManualOrderIds();
  const canEdit = canCurrentUserEditOrders();
  const visibleCount = Math.max(state.inventoryPageSize, Number(state.manualOrdersVisibleCount || 0));
  const list = state.manualOrders.slice(0, visibleCount);

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="${canEdit ? 15 : 14}" class="muted">暂无手动订单数据</td></tr>`;
    updateManualOrdersSelectAll();
    updateManualOrderBatchDeleteButtonState();
    return;
  }

  tbody.innerHTML = list
    .map(
      (item) => `
      <tr>
        <td><input type="checkbox" data-action="manualOrderToggleRow" data-id="${escapeHtml(item.id)}" ${
          state.selectedManualOrderIds.has(String(item.id)) ? "checked" : ""
        } /></td>
        <td>${escapeHtml(formatDate(item.csvImportedAt || item.createdAt))}</td>
        <td><button type="button" class="inline-link-btn" data-action="openManualOrderDetail" data-id="${escapeHtml(
          item.id,
        )}">${escapeHtml(displayText(item.orderId))}</button></td>
        <td>${escapeHtml(displayText(item.sku))}</td>
        <td>${escapeHtml(displayText(item.resolvedProductId))}</td>
        <td>${escapeHtml(displayText(item.resolvedProductName))}</td>
        <td>${escapeHtml(displayText(item.quantityPurchased))}</td>
        <td>${escapeHtml(displayText(item.mallName))}</td>
        <td>${escapeHtml(displayText(normalizeOrderDispatchModeForDisplay(item, formatAmazonShippingOriginAsMode(item.shippingOrigin))))}</td>
        <td>${escapeHtml(displayText(item.resolvedShopName || item.shopName))}</td>
        <td>${escapeHtml(displayText(item.recipientName))}</td>
        <td>${escapeHtml(displayText(item.shipmentCompany))}</td>
        <td>${escapeHtml(displayText(item.shipmentNo))}</td>
        <td>${escapeHtml(formatDate(item.shipmentNoRegisteredAt))}</td>
        ${
          canEdit
            ? `<td><button type="button" class="ghost compact-btn admin-order-edit-only" data-action="editManualOrder" data-id="${escapeHtml(
                item.id,
              )}">编辑</button></td>`
            : ""
        }
      </tr>
    `,
    )
    .join("");
  updateManualOrdersSelectAll();
  updateManualOrderBatchDeleteButtonState();
}

async function loadAmazonOrders() {
  if (!state.token) {
    state.amazonOrders = [];
    state.amazonOrdersVisibleCount = 0;
    state.manualOrders = [];
    state.manualOrdersVisibleCount = 0;
    state.selectedAmazonOrderIds = new Set();
    state.selectedManualOrderIds = new Set();
    renderAmazonOrdersTable();
    return;
  }

  const list = await request("/orders/amazon");
  state.amazonOrders = Array.isArray(list) ? list : [];
  state.amazonOrdersVisibleCount = state.inventoryPageSize;
  renderAmazonOrdersTable();
}

async function loadManualOrders() {
  if (!state.token) {
    state.manualOrders = [];
    state.manualOrdersVisibleCount = 0;
    state.selectedManualOrderIds = new Set();
    renderManualOrdersTable();
    return;
  }

  const list = await request("/orders/manual");
  state.manualOrders = Array.isArray(list) ? list : [];
  state.manualOrdersVisibleCount = state.inventoryPageSize;
  renderManualOrdersTable();
}

function buildChinaOrderProcessingOrderLink(item) {
  if (item.source === "rakuten") {
    return `<button type="button" class="inline-link-btn" data-action="openChinaRakutenOrderDetail" data-id="${escapeHtml(
      item.id || "",
    )}">${escapeHtml(displayText(item.orderId))}</button>`;
  }
  if (item.source === "amazon") {
    return `<button type="button" class="inline-link-btn" data-action="openChinaAmazonOrderDetail" data-id="${escapeHtml(
      item.id || "",
    )}">${escapeHtml(displayText(item.orderId))}</button>`;
  }
  if (item.source === "manual") {
    return `<button type="button" class="inline-link-btn" data-action="openChinaManualOrderDetail" data-id="${escapeHtml(
      item.id || "",
    )}">${escapeHtml(displayText(item.orderId))}</button>`;
  }
  return escapeHtml(displayText(item.orderId));
}

function summarizeChinaOrderProcessingList(list) {
  const rakutenCount = list.filter((item) => item.source === "rakuten").length;
  const amazonCount = list.filter((item) => item.source === "amazon").length;
  const manualCount = list.filter((item) => item.source === "manual").length;
  const switchedCount = list.filter((item) => item.dispatchMode === "china_pending").length;
  const noStockCount = Math.max(list.length - switchedCount, 0);
  return {
    rakutenCount,
    amazonCount,
    manualCount,
    switchedCount,
    noStockCount,
  };
}

function renderChinaOrderProcessingTable() {
  const pendingBody = $("chinaOrderProcessingPendingBody");
  const pendingSummary = $("chinaOrderProcessingPendingSummary");
  const exportedBody = $("chinaOrderProcessingExportedBody");
  const exportedSummary = $("chinaOrderProcessingExportedSummary");
  if (!pendingBody || !exportedBody) return;

  const list = Array.isArray(state.chinaOrderProcessingOrders) ? state.chinaOrderProcessingOrders : [];
  const pendingList = list.filter((item) => !String(item.shipmentNo || "").trim());
  const exportedList = list.filter((item) => String(item.shipmentNo || "").trim());
  const pendingStats = summarizeChinaOrderProcessingList(pendingList);
  const exportedStats = summarizeChinaOrderProcessingList(exportedList);

  if (pendingSummary) {
    pendingSummary.textContent = `共 ${pendingList.length} 条等待 Xiya 运单号的中国发订单，其中 乐天 ${pendingStats.rakutenCount} 条，亚马逊 ${pendingStats.amazonCount} 条，手动订单 ${pendingStats.manualCount} 条。`;
  }
  if (exportedSummary) {
    exportedSummary.textContent = `共 ${exportedList.length} 条已登记运单号的中国发订单，其中 乐天 ${exportedStats.rakutenCount} 条，亚马逊 ${exportedStats.amazonCount} 条，手动订单 ${exportedStats.manualCount} 条。`;
  }

  if (!pendingList.length) {
    pendingBody.innerHTML = '<tr><td colspan="11" class="muted">暂无待 Xiya 拉取的中国发订单</td></tr>';
  } else {
    pendingBody.innerHTML = pendingList
      .map(
        (item) => `
        <tr>
          <td>${escapeHtml(formatDate(item.csvImportedAt || item.createdAt))}</td>
          <td>${escapeHtml(displayText(item.sourceLabel))}</td>
          <td>${buildChinaOrderProcessingOrderLink(item)}</td>
          <td>${escapeHtml(displayText(item.skuCode))}</td>
          <td>${escapeHtml(displayText(item.resolvedProductId))}</td>
          <td>${escapeHtml(displayText(item.resolvedProductName))}</td>
          <td>${escapeHtml(displayText(item.orderQuantity))}</td>
          <td>${escapeHtml(displayText(item.shopName))}</td>
          <td>${escapeHtml(displayText(item.shippingName))}</td>
          <td>${escapeHtml(displayText(item.availableStock))}</td>
          <td>${escapeHtml(displayText(item.chinaDispatchReason || (item.dispatchMode === "china_pending" ? "拣货缺货切中国发" : "系统无库存")))}</td>
        </tr>
      `,
      )
      .join("");
  }

  if (!exportedList.length) {
    exportedBody.innerHTML = '<tr><td colspan="13" class="muted">暂无已登记运单号的中国发订单</td></tr>';
    return;
  }

  exportedBody.innerHTML = exportedList
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(formatDate(item.csvImportedAt || item.createdAt))}</td>
        <td>${escapeHtml(displayText(item.sourceLabel))}</td>
        <td>${buildChinaOrderProcessingOrderLink(item)}</td>
        <td>${escapeHtml(displayText(item.skuCode))}</td>
        <td>${escapeHtml(displayText(item.resolvedProductId))}</td>
        <td>${escapeHtml(displayText(item.resolvedProductName))}</td>
        <td>${escapeHtml(displayText(item.orderQuantity))}</td>
        <td>${escapeHtml(displayText(item.shopName))}</td>
        <td>${escapeHtml(displayText(item.shippingName))}</td>
        <td>${escapeHtml(displayText(item.chinaDispatchReason || (item.dispatchMode === "china_pending" ? "拣货缺货切中国发" : "系统无库存")))}</td>
        <td>${escapeHtml(displayText(item.shipmentCompany))}</td>
        <td>${escapeHtml(displayText(item.shipmentNo))}</td>
        <td>${escapeHtml(formatDate(item.shipmentNoRegisteredAt))}</td>
      </tr>
    `,
    )
    .join("");
}

async function loadChinaOrderProcessingOrders() {
  if (!state.token) {
    state.chinaOrderProcessingOrders = [];
    renderChinaOrderProcessingTable();
    return;
  }

  const list = await request("/orders/china-orders?scope=all");
  state.chinaOrderProcessingOrders = Array.isArray(list) ? list : [];
  renderChinaOrderProcessingTable();
}

function renderOverseasOrderProcessingTable() {
  const tbody = $("overseasOrderProcessingBody");
  const summary = $("overseasOrderProcessingSummary");
  if (!tbody) return;
  syncSelectedOverseasOrderKeys();

  const list = Array.isArray(state.overseasOrderProcessingOrders) ? state.overseasOrderProcessingOrders : [];
  const rakutenCount = list.filter((item) => item.source === "rakuten").length;
  const amazonCount = list.filter((item) => item.source === "amazon").length;
  const manualCount = list.filter((item) => item.source === "manual").length;
  if (summary) {
    summary.textContent = `共 ${list.length} 条待处理订单，其中 乐天 ${rakutenCount} 条，亚马逊 ${amazonCount} 条，手动订单 ${manualCount} 条。`;
  }

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="muted">暂无可归结的海外仓订单</td></tr>';
    updateOverseasOrderProcessingSelectAll();
    updateOverseasCreatePickingBatchButtonState();
    return;
  }

  tbody.innerHTML = list
    .map(
      (item) => `
      <tr>
        <td><input type="checkbox" data-action="overseasOrderToggleRow" data-key="${escapeHtml(
          `${item.source}:${item.id || ""}`,
        )}" ${state.selectedOverseasOrderKeys.has(`${item.source}:${item.id || ""}`) ? "checked" : ""} /></td>
        <td>${escapeHtml(formatDate(item.csvImportedAt || item.createdAt))}</td>
        <td>${escapeHtml(displayText(item.sourceLabel))}</td>
        <td>${
          item.source === "rakuten"
            ? `<button type="button" class="inline-link-btn" data-action="openOverseasRakutenOrderDetail" data-id="${escapeHtml(
                item.id || "",
              )}">${escapeHtml(displayText(item.orderId))}</button>`
            : item.source === "amazon"
              ? `<button type="button" class="inline-link-btn" data-action="openOverseasAmazonOrderDetail" data-id="${escapeHtml(
                  item.id || "",
                )}">${escapeHtml(displayText(item.orderId))}</button>`
              : item.source === "manual"
                ? `<button type="button" class="inline-link-btn" data-action="openOverseasManualOrderDetail" data-id="${escapeHtml(
                    item.id || "",
                  )}">${escapeHtml(displayText(item.orderId))}</button>`
              : escapeHtml(displayText(item.orderId))
        }</td>
        <td>${escapeHtml(displayText(item.skuCode))}</td>
        <td>${escapeHtml(displayText(item.resolvedProductId))}</td>
        <td>${escapeHtml(displayText(item.resolvedProductName))}</td>
        <td>${escapeHtml(displayText(item.orderQuantity))}</td>
        <td>${escapeHtml(displayText(item.shopName))}</td>
        <td>${escapeHtml(displayText(item.shippingName))}</td>
        <td>${escapeHtml(displayText(item.availableStock))}</td>
        <td>
          <button
            type="button"
            class="tiny-btn danger"
            data-action="switchOverseasPendingOrderToChina"
            data-source="${escapeHtml(item.source || "")}"
            data-id="${escapeHtml(item.id || "")}"
            data-order-id="${escapeHtml(item.orderId || "")}"
          >切中国发</button>
        </td>
      </tr>
    `,
    )
    .join("");
  updateOverseasOrderProcessingSelectAll();
  updateOverseasCreatePickingBatchButtonState();
}

async function loadOverseasOrderProcessingOrders() {
  if (!state.token) {
    state.overseasOrderProcessingOrders = [];
    state.selectedOverseasOrderKeys = new Set();
    renderOverseasOrderProcessingTable();
    return;
  }

  const list = await request("/orders/overseas-warehouse");
  state.overseasOrderProcessingOrders = Array.isArray(list) ? list : [];
  renderOverseasOrderProcessingTable();
}

async function switchOverseasPendingOrderToChina(source, id) {
  return request(
    `/orders/overseas-warehouse/${encodeURIComponent(String(source || "").trim())}/${encodeURIComponent(
      String(id || "").trim(),
    )}/switch-to-china`,
    {
      method: "POST",
    },
  );
}

function getSelectedOverseasPickingBatch() {
  const targetId = String(state.selectedOverseasPickingBatchId || "").trim();
  if (!targetId) return null;
  return state.overseasPickingBatches.find((item) => String(item?.id || "") === targetId) || null;
}

function getOverseasPickingBatchStatusText(status) {
  if (status === "created") return "待确认";
  if (status === "picked") return "已扣库存";
  if (status === "yamato_exported") return "已生成 Yamato";
  return displayText(status);
}

function renderOverseasPickingBatchList() {
  const tbody = $("overseasPickingBatchListBody");
  const summary = $("overseasPickingBatchListSummary");
  if (!tbody) return;

  const list = Array.isArray(state.overseasPickingBatches) ? state.overseasPickingBatches : [];

  if (summary) {
    summary.textContent = "";
  }

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">暂无拣货批次</td></tr>';
    return;
  }

  tbody.innerHTML = list
    .map(
      (item) => `
      <tr>
        <td><button type="button" class="inline-link-btn" data-action="openOverseasPickingBatchDetail" data-id="${escapeHtml(
          String(item.id || ""),
        )}">${escapeHtml(displayText(item.batchNo))}</button></td>
        <td>${escapeHtml(getOverseasPickingBatchStatusText(item.status))}</td>
        <td>${escapeHtml(displayText(item.orderCount))}</td>
        <td>${escapeHtml(displayText(item.itemCount))}</td>
        <td>${escapeHtml(displayText(item.totalQty))}</td>
        <td>${escapeHtml(item.yamatoShipmentBatchId ? `#${item.yamatoShipmentBatchId}` : "-")}</td>
        <td>${escapeHtml(formatDate(item.createdAt))}</td>
        <td>${escapeHtml(formatDate(item.confirmedAt))}</td>
      </tr>
    `,
    )
    .join("");
}

function renderOverseasPickingBatchItems() {
  const tbody = $("overseasPickingBatchItemsBody");
  if (!tbody) return;

  const detail = state.selectedOverseasPickingBatchDetail;
  const list = Array.isArray(detail?.items) ? detail.items : [];
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="muted">当前批次暂无待拣货产品</td></tr>';
    return;
  }

  const isCreated = String(detail?.status || "") === "created";
  const orderedList = list
    .map((item, index) => ({
      item,
      index,
      isCompleted: Number(item.actualQty || 0) >= Number(item.requestedQty || 0),
    }))
    .sort((left, right) => {
      if (left.isCompleted !== right.isCompleted) {
        return left.isCompleted ? 1 : -1;
      }
      return left.index - right.index;
    })
    .map(({ item }) => item);

  tbody.innerHTML = orderedList
    .map((item) => {
      const pickedQty = Number(item.actualQty || 0);
      const canChange = isCreated && pickedQty > 0;
      const pickPlans = Array.isArray(item.pickPlans) ? item.pickPlans : [];
      const shelfLines = pickPlans.length
        ? pickPlans.map((plan) => `<div>${escapeHtml(displayText(plan.shelfCode))}</div>`).join("")
        : '<div>-</div>';
      const boxLines = pickPlans.length
        ? pickPlans.map((plan) => `<div>${escapeHtml(displayText(plan.boxCode))}</div>`).join("")
        : '<div>-</div>';
      const qtyLines = pickPlans.length
        ? pickPlans
            .map(
              (plan) => {
                const boxQty = Number(plan.boxQty || 0);
                const pickQty = Number(plan.pickQty || 0);
                const remainingQty = Math.max(boxQty - pickQty, 0);
                if (pickedQty > 0 || !isCreated || pickQty <= 0) {
                  return `<div>${escapeHtml(displayText(pickQty > 0 ? remainingQty : boxQty))}</div>`;
                }
                return `<div>${escapeHtml(displayText(boxQty))}<span class="picking-stock-minus">-${escapeHtml(
                  displayText(pickQty),
                )}</span></div>`;
              },
            )
            .join("")
        : '<div>-</div>';
      return `
      <tr>
        <td>${shelfLines}</td>
        <td>${boxLines}</td>
        <td>${qtyLines}</td>
        <td>${escapeHtml(displayText(item.productId))}</td>
        <td>${escapeHtml(displayText(item.productName))}</td>
        <td>${escapeHtml(displayText(item.stockQty))}</td>
        <td>${escapeHtml(displayText(item.requestedQty))}</td>
        <td>${escapeHtml(displayText(item.actualQty))}</td>
        <td>${escapeHtml(displayText(item.remainingQty))}</td>
        <td>
          ${
            canChange
              ? `<button type="button" class="tiny-btn" data-action="resetOverseasPickedItem" data-product-id="${escapeHtml(item.productId)}">变更</button>`
              : '<span class="muted">-</span>'
          }
        </td>
      </tr>
    `;
    })
    .join("");
}

function renderOverseasPickingBatchOrders() {
  const tbody = $("overseasPickingBatchOrdersBody");
  const summary = $("overseasPickingBatchOrdersSummary");
  if (!tbody) return;

  const detail = state.selectedOverseasPickingBatchDetail;
  const list = Array.isArray(detail?.orders) ? detail.orders : [];
  if (summary) {
    if (!detail) {
      summary.textContent = "扫码打印后，这里会更新对应订单的面单状态。";
    } else {
      const printedCount = list.filter((item) => item.yamatoPrintedAt).length;
      const chinaCount = list.filter((item) => item.dispatchMode === "china_pending").length;
      const waitingPrintCount = list.filter(
        (item) => item.dispatchMode !== "china_pending" && item.shipmentTrackingNo && !item.yamatoPrintedAt,
      ).length;
      const pendingLabelCount = list.filter(
        (item) => item.dispatchMode !== "china_pending" && !item.shipmentTrackingNo,
      ).length;
      summary.textContent = `当前批次共 ${list.length} 条订单，已打印 ${printedCount} 条，待打印 ${waitingPrintCount} 条，待生成/上传面单 ${pendingLabelCount} 条，中国发 ${chinaCount} 条。`;
    }
  }

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="muted">当前批次暂无订单信息</td></tr>';
    return;
  }

  const isCreated = String(detail?.status || "") === "created";
  tbody.innerHTML = list
    .map((item) => {
      const canRemoveFromBatch = isCreated;
      const actionButtons = [];
      if (canRemoveFromBatch) {
        actionButtons.push(`<button type="button" class="tiny-btn" data-action="removeOverseasOrderFromBatch" data-item-id="${escapeHtml(
          item.itemId,
        )}" data-order-id="${escapeHtml(item.orderId || "")}" data-product-id="${escapeHtml(item.productId || "")}">踢出本批次发货</button>`);
      }
      const orderCell =
        item.source === "rakuten"
          ? `<button type="button" class="inline-link-btn" data-action="openPickingBatchRakutenOrderDetail" data-item-id="${escapeHtml(
              item.itemId || "",
            )}">${escapeHtml(displayText(item.orderId))}</button>`
          : item.source === "amazon"
            ? `<button type="button" class="inline-link-btn" data-action="openPickingBatchAmazonOrderDetail" data-item-id="${escapeHtml(
                item.itemId || "",
              )}">${escapeHtml(displayText(item.orderId))}</button>`
            : item.source === "manual"
              ? `<button type="button" class="inline-link-btn" data-action="openPickingBatchManualOrderDetail" data-item-id="${escapeHtml(
                  item.itemId || "",
                )}">${escapeHtml(displayText(item.orderId))}</button>`
            : escapeHtml(displayText(item.orderId));
      return `
        <tr>
          <td>${escapeHtml(displayText(item.sourceLabel))}</td>
          <td>${orderCell}</td>
          <td>${escapeHtml(displayText(item.skuCode))}</td>
          <td>${escapeHtml(displayText(item.productId))}</td>
          <td>${escapeHtml(displayText(item.orderQuantity))}</td>
          <td>${escapeHtml(displayText(item.shopName))}</td>
          <td>${escapeHtml(displayText(item.shippingName))}</td>
          <td>${escapeHtml(displayText(item.shipmentTrackingNo))}</td>
          <td>${escapeHtml(displayText(item.orderStatusText))}</td>
          <td>${actionButtons.length ? actionButtons.join(" ") : '<span class="muted">-</span>'}</td>
        </tr>
      `;
    })
    .join("");
}

function updateOverseasPickingBatchActionButtons() {
  const completeBtn = $("overseasCompletePickingBtn");
  const scanBtn = $("overseasPickingScanSubmitBtn");
  const scanInput = $("overseasPickingScanInput");
  const detail = state.selectedOverseasPickingBatchDetail;
  const status = String(detail?.status || "").trim();
  const canComplete = Boolean(detail && detail.orders?.length && status === "created");
  const canPick = Boolean(detail && detail.items?.length && status === "created");

  if (completeBtn) {
    completeBtn.disabled = !canComplete;
    completeBtn.textContent =
      detail && detail.yamatoShipmentBatchId
        ? `2.已生成 Yamato 批次 #${detail.yamatoShipmentBatchId}`
        : "2.确认拣货并生成 Yamato Excel";
  }
  if (scanBtn) {
    scanBtn.disabled = !canPick;
  }
  if (scanInput) {
    scanInput.disabled = !canPick;
  }
}

function renderOverseasPickingBatchControls() {
  const listSection = $("overseasPickingBatchListSection");
  const detailSection = $("overseasPickingBatchDetailSection");
  const backToListBtn = $("backToOverseasPickingBatchListBtn");
  const title = $("overseasPickingBatchTitle");
  const summary = $("overseasPickingBatchSummary");
  const meta = $("overseasPickingBatchMeta");
  const batches = Array.isArray(state.overseasPickingBatches) ? state.overseasPickingBatches : [];
  const isDetailView = state.overseasPickingBatchView === "detail";

  if (listSection) listSection.classList.toggle("hidden", isDetailView);
  if (detailSection) detailSection.classList.toggle("hidden", !isDetailView);
  if (backToListBtn) backToListBtn.classList.toggle("hidden", !isDetailView);

  renderOverseasPickingBatchList();

  const detail = state.selectedOverseasPickingBatchDetail;
  if (title) {
    title.textContent = detail ? `批次号：${detail.batchNo}` : "拣货批次详情";
    title.classList.toggle("hidden", !detail);
  }
  if (meta) {
    meta.innerHTML = "";
  }
  if (summary) {
    summary.textContent = "";
  }

  renderOverseasPickingBatchItems();
  renderOverseasPickingBatchOrders();
  updateOverseasPickingBatchActionButtons();
}

async function loadOverseasPickingBatchDetail(batchId) {
  if (!state.token || !String(batchId || "").trim()) {
    state.selectedOverseasPickingBatchDetail = null;
    renderOverseasPickingBatchControls();
    return;
  }
  const detail = await request(`/orders/overseas-warehouse/picking-batches/${encodeURIComponent(batchId)}`);
  state.selectedOverseasPickingBatchDetail = detail || null;
  if (detail?.yamatoShipmentBatchId) {
    state.selectedYamatoShipmentBatchId = String(detail.yamatoShipmentBatchId || "").trim();
  }
  renderOverseasPickingBatchControls();
}

async function loadOverseasPickingBatches() {
  if (!state.token) {
    state.overseasPickingBatches = [];
    state.overseasPickingBatchView = "list";
    state.selectedOverseasPickingBatchId = "";
    state.selectedOverseasPickingBatchDetail = null;
    renderOverseasPickingBatchControls();
    return;
  }

  const list = await request("/orders/overseas-warehouse/picking-batches");
  state.overseasPickingBatches = Array.isArray(list) ? list : [];
  const selected = getSelectedOverseasPickingBatch();
  if (!selected) {
    state.selectedOverseasPickingBatchId = "";
    if (state.overseasPickingBatchView === "detail") {
      state.overseasPickingBatchView = "list";
      state.selectedOverseasPickingBatchDetail = null;
    }
  }
  if (state.overseasPickingBatchView === "detail" && state.selectedOverseasPickingBatchId) {
    await loadOverseasPickingBatchDetail(state.selectedOverseasPickingBatchId);
    return;
  }
  if (state.overseasPickingBatchView !== "detail") {
    state.selectedOverseasPickingBatchDetail = null;
  }
  renderOverseasPickingBatchControls();
}

async function openOverseasPickingBatchDetail(batchId, options = {}) {
  const targetId = String(batchId || "").trim();
  if (!targetId) {
    throw new Error("缺少拣货批次ID");
  }
  state.selectedOverseasPickingBatchId = targetId;
  state.overseasPickingBatchView = "detail";
  await loadOverseasPickingBatchDetail(targetId);
  renderYamatoShipmentBatchControls();
  if (options.focusScan !== false) {
    focusOverseasPickingScanInput();
  }
}

async function createOverseasPickingBatch(items) {
  return request("/orders/overseas-warehouse/picking-batches", {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}

async function confirmOverseasPickingBatch(batchId, items) {
  return request(`/orders/overseas-warehouse/picking-batches/${encodeURIComponent(batchId)}/confirm`, {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}

async function scanOverseasPickingBatchProduct(batchId, productId) {
  return request(`/orders/overseas-warehouse/picking-batches/${encodeURIComponent(batchId)}/scan`, {
    method: "POST",
    body: JSON.stringify({ productId }),
  });
}

async function switchOverseasPickingBatchProductToChina(batchId, productId) {
  return request(
    `/orders/overseas-warehouse/picking-batches/${encodeURIComponent(batchId)}/products/${encodeURIComponent(productId)}/switch-to-china`,
    {
      method: "POST",
    },
  );
}

async function switchOverseasPickingBatchItemToChina(batchId, itemId) {
  return request(
    `/orders/overseas-warehouse/picking-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/switch-to-china`,
    {
      method: "POST",
    },
  );
}

async function removeOverseasPickingBatchItem(batchId, itemId) {
  return request(
    `/orders/overseas-warehouse/picking-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/remove`,
    {
      method: "POST",
    },
  );
}

async function resetOverseasPickingBatchProductPicking(batchId, productId) {
  return request(
    `/orders/overseas-warehouse/picking-batches/${encodeURIComponent(batchId)}/products/${encodeURIComponent(productId)}/reset-picking`,
    {
      method: "POST",
    },
  );
}

async function downloadOverseasPickingBatchYamatoImport(batchId) {
  const response = await fetchAuthorizedResponse(
    `/orders/overseas-warehouse/picking-batches/${encodeURIComponent(batchId)}/yamato-export`,
    {
      method: "POST",
    },
  );
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = resolveDownloadFileName(response, "ヤマト-インポート.xlsx");
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  return {
    fileName: link.download,
    batchId: String(response.headers.get("x-yamato-batch-id") || "").trim(),
  };
}

function focusOverseasPickingScanInput() {
  const input = $("overseasPickingScanInput");
  if (!input) return;
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function scrollOverseasPickingBatchItemsToTop() {
  const wrap = $("overseasPickingBatchItemsWrap");
  if (!wrap) return;
  requestAnimationFrame(() => {
    wrap.scrollTop = 0;
  });
}

function getOverseasPickingScanRequest() {
  const input = $("overseasPickingScanInput");
  const rawValue = String(input?.value || "").trim();
  if (!rawValue) {
    throw new Error("请先扫码或输入产品ID");
  }
  const detail = state.selectedOverseasPickingBatchDetail;
  if (!detail?.id) {
    throw new Error("请先选择一个拣货批次");
  }
  if (String(detail.status || "") !== "created") {
    throw new Error(`批次 ${detail.batchNo || detail.id} 已确认，不能继续拣货扫码`);
  }
  return { input, rawValue, detail };
}

async function submitOverseasPickingScan(scanRequest = null) {
  const { input, rawValue, detail } = scanRequest || getOverseasPickingScanRequest();
  const result = await scanOverseasPickingBatchProduct(detail.id, rawValue);
  if (input) {
    input.value = "";
  }
  await loadOverseasPickingBatchDetail(detail.id);
  scrollOverseasPickingBatchItemsToTop();
  showToast(
    `产品ID ${result.productId || rawValue} 已拣 ${result.pickedQty}/${result.requestedQty}`,
  );
  focusOverseasPickingScanInput();
}

function getSelectedYamatoShipmentBatch() {
  const detailBatchId = String(state.selectedOverseasPickingBatchDetail?.yamatoShipmentBatchId || "").trim();
  if (!detailBatchId) return null;
  return state.yamatoShipmentBatches.find((item) => String(item?.id || "") === detailBatchId) || null;
}

function getYamatoShipmentBatchById(batchId) {
  const targetId = String(batchId || "").trim();
  if (!targetId) return null;
  return state.yamatoShipmentBatches.find((item) => String(item?.id || "") === targetId) || null;
}

function getYamatoPendingPageCount(batch) {
  const count = Number(batch?.pendingPageCount ?? 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function isYamatoBatchPrintComplete(batch) {
  const pageCount = Number(batch?.pageCount ?? 0);
  return Boolean(batch && pageCount > 0 && getYamatoPendingPageCount(batch) === 0);
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function refreshYamatoPrintStateForSelectedBatch() {
  await loadYamatoShipmentBatches();
  if (state.selectedOverseasPickingBatchId) {
    await loadOverseasPickingBatchDetail(state.selectedOverseasPickingBatchId);
  }
}

async function waitForYamatoBatchPrintCompletion(batchId, { maxAttempts = 30, intervalMs = 1000 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await wait(intervalMs);
    await refreshYamatoPrintStateForSelectedBatch();
    const refreshedBatch = getYamatoShipmentBatchById(batchId);
    if (isYamatoBatchPrintComplete(refreshedBatch)) {
      return true;
    }
  }
  return false;
}

async function showYamatoBatchPrintCompletePrompt() {
  await openActionConfirmModal("已完成该批次所有面单的打印", "提示", "确认", {
    showCancel: false,
  });
  focusOverseasYamatoScanInput();
}

function normalizeYamatoPrintConfig(config) {
  const rawMode = String(config?.mode || "").trim().toLowerCase();
  const mode = rawMode === "direct" || rawMode === "agent" ? rawMode : "browser";
  return {
    mode,
    printerName: String(config?.printerName || "").trim(),
  };
}

function getYamatoPrintModeSummary() {
  const config = normalizeYamatoPrintConfig(state.yamatoPrintConfig);
  if (config.mode === "direct") {
    return config.printerName
      ? `打印方式：直打到 ${config.printerName}`
      : "打印方式：直打到系统默认打印机";
  }
  if (config.mode === "agent") {
    return "打印方式：打印代理队列";
  }
  return "打印方式：浏览器预览打印";
}

function renderYamatoShipmentBatchControls() {
  const summary = $("overseasYamatoBatchSummary");
  const meta = $("overseasYamatoBatchMeta");
  const uploadBtn = $("overseasUploadYamatoPdfBtn");
  const scanBtn = $("overseasYamatoScanSubmitBtn");
  const scanInput = $("overseasYamatoScanInput");
  const currentBatch = getSelectedYamatoShipmentBatch();
  const canUploadPdf = Boolean(currentBatch);
  const canScanPrint = Boolean(currentBatch && currentBatch.status === "pdf_ready");

  if (meta) {
    if (!currentBatch) {
      meta.innerHTML = '<span class="overseas-picking-meta-tag">Yamato：尚未生成</span>';
    } else {
      const tags = [
        `批次：#${currentBatch.id}`,
        `状态：${currentBatch.status === "pdf_ready" ? "已上传PDF" : "待上传PDF"}`,
        `面单数：${displayText(currentBatch.pageCount)}`,
      ];
      if (currentBatch.status === "pdf_ready") {
        tags.push(`未打印：${displayText(currentBatch.pendingPageCount)}`);
        tags.push(`已打印：${displayText(currentBatch.printedPageCount)}`);
      }
      meta.innerHTML = tags.map((item) => `<span class="overseas-picking-meta-tag">${escapeHtml(item)}</span>`).join("");
    }
  }

  if (uploadBtn) {
    uploadBtn.disabled = !canUploadPdf;
    uploadBtn.textContent =
      currentBatch?.status === "pdf_ready" ? "3.重新上传 Yamato PDF" : "3.上传 Yamato PDF";
  }
  if (scanBtn) {
    scanBtn.disabled = !canScanPrint;
    scanBtn.textContent = "4.扫码打印";
  }
  if (scanInput) {
    scanInput.disabled = !canScanPrint;
  }

  if (summary) {
    if (!currentBatch) {
      summary.textContent = "";
    } else if (currentBatch.status !== "pdf_ready") {
      summary.textContent =
        `当前拣货批次对应的 Yamato 批次 #${currentBatch.id} 已生成 Excel，尚未上传 PDF。应上传 ${currentBatch.pageCount} 张面单（相同订单号已合并计算）。${getYamatoPrintModeSummary()}`;
    } else {
      summary.textContent =
        `当前拣货批次对应的 Yamato 批次 #${currentBatch.id} 已上传 PDF：共 ${currentBatch.pageCount} 张面单，未打印 ${currentBatch.pendingPageCount} 张，已打印 ${currentBatch.printedPageCount} 张。${getYamatoPrintModeSummary()}`;
    }
  }
}

async function loadYamatoShipmentBatches() {
  if (!state.token) {
    state.yamatoShipmentBatches = [];
    state.yamatoPrintConfig = normalizeYamatoPrintConfig(null);
    state.selectedYamatoShipmentBatchId = "";
    renderYamatoShipmentBatchControls();
    return;
  }

  const [list, printConfig] = await Promise.all([
    request("/orders/overseas-warehouse/yamato-batches"),
    request("/orders/overseas-warehouse/yamato-print-config"),
  ]);
  state.yamatoShipmentBatches = Array.isArray(list) ? list : [];
  state.yamatoPrintConfig = normalizeYamatoPrintConfig(printConfig);
  renderYamatoShipmentBatchControls();
}

async function importAmazonOrdersFile(file) {
  const formData = new FormData();
  formData.append("file", file);
  return request("/orders/amazon/import-txt", {
    method: "POST",
    body: formData,
  });
}

async function deleteRakutenOrders(ids) {
  return request("/orders/delete-batch", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

async function downloadOverseasYamatoImport(items) {
  const response = await fetchAuthorizedResponse("/orders/overseas-warehouse/yamato-export", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ items }),
  });
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = resolveDownloadFileName(response, "ヤマト-インポート.xlsx");
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  return {
    fileName: link.download,
    batchId: String(response.headers.get("x-yamato-batch-id") || "").trim(),
  };
}

function focusOverseasYamatoScanInput() {
  const input = $("overseasYamatoScanInput");
  if (!input) return;
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

async function uploadYamatoShipmentBatchPdf(batchId, files) {
  const formData = new FormData();
  files.forEach((file) => {
    formData.append("files", file);
  });
  return request(`/orders/overseas-warehouse/yamato-batches/${encodeURIComponent(batchId)}/upload-pdf`, {
    method: "POST",
    body: formData,
  });
}

async function directPrintYamatoShipmentLabelByProductId(batchId, productId) {
  return request(
    `/orders/overseas-warehouse/yamato-batches/${encodeURIComponent(batchId)}/direct-print-by-product`,
    {
      method: "POST",
      body: JSON.stringify({ productId }),
    },
  );
}

async function queueYamatoShipmentLabelByProductId(batchId, productId) {
  return request(
    `/orders/overseas-warehouse/yamato-batches/${encodeURIComponent(batchId)}/queue-print-by-product`,
    {
      method: "POST",
      body: JSON.stringify({ productId }),
    },
  );
}

function openYamatoPrintPlaceholderWindow(title = "Yamato 面单打印") {
  const popup = window.open("", "_blank");
  if (!popup) {
    throw new Error("打印窗口被浏览器阻止，请允许弹窗后重试");
  }

  popup.document.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      html, body {
        margin: 0;
        height: 100%;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f4f7f5;
        color: #18322a;
      }
      body {
        display: grid;
        place-items: center;
      }
      .yamato-print-loading {
        display: grid;
        gap: 12px;
        justify-items: center;
        padding: 24px;
        text-align: center;
      }
      .yamato-print-loading__spinner {
        width: 28px;
        height: 28px;
        border: 3px solid rgba(24, 50, 42, 0.18);
        border-top-color: #198754;
        border-radius: 999px;
        animation: yamato-print-spin 0.9s linear infinite;
      }
      @keyframes yamato-print-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    </style>
  </head>
  <body>
    <div class="yamato-print-loading">
      <div class="yamato-print-loading__spinner"></div>
      <div>Yamato 面单准备中，请稍候...</div>
    </div>
  </body>
</html>`);
  popup.document.close();
  return popup;
}

function openYamatoPdfPrintWindow(blob, title = "Yamato 面单打印", popup = null) {
  const href = URL.createObjectURL(blob);
  const targetWindow = popup && !popup.closed ? popup : window.open("", "_blank");
  if (!targetWindow) {
    URL.revokeObjectURL(href);
    throw new Error("打印窗口被浏览器阻止，请允许弹窗后重试");
  }

  targetWindow.document.open();
  targetWindow.document.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      html, body { margin: 0; height: 100%; background: #111; }
      iframe { width: 100%; height: 100%; border: 0; }
    </style>
  </head>
  <body>
    <iframe id="yamatoPdfFrame" src="${href}#toolbar=0&navpanes=0&scrollbar=0"></iframe>
    <script>
      const iframe = document.getElementById('yamatoPdfFrame');
      const doPrint = () => {
        setTimeout(() => {
          try {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
          } catch (error) {
            try { window.print(); } catch (_) {}
          }
        }, 600);
      };
      iframe.addEventListener('load', doPrint, { once: true });
      window.addEventListener('afterprint', () => setTimeout(() => window.close(), 200));
    <\/script>
  </body>
</html>`);
  targetWindow.document.close();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

async function printYamatoShipmentLabelByProductId(batchId, productId, popup = null) {
  const response = await fetchAuthorizedResponse(
    `/orders/overseas-warehouse/yamato-batches/${encodeURIComponent(batchId)}/print-by-product`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ productId }),
    },
  );
  const blob = await response.blob();
  const meta = {
    batchId: String(response.headers.get("x-yamato-batch-id") || "").trim(),
    pageNo: Number(response.headers.get("x-yamato-page-no") || 0),
    trackingNo: String(response.headers.get("x-yamato-tracking-no") || "").trim(),
    productId: String(response.headers.get("x-yamato-product-id") || "").trim(),
    remainingMatchCount: Number(response.headers.get("x-yamato-remaining-match-count") || 0),
  };
  openYamatoPdfPrintWindow(
    blob,
    `Yamato 面单 ${meta.productId || productId}${meta.pageNo > 0 ? ` 第${meta.pageNo}页` : ""}`,
    popup,
  );
  return meta;
}

function getOverseasYamatoScanRequest() {
  const input = $("overseasYamatoScanInput");
  const rawValue = String(input?.value || "").trim();
  if (!rawValue) {
    throw new Error("请先扫码或输入产品ID");
  }

  const detail = state.selectedOverseasPickingBatchDetail;
  if (!detail?.id) {
    throw new Error("请先打开一个拣货批次详情");
  }
  const batch = getSelectedYamatoShipmentBatch();
  if (!batch) {
    throw new Error("当前拣货批次还没有生成 Yamato 批次");
  }
  if (batch.status !== "pdf_ready") {
    throw new Error(`批次 #${batch.id} 尚未上传 Yamato PDF`);
  }
  return { input, rawValue, batch };
}

async function submitOverseasYamatoScan(options = {}) {
  const { popup = null, scanRequest = null } = options;
  const { input, rawValue, batch } = scanRequest || getOverseasYamatoScanRequest();
  const pendingBeforePrint = getYamatoPendingPageCount(batch);
  const printConfig = normalizeYamatoPrintConfig(state.yamatoPrintConfig);
  const isDirectMode = printConfig.mode === "direct";
  const isAgentMode = printConfig.mode === "agent";
  if (isAgentMode) {
    await queueYamatoShipmentLabelByProductId(batch.id, rawValue);
  } else if (isDirectMode) {
    await directPrintYamatoShipmentLabelByProductId(batch.id, rawValue);
  } else {
    await printYamatoShipmentLabelByProductId(batch.id, rawValue, popup);
  }

  if (input) {
    input.value = "";
  }
  await refreshYamatoPrintStateForSelectedBatch();
  const refreshedBatch = getYamatoShipmentBatchById(batch.id) || getSelectedYamatoShipmentBatch();
  const isCompleteAfterPrint = pendingBeforePrint > 0 && isYamatoBatchPrintComplete(refreshedBatch);
  focusOverseasYamatoScanInput();
  if (isCompleteAfterPrint) {
    await showYamatoBatchPrintCompletePrompt();
    return;
  }
  if (isAgentMode && pendingBeforePrint === 1) {
    waitForYamatoBatchPrintCompletion(batch.id)
      .then((isComplete) => {
        if (isComplete) {
          return showYamatoBatchPrintCompletePrompt();
        }
        return undefined;
      })
      .catch(() => {});
  }
}

async function deleteAmazonOrders(ids) {
  return request("/orders/amazon/delete-batch", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

async function deleteManualOrders(ids) {
  return request("/orders/manual/delete-batch", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

async function downloadAmazonShipmentConfirmationTxt(days) {
  const response = await fetchAuthorizedResponse("/orders/amazon/shipment-confirmation-txt", {
    method: "POST",
    body: JSON.stringify({ days }),
  });
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = resolveDownloadFileName(response, `amazon_shipment_confirmation_${formatDateForFilename(new Date())}.txt`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  return link.download;
}

async function downloadRakutenShipmentConfirmationCsv(days) {
  const response = await fetchAuthorizedResponse("/orders/rakuten/shipment-confirmation-csv", {
    method: "POST",
    body: JSON.stringify({ days }),
  });
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = resolveDownloadFileName(response, `rakuten_shipment_confirmation_${formatDateForFilename(new Date())}.csv`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  return link.download;
}

function loadMoreAmazonOrdersIfNeeded() {
  const panel = $("amazonOrderImport");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.amazonOrdersVisibleCount >= state.amazonOrders.length) return;
  state.amazonOrdersVisibleCount += state.inventoryPageSize;
  renderAmazonOrdersTable();
}

function loadMoreManualOrdersIfNeeded() {
  const panel = $("manualOrderProcessing");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.manualOrdersVisibleCount >= state.manualOrders.length) return;
  state.manualOrdersVisibleCount += state.inventoryPageSize;
  renderManualOrdersTable();
}

function renderFbaReplenishmentList() {
  const tbody = $("fbaReplenishmentBody");
  if (!tbody) return;
  syncSelectedFbaIds();
  const list = state.fbaReplenishments.slice(0, state.fbaReplenishmentsVisibleCount);

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="muted">-</td></tr>';
    updateFbaSelectAll();
    updateFbaOutboundButtonState();
    return;
  }

  tbody.innerHTML = list
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
        <td>
          ${
            item.sku?.productId
              ? `<a class="inline-link-btn" href="${escapeHtml(buildMasterProductDetailUrl(item.sku.productId))}" target="_blank" rel="noopener noreferrer">${escapeHtml(displayText(item.sku.productId))}</a>`
              : escapeHtml(displayText(item.sku?.productId))
          }
        </td>
        <td>${escapeHtml(displayText(item.sku?.productName))}</td>
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
            ${
              item.status === "outbound"
                ? `<span class="muted">${escapeHtml(item.expressNo ? `快递号：${item.expressNo}` : "-")}</span>`
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

function loadMoreFbaReplenishmentsIfNeeded() {
  const panel = $("fbaReplenishment");
  if (!panel || !panel.classList.contains("active")) return;
  if (state.fbaReplenishmentsVisibleCount >= state.fbaReplenishments.length) return;
  state.fbaReplenishmentsVisibleCount += state.inventoryPageSize;
  renderFbaReplenishmentList();
}

function maybeAutoLoadAmazonOrders() {
  const panel = $("amazonOrderImport");
  if (!panel || !panel.classList.contains("active")) return;
  const tableWrap = $("amazonOrdersTableWrap");
  if (!tableWrap) return;
  if (state.amazonOrdersVisibleCount >= state.amazonOrders.length) return;

  const threshold = 120;
  const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
  if (currentBottom < tableWrap.scrollHeight - threshold) return;

  loadMoreAmazonOrdersIfNeeded();
}

function maybeAutoLoadManualOrders() {
  const panel = $("manualOrderProcessing");
  if (!panel || !panel.classList.contains("active")) return;
  const tableWrap = $("manualOrdersTableWrap");
  if (!tableWrap) return;
  if (state.manualOrdersVisibleCount >= state.manualOrders.length) return;

  const threshold = 120;
  const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
  if (currentBottom < tableWrap.scrollHeight - threshold) return;

  loadMoreManualOrdersIfNeeded();
}

function maybeAutoLoadFbaReplenishments() {
  const panel = $("fbaReplenishment");
  if (!panel || !panel.classList.contains("active")) return;
  const tableWrap = $("fbaReplenishmentTableWrap");
  if (!tableWrap) return;
  if (state.fbaReplenishmentsVisibleCount >= state.fbaReplenishments.length) return;

  const threshold = 120;
  const currentBottom = tableWrap.scrollTop + tableWrap.clientHeight;
  if (currentBottom < tableWrap.scrollHeight - threshold) return;

  loadMoreFbaReplenishmentsIfNeeded();
}

function setupAmazonOrdersLoadObserver() {
  if (amazonOrdersLoadObserver) {
    amazonOrdersLoadObserver.disconnect();
    amazonOrdersLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("amazonOrdersTableWrap");
  const sentinel = $("amazonOrdersLoadSentinel");
  if (!tableWrap || !sentinel) return;

  amazonOrdersLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreAmazonOrdersIfNeeded();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  amazonOrdersLoadObserver.observe(sentinel);
}

function setupManualOrdersLoadObserver() {
  if (manualOrdersLoadObserver) {
    manualOrdersLoadObserver.disconnect();
    manualOrdersLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("manualOrdersTableWrap");
  const sentinel = $("manualOrdersLoadSentinel");
  if (!tableWrap || !sentinel) return;

  manualOrdersLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreManualOrdersIfNeeded();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  manualOrdersLoadObserver.observe(sentinel);
}

function setupFbaReplenishmentLoadObserver() {
  if (fbaReplenishmentLoadObserver) {
    fbaReplenishmentLoadObserver.disconnect();
    fbaReplenishmentLoadObserver = null;
  }
  if (typeof IntersectionObserver !== "function") return;
  const tableWrap = $("fbaReplenishmentTableWrap");
  const sentinel = $("fbaReplenishmentLoadSentinel");
  if (!tableWrap || !sentinel) return;

  fbaReplenishmentLoadObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreFbaReplenishmentsIfNeeded();
      }
    },
    {
      root: tableWrap,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0.01,
    },
  );
  fbaReplenishmentLoadObserver.observe(sentinel);
}

async function loadFbaReplenishments() {
  if (!state.token) {
    state.fbaReplenishments = [];
    state.fbaReplenishmentsVisibleCount = 0;
    state.selectedFbaIds = new Set();
    renderFbaReplenishmentList();
    return;
  }

  const list = await request("/inventory/fba-replenishments");
  state.fbaReplenishments = Array.isArray(list) ? list : [];
  state.fbaReplenishmentsVisibleCount = state.inventoryPageSize;
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

async function moveProductBetweenBoxes({ productId, oldBoxCode, newBoxCode }) {
  return request("/inventory/move-product-between-boxes", {
    method: "POST",
    body: JSON.stringify({
      productId: normalizedProductId,
      fromBoxCode: oldBoxCode,
      toBoxCode: newBoxCode,
    }),
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

function syncSelectedAmazonOrderIds() {
  const selectableIds = new Set(state.amazonOrders.map((item) => String(item.id)));
  state.selectedAmazonOrderIds = new Set(
    Array.from(state.selectedAmazonOrderIds).filter((id) => selectableIds.has(String(id))),
  );
}

function syncSelectedManualOrderIds() {
  const selectableIds = new Set(state.manualOrders.map((item) => String(item.id)));
  state.selectedManualOrderIds = new Set(
    Array.from(state.selectedManualOrderIds).filter((id) => selectableIds.has(String(id))),
  );
}

function syncSelectedRakutenOrderIds() {
  const selectableIds = new Set(state.orders.map((item) => String(item.id)));
  state.selectedRakutenOrderIds = new Set(
    Array.from(state.selectedRakutenOrderIds).filter((id) => selectableIds.has(String(id))),
  );
}

function updateRakutenOrdersSelectAll() {
  const selectAll = $("rakutenOrdersSelectAll");
  if (!selectAll) return;
  if (!state.orders.length) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }

  const selectedCount = state.orders.filter((item) => state.selectedRakutenOrderIds.has(String(item.id))).length;
  selectAll.checked = selectedCount > 0 && selectedCount === state.orders.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < state.orders.length;
}

function updateRakutenBatchDeleteButtonState() {
  const button = $("rakutenBatchDeleteBtn");
  if (!button) return;
  const count = state.selectedRakutenOrderIds.size;
  button.disabled = count <= 0;
  button.textContent = count > 0 ? `批量删除（${count}）` : "批量删除";
}

function syncSelectedOverseasOrderKeys() {
  const selectableKeys = new Set(
    state.overseasOrderProcessingOrders
      .filter((item) => item?.id)
      .map((item) => `${item.source}:${item.id}`),
  );
  state.selectedOverseasOrderKeys = new Set(
    Array.from(state.selectedOverseasOrderKeys).filter((key) => selectableKeys.has(String(key))),
  );
}

function updateOverseasOrderProcessingSelectAll() {
  const selectAll = $("overseasOrderProcessingSelectAll");
  if (!selectAll) return;
  const selectable = state.overseasOrderProcessingOrders
    .filter((item) => item?.id)
    .map((item) => `${item.source}:${item.id}`);
  if (!selectable.length) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }

  const selectedCount = selectable.filter((key) => state.selectedOverseasOrderKeys.has(key)).length;
  selectAll.checked = selectedCount > 0 && selectedCount === selectable.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
}

function updateOverseasCreatePickingBatchButtonState() {
  const button = $("overseasCreatePickingBatchBtn");
  if (!button) return;
  const count = state.selectedOverseasOrderKeys.size;
  button.disabled = count <= 0;
  button.textContent = count > 0 ? `批次生成（${count}）` : "批次生成";
}

function updateAmazonOrdersSelectAll() {
  const selectAll = $("amazonOrdersSelectAll");
  if (!selectAll) return;
  if (!state.amazonOrders.length) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }

  const selectedCount = state.amazonOrders.filter((item) => state.selectedAmazonOrderIds.has(String(item.id))).length;
  selectAll.checked = selectedCount > 0 && selectedCount === state.amazonOrders.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < state.amazonOrders.length;
}

function updateAmazonBatchDeleteButtonState() {
  const button = $("amazonBatchDeleteBtn");
  const count = state.selectedAmazonOrderIds.size;
  if (button) {
    button.disabled = count <= 0;
    button.textContent = count > 0 ? `批量删除（${count}）` : "批量删除";
  }
}

function updateManualOrdersSelectAll() {
  const selectAll = $("manualOrdersSelectAll");
  if (!selectAll) return;
  if (!state.manualOrders.length) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }

  const selectedCount = state.manualOrders.filter((item) => state.selectedManualOrderIds.has(String(item.id))).length;
  selectAll.checked = selectedCount > 0 && selectedCount === state.manualOrders.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < state.manualOrders.length;
}

function updateManualOrderBatchDeleteButtonState() {
  const button = $("manualOrderBatchDeleteBtn");
  const count = state.selectedManualOrderIds.size;
  if (button) {
    button.disabled = count <= 0;
    button.textContent = count > 0 ? `批量删除（${count}）` : "批量删除";
  }
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
  let boxCode = normalizeBoxCodeInput(rawBoxCode);
  const qty = Math.abs(Number($("adjustQty").value));
  const reason = $("adjustReason").value.trim() || undefined;

  if (!Number.isInteger(skuId) || skuId <= 0) {
    throw new Error("请选择产品");
  }
  if (!boxCode) {
    throw new Error("请选择箱号");
  }
  if (direction === "inbound") {
    boxCode = await validateAdjustBoxInput(rawBoxCode, { normalizeInput: true });
    if (!boxCode) {
      throw new Error("箱号不存在，请选择已有箱号或者先新增箱号");
    }
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
  const productId = $("modalNewProductId").value.trim() || undefined;
  const shop = $("modalNewShop").value.trim() || undefined;
  const remark = $("modalNewRemark").value.trim() || undefined;
  const sku = $("modalNewSku").value.trim();
  const rbSku = $("modalNewErpSku").value.trim() || undefined;
  const asin = $("modalNewAsin").value.trim() || undefined;
  const fnsku = $("modalNewFnsku").value.trim() || undefined;
  const fbmSku = $("modalNewFbmSku").value.trim() || undefined;

  if (!sku) throw new Error("SKU 不能为空");

  const possibleDuplicate = await request(`/skus?q=${encodeURIComponent(sku)}`);
  if (possibleDuplicate.some((item) => item.sku === sku)) {
    throw new Error("SKU 已存在");
  }

  let normalizedProductId = productId;
  if (normalizedProductId) {
    const matchedProduct = await syncSkuProductName("modalNewProductId", "modalNewProductName");
    if (!matchedProduct?.productId) {
      throw new Error("未匹配到产品名称，请确认产品ID");
    }
    normalizedProductId = matchedProduct.productId;
  }

  await request("/skus", {
    method: "POST",
    body: JSON.stringify({
      productId,
      shop,
      remark,
      sku,
      rbSku,
      asin,
      fnsku,
      fbmSku,
    }),
  });
}

async function importSkusFromExcel(file) {
  if (!file) {
    throw new Error("请先选择Excel文件");
  }
  const formData = new FormData();
  formData.append("file", file);
  return request("/skus/import-excel", {
    method: "POST",
    body: formData,
  });
}

async function importBulkInventoryUpdateFromExcel(file) {
  if (!file) {
    throw new Error("请先选择Excel文件");
  }
  const formData = new FormData();
  formData.append("file", file);
  return request("/inventory/bulk-update-excel", {
    method: "POST",
    body: formData,
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
  const shelfCode = buildStrictShelfCode($("modalNewShelfCodeDigits").value);
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
  const targetShelf = getEnabledShelvesSorted().find(
    (item) => String(item.shelfCode).toUpperCase() === String(targetShelfCode).toUpperCase(),
  );
  $("moveShelfTargetCode").value = formatShelfCodeWithName(
    targetShelf || { shelfCode: targetShelfCode },
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
  const productId = resolveMoveProductProductId();
  if (!productId) {
    throw new Error("请选择产品ID");
  }

  const rows = (await request(`/inventory/master-product-boxes?productId=${encodeURIComponent(productId)}`)).filter(
    (row) => Number(row?.qty ?? 0) > 0 && row?.box?.boxCode,
  );
  if (!rows.length) {
    throw new Error("该主商品当前没有可移动库存");
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
      throw new Error("该主商品存在多个箱号，请手动指定旧箱号");
    }
    throw new Error("旧箱号与主商品不匹配");
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
    throw new Error("旧箱号下该主商品库存不足");
  }

  return moveProductBetweenBoxes({
    productId,
    oldBoxCode: oldRow.box.boxCode,
    newBoxCode,
  });
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
  $("moveProductOldBoxCode").innerHTML = '<option value="">请先选择产品ID</option>';
  $("moveProductOldShelfCode").value = "";
  $("moveProductNewShelfCode").value = "";
  const hint = $("moveProductOldBoxHint");
  if (hint) hint.classList.add("hidden");
  renderMasterProductOptionsForInput("moveProductProductId", "moveProductProductIdList");
  renderMoveProductNewBoxOptions("");
}

async function reloadAll() {
  await loadMe();
  if (!state.token) {
    clearStats();
    clearOverviewDashboard();
    $("usersBody").innerHTML = "";
    $("auditBody").innerHTML = "";
    $("myAuditBody").innerHTML = "";
    $("inventoryBody").innerHTML = "";
    $("batchInboundBody").innerHTML = "";
    $("fbaReplenishmentBody").innerHTML = "";
    if ($("chinaOrderProcessingPendingBody")) $("chinaOrderProcessingPendingBody").innerHTML = "";
    if ($("chinaOrderProcessingExportedBody")) $("chinaOrderProcessingExportedBody").innerHTML = "";
    if ($("chinaOrderProcessingPendingSummary")) $("chinaOrderProcessingPendingSummary").textContent = "";
    if ($("chinaOrderProcessingExportedSummary")) $("chinaOrderProcessingExportedSummary").textContent = "";
    renderBatchInboundDetail(null);
    if ($("inventoryDetailMeta")) $("inventoryDetailMeta").innerHTML = "";
    if ($("inventoryDetailSkuBody")) $("inventoryDetailSkuBody").innerHTML = "";
    if ($("inventoryDetailBoxBody")) $("inventoryDetailBoxBody").innerHTML = "";
    if ($("brandsBody")) $("brandsBody").innerHTML = "";
    if ($("skuTypesBody")) $("skuTypesBody").innerHTML = "";
    $("shopsBody").innerHTML = "";
    $("shelfManageBody").innerHTML = "";
    $("boxManageBody").innerHTML = "";
    if ($("emptyBoxManageBody")) $("emptyBoxManageBody").innerHTML = "";
    $("dataBackupBody").innerHTML = "";
    $("productEditRequestBody").innerHTML = "";
    if ($("skuManagementBody")) $("skuManagementBody").innerHTML = "";
    if ($("skuManagementSummary")) $("skuManagementSummary").textContent = "共 0 条SKU";
    if ($("manualOrdersBody")) $("manualOrdersBody").innerHTML = "";
    if ($("masterProductBody")) $("masterProductBody").innerHTML = "";
    if ($("masterProductSkuBody")) $("masterProductSkuBody").innerHTML = "";
    if ($("masterProductBoxBody")) $("masterProductBoxBody").innerHTML = "";
    if ($("masterProductSyncRecordBody")) $("masterProductSyncRecordBody").innerHTML = "";
    $("departmentOptionsBody").innerHTML = "";
    if ($("roleOptionsBody")) $("roleOptionsBody").innerHTML = "";
    renderProductEditRequestDetail(null);
    state.brands = [];
    state.skuTypes = [];
    state.shops = [];
    state.shelfEditingIds = new Set();
    state.boxEditingIds = new Set();
    state.departmentOptions = [];
    state.roleOptions = [];
    state.users = [];
    state.usersById = new Map();
    state.auditLogs = [];
    state.myAuditLogs = [];
    state.skuEditRequests = [];
    state.inventorySkus = [];
    state.boxes = [];
    state.boxManageRows = [];
    state.boxManagePage = 1;
    state.boxManageHasMore = false;
    state.boxManageLoading = false;
    state.emptyBoxes = [];
    state.orders = [];
    state.ordersVisibleCount = 0;
    state.amazonOrders = [];
    state.amazonOrdersVisibleCount = 0;
    state.overseasOrderProcessingOrders = [];
    state.chinaOrderProcessingOrders = [];
    state.overseasPickingBatches = [];
    state.overseasPickingBatchView = "list";
    state.selectedOverseasPickingBatchId = "";
    state.selectedOverseasPickingBatchDetail = null;
    state.yamatoShipmentBatches = [];
    state.selectedYamatoShipmentBatchId = "";
    state.selectedAmazonOrderIds = new Set();
    state.inventoryHomeProducts = [];
    state.inventoryHomePage = 1;
    state.inventoryHomeHasMore = false;
    state.inventoryHomeKeyword = "";
    state.inventoryHomeSelectedDetail = null;
    state.masterProducts = [];
    state.masterProductsPage = 1;
    state.masterProductsHasMore = false;
    state.masterProductKeyword = "";
    state.masterProductView = "syncRecords";
    state.selectedMasterProductId = "";
    state.selectedMasterProductDetail = null;
    state.masterProductSyncRecords = [];
    state.masterProductSyncRecordsPage = 1;
    state.masterProductSyncRecordsHasMore = false;
    state.masterProductExportFilterOptions = null;
    state.inventorySortedSkus = [];
    state.inventoryLocations = new Map();
    state.inventoryTotalsBySku = {};
    state.skuManagementKeyword = "";
    state.skuManagementVisibleCount = 0;
    state.dataBackups = [];
    state.dataBackupsVisibleCount = 0;
    state.inventoryVisibleCount = 0;
    state.usersVisibleCount = 0;
    state.auditVisibleCount = 0;
    state.myAuditVisibleCount = 0;
    state.skuEditRequestsPage = 1;
    state.skuEditRequestsHasMore = false;
    state.skuEditRequestsLoading = false;
    state.batchInboundVisibleCount = 0;
    state.stocktakeVisibleCount = 0;
    state.fbaReplenishmentsVisibleCount = 0;
    state.fbaPendingCount = 0;
    state.productEditPendingCount = 0;
    state.fbaPendingBySku = {};
    state.fbaPendingByBoxSku = {};
    state.selectedFbaIds = new Set();
    state.selectedProductEditRequestId = null;
    state.selectedProductEditRequestChangedFields = [];
    state.selectedProductEditRequestIds = new Set();
    const productEditSelectAll = $("productEditSelectAll");
    if (productEditSelectAll) {
      productEditSelectAll.checked = false;
      productEditSelectAll.indeterminate = false;
    }
    state.brandEditingIds = new Set();
    state.skuTypeEditingIds = new Set();
    state.shopEditingIds = new Set();
    state.departmentOptionEditingCodes = new Set();
    state.roleOptionEditingCodes = new Set();
    state.overviewDashboard = null;
    renderUserSelectOptions();
    renderUserOptionsTable();
    renderFbaPendingBadge();
    renderProductEditPendingBadge();
    renderEmptyBoxManageBadge();
    renderEmptyBoxManageTable();
    renderOrdersTable();
    renderAmazonOrdersTable();
    renderOverseasOrderProcessingTable();
    renderOverseasPickingBatchControls();
    renderYamatoShipmentBatchControls();
    updateAmazonOrdersSelectAll();
    updateAmazonBatchDeleteButtonState();
    updateFbaSelectAll();
    updateFbaOutboundButtonState();
    resetInventorySearchState();
    setInventoryDisplayMode(false);
    return;
  }

  const isAdmin = hasAdminAccess(state.me?.role);
  const tasks = [
    loadInventory(),
    loadInventoryHomeProducts({ reset: true }),
    loadProductEditPendingSummary(),
  ];
  if (!isAdmin) {
    state.departmentOptions = [];
    state.roleOptions = [];
    state.departmentOptionEditingCodes = new Set();
    state.roleOptionEditingCodes = new Set();
    state.users = [];
    state.usersById = new Map();
    state.auditLogs = [];
    state.usersVisibleCount = 0;
    state.auditVisibleCount = 0;
    $("usersBody").innerHTML = "";
    $("departmentOptionsBody").innerHTML = "";
    if ($("roleOptionsBody")) $("roleOptionsBody").innerHTML = "";
    $("auditBody").innerHTML = "";
    $("statUsers").textContent = "-";
    renderUserSelectOptions();
    renderUserOptionsTable();
  }

  const results = await Promise.allSettled(tasks);
  const firstError = results.find((item) => item.status === "rejected");
  if (firstError && firstError.status === "rejected") {
    throw firstError.reason;
  }
  state.inventoryHomeSelectedDetail = null;
  setInventoryDisplayMode(false);
  focusInventorySearch();
}

function bindForms() {
  $("loginGateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      persistAuthGateMessage("");
      renderAuthGateMessage("");
      await withBusyButton(submitButton, "登录中...", async () => {
        const data = await request("/auth/login", {
          method: "POST",
          body: JSON.stringify({
            username: $("gateUsername").value.trim(),
            password: $("gatePassword").value,
          }),
        });
        hasUserNavigatedSinceBootstrap = false;
        state.token = persistAuthToken(data.accessToken);
        state.authDeployVersion = persistAuthDeployVersion(data.deployVersion);
        state.currentDeployVersion = String(data.deployVersion || "").trim();
        await reloadAll();
        await openInventoryStartupView();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  const handleLogout = async () => {
    hasUserNavigatedSinceBootstrap = false;
    state.token = "";
    state.authDeployVersion = "";
    state.currentDeployVersion = "";
    state.me = null;
    suppressAuthErrorToastUntil = Date.now() + 3000;
    clearPersistedAuthToken();
    document.querySelectorAll(".modal").forEach((modal) => modal.classList.add("hidden"));
    clearErrorModalAutoState();
    await reloadAll();
  };

  $("logoutBtn")?.addEventListener("click", handleLogout);
  $("topLogoutBtn")?.addEventListener("click", handleLogout);
  $("employeeQuickActions")?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    window.setTimeout(collapseQuickActions, 0);
  });
  $("toggleQuickActionsBtn")?.addEventListener("click", () => {
    const quickActions = $("employeeQuickActions");
    const toggle = $("toggleQuickActionsBtn");
    if (!quickActions || !toggle) return;
    const expanded = !quickActions.classList.contains("expanded");
    quickActions.classList.toggle("expanded", expanded);
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggle.textContent = expanded ? "收起功能" : "更多功能";
  });

  $("importRakutenOrdersForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitButton = getSubmitButton(form, event);
    try {
      await withBusyButton(submitButton, "导入中...", async () => {
        const file = $("rakutenOrdersImportFile").files?.[0];
        if (!file) {
          throw new Error("请选择乐天订单文件");
        }
        const result = await importOrdersFile(file);
        await loadOrders();
        await Promise.all([loadOverseasOrderProcessingOrders(), loadChinaOrderProcessingOrders()]);
        form.reset();
        showToast(
          `乐天订单导入完成，新增 ${result.createdCount} 条，跳过 ${result.skippedCount} 条，来源文件 ${result.sourceFileName}`,
          false,
        );
        closeModal("rakutenOrderImportModal");
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("rakutenBatchDeleteBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "删除中...", async () => {
        const ids = Array.from(state.selectedRakutenOrderIds)
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0);
        if (!ids.length) {
          throw new Error("请先选择要删除的乐天订单");
        }
        const ok = await openDeleteConfirmModal(`确认批量删除 ${ids.length} 条乐天订单记录？`);
        if (!ok) return;
        const result = await deleteRakutenOrders(ids);
        state.selectedRakutenOrderIds = new Set();
        await loadOrders();
        await Promise.all([loadOverseasOrderProcessingOrders(), loadChinaOrderProcessingOrders()]);
        showToast(`已删除 ${Number(result?.deletedCount || 0)} 条乐天订单记录`);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("overseasCreatePickingBatchBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "生成中...", async () => {
        const items = state.overseasOrderProcessingOrders
          .filter((item) => state.selectedOverseasOrderKeys.has(`${item.source}:${item.id || ""}`))
          .map((item) => ({
            source: item.source,
            id: item.id,
          }))
          .filter((item) => item.id);
        if (!items.length) {
          throw new Error("请先选择要批量打单的订单");
        }
        const result = await createOverseasPickingBatch(items);
        state.selectedOverseasOrderKeys = new Set();
        await Promise.all([loadOverseasOrderProcessingOrders(), loadOverseasPickingBatches(), loadYamatoShipmentBatches()]);
        switchPanel("overseasPickingBatchManagement");
        if (result?.id) {
          await openOverseasPickingBatchDetail(String(result.id || ""), { focusScan: true });
        }
        showToast(
          result?.batchNo
            ? `已创建拣货批次 ${result.batchNo}，请按货架顺序扫码拣货`
            : "拣货批次已创建",
        );
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("overseasPickingScanSubmitBtn")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      const scanRequest = getOverseasPickingScanRequest();
      await withBusyButton(button, "拣货中...", async () => {
        await submitOverseasPickingScan(scanRequest);
      });
    } catch (error) {
      showToast(error.message, true);
      focusOverseasPickingScanInput();
    }
  });

  $("overseasPickingScanInput")?.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const button = $("overseasPickingScanSubmitBtn");
    try {
      const scanRequest = getOverseasPickingScanRequest();
      await withBusyButton(button, "拣货中...", async () => {
        await submitOverseasPickingScan(scanRequest);
      });
    } catch (error) {
      showToast(error.message, true);
      focusOverseasPickingScanInput();
    }
  });

  $("overseasCompletePickingBtn")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "确认中...", async () => {
        const detail = state.selectedOverseasPickingBatchDetail;
        if (!detail?.id) {
          throw new Error("请先选择一个拣货批次");
        }
        if (detail.yamatoShipmentBatchId) {
          throw new Error(`当前批次已生成 Yamato 批次 #${detail.yamatoShipmentBatchId}`);
        }
        await confirmOverseasPickingBatch(detail.id, []);
        const result = await downloadOverseasPickingBatchYamatoImport(detail.id);
        await Promise.all([loadOverseasOrderProcessingOrders(), loadOverseasPickingBatches(), loadYamatoShipmentBatches()]);
        await loadOverseasPickingBatchDetail(detail.id);
        if (result.batchId) {
          state.selectedYamatoShipmentBatchId = result.batchId;
          renderYamatoShipmentBatchControls();
        }
        showToast(
          result.batchId
            ? `拣货确认完成，已下载 ${result.fileName}，Yamato 批次 #${result.batchId} 已创建，请上传 PDF`
            : `已下载 ${result.fileName}`,
        );
        focusOverseasYamatoScanInput();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("importOrdersForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitButton = getSubmitButton(form, event);
    try {
      await withBusyButton(submitButton, "导入中...", async () => {
        const file = $("ordersImportFile").files?.[0];
        if (!file) {
          throw new Error("请选择亚马逊订单TXT文件");
        }
        const result = await importAmazonOrdersFile(file);
        await loadAmazonOrders();
        await Promise.all([loadOverseasOrderProcessingOrders(), loadChinaOrderProcessingOrders()]);
        form.reset();
        showToast(
          `亚马逊订单导入完成：新增 ${result.createdCount} 条，跳过 ${result.skippedCount} 条（文件 ${result.sourceFileName}）`,
          false,
        );
        closeModal("amazonOrderImportModal");
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("amazonBatchDeleteBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "删除中...", async () => {
        const ids = Array.from(state.selectedAmazonOrderIds)
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0);
        if (!ids.length) {
          throw new Error("请先选择要删除的亚马逊订单");
        }
        const ok = await openDeleteConfirmModal(`确认批量删除 ${ids.length} 条亚马逊订单记录？`);
        if (!ok) return;
        const result = await deleteAmazonOrders(ids);
        state.selectedAmazonOrderIds = new Set();
        await loadAmazonOrders();
        await Promise.all([loadOverseasOrderProcessingOrders(), loadChinaOrderProcessingOrders()]);
        showToast(`已删除 ${Number(result?.deletedCount || 0)} 条亚马逊订单记录`);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("manualOrderBatchDeleteBtn")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "删除中...", async () => {
        const ids = Array.from(state.selectedManualOrderIds)
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0);
        if (!ids.length) {
          throw new Error("请先选择要删除的手动订单");
        }
        const ok = await openDeleteConfirmModal(`确认批量删除 ${ids.length} 条手动订单记录？`);
        if (!ok) return;
        const result = await deleteManualOrders(ids);
        state.selectedManualOrderIds = new Set();
        await loadManualOrders();
        await Promise.all([loadOverseasOrderProcessingOrders(), loadChinaOrderProcessingOrders()]);
        showToast(`已删除 ${Number(result?.deletedCount || 0)} 条手动订单记录`);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("amazonManualOrderForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "保存中...", async () => {
        await createAmazonManualOrder();
        await Promise.all([loadManualOrders(), loadAmazonOrders()]);
        await Promise.all([loadOverseasOrderProcessingOrders(), loadChinaOrderProcessingOrders()]);
        closeModal("amazonManualOrderModal");
        showToast("手动订单已生成");
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("orderEditForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "保存中...", async () => {
        const source = getOrderEditFieldValue("orderEditSource");
        await submitOrderEditForm();
        if (source === "amazon") {
          await loadAmazonOrders();
        } else if (source === "manual") {
          await loadManualOrders();
        } else {
          await loadOrders();
        }
        await Promise.all([loadOverseasOrderProcessingOrders(), loadChinaOrderProcessingOrders()]);
        closeModal("orderEditModal");
        showToast("订单已更新");
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  document.querySelectorAll("button[data-action='downloadAmazonShipmentConfirmation']").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const currentButton = event.currentTarget;
      try {
        await withBusyButton(currentButton, "下载中...", async () => {
          const fileName = await downloadAmazonShipmentConfirmationTxt(currentButton.dataset.days || "1");
          showToast(`已下载 ${fileName}`);
        });
      } catch (error) {
        showToast(error.message, true);
      }
    });
  });

  document.querySelectorAll("button[data-action='downloadRakutenShipmentConfirmation']").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const currentButton = event.currentTarget;
      try {
        await withBusyButton(currentButton, "下载中...", async () => {
          const fileName = await downloadRakutenShipmentConfirmationCsv(currentButton.dataset.days || "1");
          showToast(`已下载 ${fileName}`);
        });
      } catch (error) {
        showToast(error.message, true);
      }
    });
  });

  $("amazonOrdersSelectAll").addEventListener("change", (event) => {
    const checked = Boolean(event.target.checked);
    const selectableIds = state.amazonOrders.map((item) => String(item.id));
    state.selectedAmazonOrderIds = checked ? new Set(selectableIds) : new Set();
    renderAmazonOrdersTable();
  });

  $("manualOrdersSelectAll")?.addEventListener("change", (event) => {
    const checked = Boolean(event.target.checked);
    const selectableIds = state.manualOrders.map((item) => String(item.id));
    state.selectedManualOrderIds = checked ? new Set(selectableIds) : new Set();
    renderManualOrdersTable();
  });

  $("rakutenOrdersSelectAll").addEventListener("change", (event) => {
    const checked = Boolean(event.target.checked);
    const selectableIds = state.orders.map((item) => String(item.id));
    state.selectedRakutenOrderIds = checked ? new Set(selectableIds) : new Set();
    renderOrdersTable();
  });

  $("overseasOrderProcessingSelectAll").addEventListener("change", (event) => {
    const checked = Boolean(event.target.checked);
    const selectableKeys = state.overseasOrderProcessingOrders
      .filter((item) => item?.id)
      .map((item) => `${item.source}:${item.id}`);
    state.selectedOverseasOrderKeys = checked ? new Set(selectableKeys) : new Set();
    renderOverseasOrderProcessingTable();
  });

  $("openCreateUserModal")?.addEventListener("click", async () => {
    try {
      await loadUserOptions();
      $("createUserForm").reset();
      renderUserSelectOptions();
      openModal("createUserModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createUserForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "提交中...", async () => {
        const username = $("newUsername").value.trim();
        await request("/users", {
          method: "POST",
          body: JSON.stringify({
            username,
            department: $("newDepartment").value,
            role: $("newRole").value,
          }),
        });
        event.target.reset();
        closeModal("createUserModal");
        showToast("用户已新增，状态为禁用，请激活用户后登录");
        await Promise.all([loadUsers(), loadAudit()]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("editUserForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "保存中...", async () => {
        const userId = String($("editUserId").value || "").trim();
        if (!userId) {
          throw new Error("未选择用户");
        }

        const username = $("editUsername").value.trim();
        const role = $("editUserRole").value;
        const department = $("editUserDepartment").value;
        if (!username) {
          throw new Error("请输入用户名");
        }

        const payload = {
          username,
          department,
          role,
        };

        await request(`/users/${encodeURIComponent(userId)}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });

        closeModal("editUserModal");
        state.selectedEditUserId = null;
        showToast("用户信息已更新");
        await Promise.all([loadUsers(), loadAudit(), loadMe()]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("editUserToggleBtn").addEventListener("click", async () => {
    try {
      const userId = String($("editUserId").value || "").trim();
      if (!userId) {
        throw new Error("未选择用户");
      }
      const user = findUserById(userId);
      if (!user) {
        throw new Error("用户不存在");
      }
      const nextStatus = Number(user.status) === 1 ? 0 : 1;
      const changed = await toggleUserStatus(userId, String(user.username || ""), nextStatus);
      if (!changed) return;
      const latest = findUserById(userId);
      if (!latest) {
        closeModal("editUserModal");
        state.selectedEditUserId = null;
        return;
      }
      syncEditUserActionButtons(userId, latest.status, latest.username);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("editUserDeleteBtn").addEventListener("click", async () => {
    try {
      const userId = String($("editUserId").value || "").trim();
      if (!userId) {
        throw new Error("未选择用户");
      }
      const user = findUserById(userId);
      if (!user) {
        throw new Error("用户不存在");
      }
      const deleted = await removeUser(userId, String(user.username || ""));
      if (!deleted) return;
      closeModal("editUserModal");
      state.selectedEditUserId = null;
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("resetUserPasswordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "提交中...", async () => {
        const userId = String($("resetPasswordUserId").value || "").trim();
        if (!userId) {
          throw new Error("未选择用户");
        }
        const mode = String($("resetPasswordMode").value || "reset");
        const password = String($("resetPasswordNewPassword").value || "").trim();
        if (password.length < 6 || password.length > 64) {
          throw new Error("密码长度需为6到64位");
        }

        await request(`/users/${encodeURIComponent(userId)}/reset-password`, {
          method: "POST",
          body: JSON.stringify({ password }),
        });

        closeModal("resetUserPasswordModal");
        state.selectedResetPasswordUserId = null;
        showToast(mode === "activate" ? "用户已激活并设置新密码" : "密码已重置");
        await Promise.all([loadUsers(), loadAudit()]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createShelfForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "创建中...", async () => {
        const shelfCode = buildStrictShelfCode($("newShelfCodeDigits").value);
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
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createBoxForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "创建中...", async () => {
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
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("collectBatchInboundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "采集中...", async () => {
        await submitCollectBatchInboundForm();
        showToast("箱号采集完成，已创建批量入库单");
        await loadBatchInboundOrders();
        if (state.selectedBatchInboundOrderId) {
          await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId);
        }
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("uploadBatchInboundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "上传中...", async () => {
        await submitUploadBatchInboundForm();
        showToast("文档上传成功");
        await loadBatchInboundOrders();
        if (state.selectedBatchInboundOrderId) {
          await loadBatchInboundOrderDetail(state.selectedBatchInboundOrderId);
        }
        await loadInventory();
        await loadBoxes();
        await loadAudit();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("downloadBatchInboundTemplateBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "下载中...", async () => {
        await downloadBatchInboundTemplate();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("downloadSkuUploadTemplateBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "下载中...", async () => {
        await downloadSkuUploadTemplate();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("downloadInventoryUpdateTemplateBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "下载中...", async () => {
        await downloadInventoryUpdateTemplate();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("masterProductBackToListBtn").addEventListener("click", () => {
    setMasterProductView("syncRecords");
  });

  $("toggleMasterProductImportBtn").addEventListener("click", () => {
    $("masterProductImportForm")?.reset();
    openModal("masterProductImportModal");
  });

  $("toggleMasterProductExportBtn").addEventListener("click", async () => {
    try {
      await loadMasterProductExportFilterOptions();
      $("masterProductExportForm")?.classList.toggle("hidden");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("downloadMasterProductTemplateBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "下载中...", async () => {
        await downloadAuthorizedFile("/master-products/upload-template", {}, "产品列表.xlsx");
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("triggerMasterProductSyncBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      const daysText = window.prompt("输入要同步最近几天更新的主商品数据", "10");
      if (daysText === null) return;
      const days = Number(daysText);
      if (!Number.isInteger(days) || days <= 0) {
        throw new Error("同步天数必须是大于 0 的整数");
      }
      await withBusyButton(button, "同步中...", async () => {
        const result = await request(`/master-products/sync-xiya?days=${days}`, {
          method: "POST",
        });
        showToast(result?.message || `已启动同步任务，正在拉取最近 ${days} 天数据`);
        setMasterProductView("syncRecords");
        await loadMasterProductSyncRecords({ reset: true });
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("loadMoreMasterProductSyncRecordsBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "加载中...", async () => {
        await loadMasterProductSyncRecords({ reset: false });
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("masterProductImportForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      const file = $("masterProductImportFile").files?.[0];
      if (!file) {
        throw new Error("请选择主商品 Excel 文件");
      }
      await withBusyButton(submitButton, "更新中...", async () => {
        const formData = new FormData();
        formData.append("file", file);
        const result = await request("/master-products/import-excel", {
          method: "POST",
          body: formData,
        });
        showToast(
          `主商品更新完成：共 ${result?.importedCount || 0} 行，新增 ${result?.createdCount || 0} 行，更新 ${result?.updatedCount || 0} 行`,
        );
        $("masterProductImportForm").reset();
        closeModal("masterProductImportModal");
        setMasterProductView("syncRecords");
        await loadMasterProductSyncRecords({ reset: true });
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openCreateRakutenComboProductModal").addEventListener("click", () => {
    openCreateRakutenComboProductModal();
  });

  $("openBulkRakutenComboProductUploadModal").addEventListener("click", () => {
    $("bulkRakutenComboProductUploadForm")?.reset();
    openModal("bulkRakutenComboProductUploadModal");
  });

  $("refreshRakutenComboProducts").addEventListener("click", async () => {
    try {
      await loadRakutenComboProducts({ reset: true });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("rakutenComboProductSearchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      state.rakutenComboProductKeyword = String($("rakutenComboProductKeyword")?.value || "").trim();
      await loadRakutenComboProducts({ reset: true });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("resetRakutenComboProductKeywordBtn").addEventListener("click", async () => {
    try {
      state.rakutenComboProductKeyword = "";
      if ($("rakutenComboProductKeyword")) {
        $("rakutenComboProductKeyword").value = "";
      }
      await loadRakutenComboProducts({ reset: true });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("addRakutenComboProductItemBtn").addEventListener("click", () => {
    addRakutenComboProductDraftItem();
  });

  $("rakutenComboProductItems").addEventListener("input", (event) => {
    const input = event.target.closest(".rakuten-combo-product-id-input");
    if (!input) return;
    const index = Number(input.dataset.index);
    if (!Number.isInteger(index) || !state.rakutenComboProductDraftItems[index]) return;
    state.rakutenComboProductDraftItems[index].productId = String(input.value || "").trim();
    state.rakutenComboProductDraftItems[index].productName = "";
  });

  $("rakutenComboProductItems").addEventListener("change", (event) => {
    const input = event.target.closest(".rakuten-combo-product-id-input");
    if (!input) return;
    const index = Number(input.dataset.index);
    if (!Number.isInteger(index)) return;
    lookupRakutenComboProductDraftItem(index).catch((error) => showToast(error.message, true));
  });

  $("rakutenComboProductItems").addEventListener("click", (event) => {
    const removeBtn = event.target.closest("button[data-action='removeRakutenComboProductItem']");
    if (!removeBtn) return;
    const index = Number(removeBtn.dataset.index);
    if (!Number.isInteger(index)) return;
    removeRakutenComboProductDraftItem(index);
  });

  $("rakutenComboProductBody").addEventListener("click", (event) => {
    const editBtn = event.target.closest("button[data-action='editRakutenComboProduct']");
    if (!editBtn) return;
    openEditRakutenComboProductModal(editBtn.dataset.comboId);
  });

  $("createRakutenComboProductForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "保存中...", async () => {
        const payload = collectRakutenComboProductPayload();
        const isEditing = Boolean(payload.id);
        await request(isEditing ? `/rakuten-combo-products/${encodeURIComponent(payload.id)}` : "/rakuten-combo-products", {
          method: isEditing ? "PUT" : "POST",
          body: JSON.stringify(payload),
        });
        showToast(isEditing ? "组合产品已更新" : "组合产品已新增");
        closeModal("createRakutenComboProductModal");
        await loadRakutenComboProducts({ reset: true });
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("downloadRakutenComboProductTemplateBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "下载中...", async () => {
        await downloadAuthorizedFile(
          "/rakuten-combo-products/upload-template",
          {},
          "乐天组合产品上传模板.xlsx",
        );
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("bulkRakutenComboProductUploadForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      const file = $("bulkRakutenComboProductUploadFile").files?.[0];
      if (!file) {
        throw new Error("请选择组合产品 Excel 文件");
      }
      await withBusyButton(submitButton, "上传中...", async () => {
        const formData = new FormData();
        formData.append("file", file);
        const result = await request("/rakuten-combo-products/import-excel", {
          method: "POST",
          body: formData,
        });
        showToast(
          `组合产品上传完成：共 ${result?.importedCount || 0} 行，新增 ${result?.createdCount || 0} 行，更新 ${result?.updatedCount || 0} 行`,
        );
        $("bulkRakutenComboProductUploadForm").reset();
        closeModal("bulkRakutenComboProductUploadModal");
        await loadRakutenComboProducts({ reset: true });
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("masterProductExportForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "下载中...", async () => {
        const payload = buildMasterProductExportPayload();
        await downloadAuthorizedFile(
          "/master-products/export-excel",
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
          "产品主表分类下载.xlsx",
        );
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("resetMasterProductExportBtn").addEventListener("click", () => {
    resetMasterProductExportForm();
  });

  $("masterProductPrintSettingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      const productId = String(state.selectedMasterProductId || "").trim();
      if (!productId) {
        throw new Error("请先选择主商品");
      }
      const payload = {
        yamatoPrinterName: String($("masterProductYamatoPrinterName").value || "").trim() || undefined,
      };
      await withBusyButton(submitButton, "保存中...", async () => {
        await updateMasterProductPrintSettings(productId, payload);
        showToast("Yamato 打印设置已保存");
        await loadMasterProductDetail(productId);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("masterProductManualAdjustForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      const productId = String(state.selectedMasterProductId || "").trim();
      if (!productId) {
        throw new Error("请先选择主商品");
      }
      const payload = {
        boxCode: String($("masterProductAdjustBoxCode").value || "").trim(),
        qtyDelta: Number($("masterProductAdjustQtyDelta").value || 0),
        reason: String($("masterProductAdjustReason").value || "").trim() || undefined,
      };
      await withBusyButton(submitButton, "提交中...", async () => {
        await request(`/master-products/${encodeURIComponent(productId)}/box-inventories/manual-adjust`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        showToast("主商品入库完成");
        await Promise.all([loadMasterProductDetail(productId), loadInventory(), loadBoxes()]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("masterProductOutboundOneForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      const productId = String(state.selectedMasterProductId || "").trim();
      if (!productId) {
        throw new Error("请先选择主商品");
      }
      const payload = {
        boxCode: String($("masterProductOutboundBoxCode").value || "").trim(),
        remark: String($("masterProductOutboundRemark").value || "").trim() || undefined,
      };
      await withBusyButton(submitButton, "提交中...", async () => {
        await request(`/master-products/${encodeURIComponent(productId)}/box-inventories/outbound-one`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        showToast("主商品单件出库完成");
        await Promise.all([loadMasterProductDetail(productId), loadInventory(), loadBoxes()]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("masterProductFbaForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      const productId = String(state.selectedMasterProductId || "").trim();
      if (!productId) {
        throw new Error("请先选择主商品");
      }
      const skuId = Number($("masterProductFbaSkuId").value || 0);
      if (!Number.isInteger(skuId) || skuId <= 0) {
        throw new Error("请选择关联 SKU");
      }
      const payload = {
        skuId,
        boxCode: String($("masterProductFbaBoxCode").value || "").trim(),
        qty: Number($("masterProductFbaQty").value || 0),
        remark: String($("masterProductFbaRemark").value || "").trim() || undefined,
      };
      await withBusyButton(submitButton, "提交中...", async () => {
        await request(`/master-products/${encodeURIComponent(productId)}/fba-replenishments`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        showToast("主商品 FBA 补货申请已创建");
        await Promise.all([
          loadMasterProductDetail(productId),
          loadFbaReplenishments(),
          loadFbaPendingSummary(),
        ]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("inventorySearchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "检索中...", async () => {
        state.inventoryHomeKeyword = String($("inventoryKeyword").value || "").trim();
        state.inventoryHomeSelectedDetail = null;
        setInventoryDisplayMode(false);
        await loadInventoryHomeProducts({ reset: true });
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("resetInventoryKeywordBtn").addEventListener("click", async () => {
    try {
      $("inventoryKeyword").value = "";
      state.inventoryHomeKeyword = "";
      state.inventoryHomeSelectedDetail = null;
      setInventoryDisplayMode(false);
      await loadInventoryHomeProducts({ reset: true });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("skuManagementSearchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    state.skuManagementKeyword = String($("skuManagementKeyword").value || "").trim();
    state.skuManagementVisibleCount = state.inventoryListPageSize;
    renderSkuManagementTable();
  });

  $("resetSkuManagementKeywordBtn").addEventListener("click", () => {
    $("skuManagementKeyword").value = "";
    state.skuManagementKeyword = "";
    state.skuManagementVisibleCount = state.inventoryListPageSize;
    renderSkuManagementTable();
  });

  $("modalNewProductId").addEventListener("input", () => {
    syncSkuProductName("modalNewProductId", "modalNewProductName").catch(() => {});
  });
  $("modalNewProductId").addEventListener("blur", () => {
    syncSkuProductName("modalNewProductId", "modalNewProductName").catch(() => {});
  });
  $("editProductId").addEventListener("input", () => {
    syncSkuProductName("editProductId", "editProductName").catch(() => {});
  });
  $("editProductId").addEventListener("blur", () => {
    syncSkuProductName("editProductId", "editProductName").catch(() => {});
  });
  $("orderEditSku")?.addEventListener("input", () => {
    syncOrderEditProductMeta().catch(() => {});
  });
  $("orderEditSku")?.addEventListener("blur", () => {
    syncOrderEditProductMeta().catch(() => {});
  });
  $("orderEditResolvedProductId")?.addEventListener("input", () => {
    syncOrderEditProductNameFromProductId().catch(() => {});
  });
  $("orderEditResolvedProductId")?.addEventListener("blur", () => {
    syncOrderEditProductNameFromProductId().catch(() => {});
  });
  $("amazonManualProductId")?.addEventListener("input", () => {
    syncAmazonManualProductName().catch(() => {});
  });
  $("amazonManualProductId")?.addEventListener("blur", () => {
    syncAmazonManualProductName().catch(() => {});
  });

  $("backToInventoryListBtn").addEventListener("click", () => {
    state.inventoryHomeSelectedDetail = null;
    setInventoryDisplayMode(false);
  });

  $("openInventoryDetailInboundModal").addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      await loadBoxes();
      openInventoryDetailInboundModal();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("printInventoryDetailProductLabelBtn").addEventListener("click", (event) => {
    event.preventDefault();
    try {
      const productId = getSelectedInventoryDetailProductId();
      if (!productId) {
        throw new Error("当前没有可打印的产品ID");
      }
      openProductIdLabelWindow(productId);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("inventoryDetailInboundForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      const productId = getSelectedInventoryDetailProductId();
      await withBusyButton(submitButton, "提交中...", async () => {
        await submitInventoryDetailInbound();
        closeModal("inventoryDetailInboundModal");
        showToast("主商品入库完成");
        await Promise.all([
          loadInventory({ preserveSearch: true }),
          loadBoxes(),
          loadAudit(),
        ]);
        await loadInventoryHomeProductDetail(productId);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("inventoryDetailFbaForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      const productId = getSelectedInventoryDetailProductId();
      await withBusyButton(submitButton, "提交中...", async () => {
        await submitInventoryDetailFba();
        closeModal("inventoryDetailFbaModal");
        showToast("FBA 补货申请已创建");
        await Promise.all([
          loadInventory({ preserveSearch: true }),
          loadBoxes(),
          loadAudit(),
          loadFbaReplenishments(),
        ]);
        await loadInventoryHomeProductDetail(productId);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("downloadStockAdjustmentCsvBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "生成中...", async () => {
        await downloadStockAdjustmentCsv();
      });
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

  $("openDataBackupPanel").addEventListener("click", async () => {
    try {
      switchPanel("dataBackup");
      await loadDataBackups();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openSystemDashboardPanel").addEventListener("click", async () => {
    try {
      switchPanel("overview");
      await loadOverviewDashboard();
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

  $("downloadFbaOutboundExcelBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "下载中...", async () => {
        await downloadFbaOutboundExcel();
      });
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
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "处理中...", async () => {
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
        const selectedRows = state.fbaReplenishments.filter((item) =>
          ids.includes(Number(item?.id)),
        );
        const blockedRow = selectedRows.find((item) =>
          hasPendingProductEditRequestBySkuId(Number(item?.sku?.id)),
        );
        if (blockedRow) {
          throw new Error(SKU_EDIT_PENDING_BLOCK_MESSAGE);
        }

        await outboundFbaReplenishmentRequests(ids, expressNo);
        closeModal("fbaOutboundModal");
        state.selectedFbaIds = new Set();
        showToast("出库完成");
        const keyword = $("inventoryKeyword").value.trim();
        const shouldRefreshSearch = state.inventorySearchMode && Boolean(keyword);
        await loadFbaReplenishments();
        await loadFbaPendingSummary();
        await loadInventory({ preserveSearch: shouldRefreshSearch });
        await loadBoxes();
        if (shouldRefreshSearch) {
          await searchInventoryProducts(keyword);
        }
        await loadAudit();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openInventoryHome").addEventListener("click", async () => {
    try {
      await openInventoryHomeDefault({ markAsUserNavigation: true });
    } catch (error) {
      showToast(error.message, true);
    }
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
      await openProductManagementPanelView();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openMasterProductManagementPanel").addEventListener("click", async () => {
    try {
      switchPanel("masterProductManagement");
      setMasterProductView("syncRecords");
      await Promise.all([
        loadShelves(),
        loadBoxes(),
        loadInventory(),
        loadMasterProductSyncRecords({ reset: true }),
      ]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openRakutenComboProductManagementPanel").addEventListener("click", async () => {
    try {
      switchPanel("rakutenComboProductManagement");
      await loadRakutenComboProducts({ reset: true });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openSkuManagementPanel").addEventListener("click", async () => {
    try {
      switchPanel("skuManagement");
      await loadInventory({ preserveSearch: true });
      renderSkuManagementTable();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("backToProductManagementFromSku").addEventListener("click", async () => {
    try {
      await navigateToProductManagement();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("backToProductManagementFromMasterProduct").addEventListener("click", async () => {
    try {
      await navigateToProductManagement();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("backToProductManagementFromRakutenComboProduct").addEventListener("click", async () => {
    try {
      await navigateToProductManagement();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openOrderProcessingPanel").addEventListener("click", async () => {
    try {
      switchPanel("orderProcessing");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openAmazonOrderImportPanel").addEventListener("click", async () => {
    try {
      switchPanel("amazonOrderImport");
      await loadAmazonOrders();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openManualOrderProcessingPanel")?.addEventListener("click", async () => {
    try {
      switchPanel("manualOrderProcessing");
      await loadManualOrders();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openRakutenOrderImportPanel").addEventListener("click", async () => {
    try {
      switchPanel("rakutenOrderImport");
      await loadOrders();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openOverseasOrderProcessingPanel")?.addEventListener("click", async () => {
    try {
      switchPanel("overseasOrderProcessing");
      await loadOverseasOrderProcessingOrders();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openChinaOrderProcessingPanel")?.addEventListener("click", async () => {
    try {
      switchPanel("chinaOrderProcessing");
      await loadChinaOrderProcessingOrders();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("refreshChinaOrderProcessing")?.addEventListener("click", () =>
    Promise.all([loadChinaOrderProcessingOrders()])
      .catch((error) => showToast(error.message, true)),
  );

  $("syncXiyaTrackingNumbers")?.addEventListener("click", (event) =>
    withBusyButton(event.currentTarget, "同步中...", async () => {
      try {
        const result = await request("/orders/china-orders/sync-xiya-tracking", { method: "POST" });
        await Promise.all([
          loadChinaOrderProcessingOrders(),
          loadOrders(),
          loadAmazonOrders(),
          loadManualOrders(),
          loadOverseasOrderProcessingOrders(),
        ]);
        showToast(
          `已同步 Xiya 运单号：乐天 ${Number(result?.rakutenUpdatedCount || 0)} 条，亚马逊 ${Number(
            result?.amazonUpdatedCount || 0,
          )} 条，手动订单 ${Number(result?.manualUpdatedCount || 0)} 条，未匹配 ${Number(
            result?.skippedUnmatchedCount || 0,
          )} 条。`,
        );
      } catch (error) {
        showToast(error.message, true);
      }
    }),
  );

  $("openOverseasPickingBatchManagementBtn")?.addEventListener("click", async () => {
    try {
      state.overseasPickingBatchView = "list";
      switchPanel("overseasPickingBatchManagement");
      await Promise.all([loadOverseasPickingBatches(), loadYamatoShipmentBatches()]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("backToOverseasPickingBatchListBtn")?.addEventListener("click", async () => {
    try {
      state.overseasPickingBatchView = "list";
      renderOverseasPickingBatchControls();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("backToOverseasOrderProcessingBtn")?.addEventListener("click", async () => {
    try {
      state.overseasPickingBatchView = "list";
      switchPanel("overseasOrderProcessing");
      await loadOverseasOrderProcessingOrders();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("backToOrderProcessingFromChinaBtn")?.addEventListener("click", async () => {
    try {
      switchPanel("orderProcessing");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("overseasUploadYamatoPdfBtn")?.addEventListener("click", () => {
    const input = $("overseasYamatoPdfFile");
    if (!input) return;
    input.value = "";
    input.click();
  });

  $("overseasYamatoPdfFile")?.addEventListener("change", async (event) => {
    const input = event.currentTarget;
    const files = Array.from(input?.files || []);
    if (!files.length) return;
    const batch = getSelectedYamatoShipmentBatch();
    if (!batch) {
      showToast("当前拣货批次还没有生成 Yamato 批次", true);
      input.value = "";
      return;
    }
    const button = $("overseasUploadYamatoPdfBtn");
    const fileCountText = files.length > 1 ? `${files.length} 个 Yamato PDF` : "Yamato PDF";
    try {
      await withGlobalLoading(`读取中，正在上传并解析 ${fileCountText}...`, () =>
        withBusyButton(button, "上传解析中...", async () => {
          await uploadYamatoShipmentBatchPdf(batch.id, files);
          await Promise.all([loadYamatoShipmentBatches(), loadOverseasPickingBatches()]);
          if (state.selectedOverseasPickingBatchId) {
            await loadOverseasPickingBatchDetail(state.selectedOverseasPickingBatchId);
          }
          state.selectedYamatoShipmentBatchId = batch.id;
          renderYamatoShipmentBatchControls();
        }),
      );
      focusOverseasYamatoScanInput();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      input.value = "";
    }
  });

  $("overseasYamatoScanSubmitBtn")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    let popup = null;
    try {
      const scanRequest = getOverseasYamatoScanRequest();
      if (normalizeYamatoPrintConfig(state.yamatoPrintConfig).mode === "browser") {
        popup = openYamatoPrintPlaceholderWindow(
          `Yamato 面单 ${scanRequest.rawValue}`,
        );
      }
      await withBusyButton(button, "出单中...", async () => {
        await submitOverseasYamatoScan({ popup, scanRequest });
      });
    } catch (error) {
      if (popup && !popup.closed) {
        try {
          popup.close();
        } catch (_) {}
      }
      showToast(error.message, true);
      focusOverseasYamatoScanInput();
    }
  });

  $("overseasYamatoScanInput")?.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const button = $("overseasYamatoScanSubmitBtn");
    let popup = null;
    try {
      const scanRequest = getOverseasYamatoScanRequest();
      if (normalizeYamatoPrintConfig(state.yamatoPrintConfig).mode === "browser") {
        popup = openYamatoPrintPlaceholderWindow(
          `Yamato 面单 ${scanRequest.rawValue}`,
        );
      }
      await withBusyButton(button, "出单中...", async () => {
        await submitOverseasYamatoScan({ popup, scanRequest });
      });
    } catch (error) {
      if (popup && !popup.closed) {
        try {
          popup.close();
        } catch (_) {}
      }
      showToast(error.message, true);
      focusOverseasYamatoScanInput();
    }
  });

  $("backToOrderProcessingFromOverseasBtn")?.addEventListener("click", () => {
    switchPanel("orderProcessing");
  });

  $("openRakutenOrderImportModal").addEventListener("click", () => {
    openModal("rakutenOrderImportModal");
  });

  $("closeRakutenOrderImportModal").addEventListener("click", () => {
    closeModal("rakutenOrderImportModal");
  });

  $("cancelRakutenOrderImportModal").addEventListener("click", () => {
    closeModal("rakutenOrderImportModal");
  });

  $("backToOrderProcessingFromRakutenBtn").addEventListener("click", () => {
    switchPanel("orderProcessing");
  });

  $("openAmazonOrderImportModal").addEventListener("click", () => {
    openModal("amazonOrderImportModal");
  });

  $("openAmazonManualOrderModal")?.addEventListener("click", () => {
    openAmazonManualOrderModal();
  });

  $("closeAmazonOrderImportModal").addEventListener("click", () => {
    closeModal("amazonOrderImportModal");
  });

  $("cancelAmazonOrderImportModal").addEventListener("click", () => {
    closeModal("amazonOrderImportModal");
  });

  $("backToOrderProcessingBtn").addEventListener("click", () => {
    switchPanel("orderProcessing");
  });

  $("backToOrderProcessingFromManualBtn")?.addEventListener("click", () => {
    switchPanel("orderProcessing");
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

  $("openShelfManageModal").addEventListener("click", async () => {
    try {
      state.shelfEditingIds = new Set();
      resetShelfManageVisibleCount();
      await loadShelves();
      const wrap = $("shelfManageTableWrap");
      if (wrap) {
        wrap.scrollTop = 0;
      }
      openModal("shelfManageModal");
      setupShelfManageLoadObserver();
      maybeAutoLoadShelvesManage();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openStocktakePlannerPanel").addEventListener("click", async () => {
    try {
      await Promise.all([loadShelves(), loadBoxes(), loadStocktakeTasks()]);
      state.stocktakeVisibleCount = Math.min(state.inventoryPageSize, state.stocktakeTasks.length);
      renderStocktakePlanner();
      switchPanel("stocktakePlanner");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("backToOverseasWarehouseBtn").addEventListener("click", () => {
    switchPanel("overseasWarehouse");
  });

  $("regenerateStocktakeTasksBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "生成中...", async () => {
        await generateStocktakeTasks();
        renderStocktakePlanner();
        showToast("已生成 1 条库存盘点任务");
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });


  $("printStocktakeTaskDetailBtn").addEventListener("click", () => {
    try {
      openStocktakePrintWindow(state.selectedStocktakeTask, state.selectedStocktakeTaskRows);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openBoxManageModal").addEventListener("click", async () => {
    try {
      state.boxEditingIds = new Set();
      resetBoxManageVisibleCount();
      openModal("boxManageModal");
      const wrap = $("boxManageTableWrap");
      if (wrap) {
        wrap.scrollTop = 0;
      }
      await Promise.all([loadShelves(), loadBoxManagePage({ reset: true })]);
      setupBoxManageLoadObserver();
      maybeAutoLoadBoxesManage();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openBoxContentQueryModal").addEventListener("click", async () => {
    try {
      await Promise.all([loadShelves(), loadBoxes()]);
      setQueryModalDirectResultMode("box", false);
      $("boxContentQueryForm")?.reset();
      resetBoxContentQueryResult();
      openModal("boxContentQueryModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openShelfBoxQueryModal").addEventListener("click", async () => {
    try {
      await Promise.all([loadShelves(), loadBoxes()]);
      setQueryModalDirectResultMode("shelf", false);
      $("shelfBoxQueryForm")?.reset();
      resetShelfBoxQueryResult();
      openModal("shelfBoxQueryModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("printShelfBoxQueryLabelsBtn")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "打印中...", async () => {
        openBatchProductIdLabelWindow(
          state.selectedShelfBoxQueryRows,
          state.selectedShelfBoxQueryShelfCode,
        );
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openDepartmentManageModal").addEventListener("click", async () => {
    try {
      state.departmentOptionEditingCodes = new Set();
      await loadUserOptions();
      $("departmentOptionCreateForm")?.reset();
      renderDepartmentOptionCreateForm();
      openModal("departmentManageModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("openCreateSkuModal").addEventListener("click", async () => {
    await loadShops().catch((error) =>
      showToast(error.message, true),
    );
    $("createSkuModalForm").reset();
    $("modalNewProductName").value = "";
    renderShopOptionsForSelect("modalNewShop", "请选择店铺");
    openModal("createSkuModal");
  });

  $("openBulkSkuUploadModal").addEventListener("click", () => {
    $("bulkSkuUploadForm").reset();
    openModal("bulkSkuUploadModal");
  });

  $("openBulkInventoryUpdateModal").addEventListener("click", () => {
    $("bulkInventoryUpdateForm").reset();
    openModal("bulkInventoryUpdateModal");
  });

  $("openEmptyBoxManageModal")?.addEventListener("click", async () => {
    try {
      await loadEmptyBoxes();
      const wrap = $("emptyBoxManageTableWrap");
      if (wrap) {
        wrap.scrollTop = 0;
      }
      openModal("emptyBoxManageModal");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  const openCreateBoxModal = async (prefill = null) => {
    if (!state.shelves.length) {
      await loadShelves().catch((error) => showToast(error.message, true));
    }
    $("createBoxFromSkuForm").reset();
    const prefillBoxCode = String(prefill?.boxCode || "").trim();
    const prefillShelfId = Number(prefill?.shelfId);
    if (prefillBoxCode) {
      $("modalNewBoxCodeDigits").value = prefillBoxCode.replace(/\D/g, "").slice(-3);
    }
    if (Number.isInteger(prefillShelfId) && prefillShelfId > 0) {
      $("modalNewBoxShelfId").value = String(prefillShelfId);
    }
    openModal("createBoxFromSkuModal");
  };

  const openCreateShelfModal = async (prefill = null) => {
    $("createShelfFromInventoryForm").reset();
    const prefillShelfCode = String(prefill?.shelfCode || "").trim();
    const prefillShelfName = String(prefill?.name || "").trim();
    if (prefillShelfCode) {
      $("modalNewShelfCodeDigits").value = prefillShelfCode;
    }
    if (prefillShelfName) {
      $("modalNewShelfName").value = prefillShelfName;
    }
    openModal("createShelfFromInventoryModal");
  };

  $("openCreateBoxFromAdjust").addEventListener("click", openCreateBoxModal);
  $("openCreateBoxFromManage").addEventListener("click", async () => {
    try {
      await openCreateBoxModal();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("openCreateShelfFromManage").addEventListener("click", async () => {
    try {
      await openCreateShelfModal();
    } catch (error) {
      showToast(error.message, true);
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
      const matched = getEnabledShelvesSorted().find(
        (item) => normalizeShelfCodeInput(item?.shelfCode) === normalizeShelfCodeInput(resolved),
      );
      event.target.value = formatShelfCodeWithName(matched || { shelfCode: resolved });
    }
  });
  const moveProductProductControl = $("moveProductProductId");
  moveProductProductControl.addEventListener("change", async () => {
    try {
      await refreshMoveProductOldBoxOptionsByProduct();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  if (String(moveProductProductControl.tagName || "").toUpperCase() !== "SELECT") {
    moveProductProductControl.addEventListener("input", async () => {
      try {
        await refreshMoveProductOldBoxOptionsByProduct();
      } catch (error) {
        showToast(error.message, true);
      }
    });
    moveProductProductControl.addEventListener("focus", () => {
      renderMasterProductOptionsForInput("moveProductProductId", "moveProductProductIdList");
    });
    moveProductProductControl.addEventListener("blur", async (event) => {
      const raw = String(event.target?.value || "").trim();
      if (raw) {
        const matched = getKnownMasterProductsSorted().find(
          (item) => String(item?.productId || "").trim().toUpperCase() === raw.toUpperCase(),
        );
        if (matched?.productId) {
          event.target.value = matched.productId;
        }
      }
      try {
        await refreshMoveProductOldBoxOptionsByProduct();
      } catch (error) {
        showToast(error.message, true);
      }
    });
  }
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
    clearTimeout(adjustBoxValidationTimer);
    adjustBoxValidationTimer = setTimeout(() => {
      validateAdjustBoxInput(event.target.value).catch(() => {});
    }, 250);
  });
  $("adjustBoxCode").addEventListener("focus", (event) => {
    renderAdjustBoxSuggestions(event.target.value);
  });
  $("adjustBoxCode").addEventListener("blur", (event) => {
    clearTimeout(adjustBoxValidationTimer);
    validateAdjustBoxInput(event.target.value, { normalizeInput: true }).catch(() => {});
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
  $("inventoryDetailInboundBoxCode").addEventListener("input", (event) => {
    if (event.target.readOnly) return;
    renderInventoryDetailInboundBoxSuggestions(event.target.value);
    clearTimeout(inventoryDetailInboundBoxValidationTimer);
    inventoryDetailInboundBoxValidationTimer = setTimeout(() => {
      validateInventoryDetailInboundBoxInput(event.target.value).catch(() => {});
    }, 250);
  });
  $("inventoryDetailInboundBoxCode").addEventListener("focus", (event) => {
    if (event.target.readOnly) return;
    renderInventoryDetailInboundBoxSuggestions(event.target.value);
  });
  $("inventoryDetailInboundBoxCode").addEventListener("blur", (event) => {
    if (event.target.readOnly) return;
    clearTimeout(inventoryDetailInboundBoxValidationTimer);
    validateInventoryDetailInboundBoxInput(event.target.value, { normalizeInput: true }).catch(() => {});
  });
  $("inventoryDetailInboundQty").addEventListener("input", (event) => {
    const input = event.target;
    let digits = String(input.value || "").replace(/\D/g, "").replace(/^0+/, "");
    input.value = digits ? String(Number(digits)) : "";
  });
  $("inventoryDetailInboundQty").addEventListener("blur", (event) => {
    const input = event.target;
    if (!String(input.value || "").trim()) {
      input.value = "1";
    }
  });
  $("inventoryDetailFbaQty").addEventListener("input", (event) => {
    const input = event.target;
    let digits = String(input.value || "").replace(/\D/g, "").replace(/^0+/, "");
    input.value = digits ? String(Number(digits)) : "";
  });
  $("inventoryDetailFbaQty").addEventListener("blur", (event) => {
    const input = event.target;
    if (!String(input.value || "").trim()) {
      input.value = "1";
    }
  });
  $("openCreateBoxFromInventoryDetailInbound").addEventListener("click", openCreateBoxModal);

  $("createSkuModalForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "提交中...", async () => {
        await createSkuFromModal();
        closeModal("createSkuModal");
        showToast("SKU 已创建");
        await loadInventory();
        await loadAudit();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("bulkSkuUploadForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "上传中...", async () => {
        const file = $("bulkSkuUploadFile").files?.[0];
        const result = await importSkusFromExcel(file);
        closeModal("bulkSkuUploadModal");
        showToast(
          `上传完成：共${result.totalRows}行，新增${result.createdCount}条，生成编辑申请${result.editRequestCount}条`,
        );
        await Promise.all([
          loadInventory(),
          loadProductEditRequests({ reset: true }),
          loadProductEditPendingSummary(),
          loadAudit(),
        ]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("bulkInventoryUpdateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "上传中...", async () => {
        const file = $("bulkInventoryUpdateFile").files?.[0];
        const result = await importBulkInventoryUpdateFromExcel(file);
        closeModal("bulkInventoryUpdateModal");
        showToast(
          `上传完成：共${result.totalRows}行，调整SKU${result.changedSkuCount}个，库存变更明细${result.changedItemCount}条`,
        );
        await Promise.all([loadInventory(), loadAudit(), loadOverviewDashboard()]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createBoxFromSkuForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "创建中...", async () => {
        const createdBoxCode = await createBoxFromSkuModal();
        closeModal("createBoxFromSkuModal");
        showToast("箱号已创建");
        await loadShelves();
        await loadBoxes();
        const adjustModal = $("adjustModal");
        if (adjustModal && !adjustModal.classList.contains("hidden")) {
          $("adjustBoxCode").value = createdBoxCode;
          renderAdjustBoxSuggestions(createdBoxCode);
        }
        const inventoryDetailInboundModal = $("inventoryDetailInboundModal");
        if (inventoryDetailInboundModal && !inventoryDetailInboundModal.classList.contains("hidden")) {
          const input = $("inventoryDetailInboundBoxCode");
          if (input && !input.readOnly) {
            input.value = createdBoxCode;
            renderInventoryDetailInboundBoxSuggestions(createdBoxCode);
            $("inventoryDetailInboundBoxHint")?.classList.add("hidden");
          }
        }
        await loadAudit();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("createShelfFromInventoryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "创建中...", async () => {
        await createShelfFromInventoryModal();
        closeModal("createShelfFromInventoryModal");
        showToast("货架已创建");
        await loadShelves();
        await loadAudit();
      });
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
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "保存中...", async () => {
        const currentPassword = $("profileCurrentPassword").value;
        const newPassword = $("profileNewPassword").value;
        await request("/auth/me/password", {
          method: "POST",
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        closeModal("profileModal");
        showToast("密码已更新");
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("editSkuForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "提交中...", async () => {
        await submitEditSkuForm();
        closeModal("editSkuModal");
        showToast("编辑申请已提交");
        await Promise.all([loadProductEditRequests({ reset: true }), loadProductEditPendingSummary()]);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("adjustForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "处理中...", async () => {
        const keyword = $("inventoryKeyword").value.trim();
        const shouldRefreshSearch = state.inventorySearchMode && Boolean(keyword);
        const direction = $("adjustDirection").value;
        await submitAdjustForm();
        closeModal("adjustModal");
        showToast(direction === "outbound" ? "FBA补货申请单已生成" : "入库成功");
        await loadInventory({ preserveSearch: shouldRefreshSearch });
        await loadBoxes();
        await loadFbaReplenishments();
        await loadAudit();
        if (shouldRefreshSearch) {
          await searchInventoryProducts(keyword);
        }
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("boxContentQueryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "查询中...", async () => {
        await Promise.all([loadShelves(), loadBoxes()]);
        const rawBoxCode = $("boxContentQueryBoxCode").value;
        const normalizedBoxCode = normalizeBoxCodeInput(rawBoxCode);
        const box = findBoxByAnyCode(rawBoxCode);
        if (!box) {
          renderBoxContentQueryNotFound(normalizedBoxCode || String(rawBoxCode || "").trim());
          return;
        }
        const rows = await getBoxSkuInventoryRows(box.id);
        renderBoxContentQueryResult(box, rows);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("shelfBoxQueryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = getSubmitButton(event.currentTarget, event);
    try {
      await withBusyButton(submitButton, "查询中...", async () => {
        await Promise.all([loadShelves(), loadBoxes()]);
        const rawShelfCode = $("shelfBoxQueryShelfCode").value;
        const normalizedShelfCode = normalizeShelfCodeInput(rawShelfCode);
        const shelf = findShelfByAnyCode(rawShelfCode);
        if (!shelf) {
          renderShelfBoxQueryNotFound(normalizedShelfCode || String(rawShelfCode || "").trim());
          return;
        }
        const { boxCount, rows } = await getShelfBoxQueryRows(shelf);
        renderShelfBoxQueryResult(shelf, rows, boxCount);
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

function bindDelegates() {
  if (!document.body.dataset.printAgentExeDownloadBound) {
    document.body.dataset.printAgentExeDownloadBound = "true";
    document.body.addEventListener("click", async (event) => {
      const button = event.target.closest("#downloadPrintAgentExeBtn");
      if (!button) return;
      try {
        await withBusyButton(button, "生成中...", async () => {
          await downloadPrintAgentWindowsExe();
        });
      } catch (error) {
        showToast(error.message, true);
      }
    });
  }
  if (!document.body.dataset.bossMappingDownloadBound) {
    document.body.dataset.bossMappingDownloadBound = "true";
    document.body.addEventListener("click", async (event) => {
      const button = event.target.closest("#downloadBossMappingCsvBtn");
      if (!button) return;
      try {
        await withBusyButton(button, "下载中...", async () => {
          await downloadBossMappingCsv();
        });
      } catch (error) {
        showToast(error.message, true);
        }
      });
  }
  if (!document.body.dataset.bossNewItemDownloadBound) {
    document.body.dataset.bossNewItemDownloadBound = "true";
    document.body.addEventListener("click", async (event) => {
      const button = event.target.closest("#downloadBossNewItemZipBtn");
      if (!button) return;
      try {
        await withBusyButton(button, "下载中...", async () => {
          await downloadBossNewItemZip();
        });
      } catch (error) {
        showToast(error.message, true);
      }
    });
  }
  $("stocktakePlannerBody")?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    try {
      if (button.dataset.action === "printStocktakeTask") {
        await printStocktakeTask(button.dataset.id || "");
        return;
      }
      if (button.dataset.action === "confirmStocktakeTask") {
        const ok = await openActionConfirmModal("确认将该盘点任务标记为已确认？", "确认操作", "确认");
        if (!ok) return;
        await confirmStocktakeTask(button.dataset.id || "");
        renderStocktakePlanner();
        showToast("盘点任务已确认");
        return;
      }
      if (button.dataset.action === "cancelStocktakeTask") {
        const ok = await openActionConfirmModal("确认删除该盘点任务？删除后状态将变为已取消。", "确认操作", "确认删除");
        if (!ok) return;
        await cancelStocktakeTask(button.dataset.id || "");
        renderStocktakePlanner();
        showToast("盘点任务已取消");
        return;
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("brandsBody")?.addEventListener("click", async (event) => {
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

  $("skuTypesBody")?.addEventListener("click", async (event) => {
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

  $("brandForm")?.addEventListener("submit", async (event) => {
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

  $("skuTypeForm")?.addEventListener("submit", async (event) => {
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

  $("departmentOptionCreateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const name = String($("departmentOptionCreateName")?.value || "").trim();
      if (!name) {
        throw new Error("\u8bf7\u8f93\u5165\u90e8\u95e8\u540d\u79f0");
      }
      const payload = { name };

      await request("/user-options/departments", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      $("departmentOptionCreateForm")?.reset();
      showToast("\u90e8\u95e8\u65b0\u589e\u6210\u529f");
      await Promise.all([loadUserOptions(), loadUsers(), loadAudit()]);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("shelfManageBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (!id) return;
    try {
      if (action === "queryShelfManage") {
        await openShelfBoxQueryModalForShelfCode(button.dataset.code || id, id);
      } else if (action === "editShelfManage") {
        const codeInput = $(`shelfCodeManage-${id}`);
        const nameInput = $(`shelfNameManage-${id}`);
        if (!codeInput || !nameInput) return;
        const isEditing = state.shelfEditingIds.has(String(id));
        if (!isEditing) {
          state.shelfEditingIds.add(String(id));
          renderShelvesManageTable();
          const focusInput = $(`shelfCodeManage-${id}`);
          if (focusInput) {
            focusInput.focus();
            focusInput.select?.();
          }
          return;
        }

        const originalCode = String(codeInput.getAttribute("data-original-code") || "").trim();
        const originalName = String(nameInput.getAttribute("data-original-name") || "").trim();
        const rawCode = String(codeInput.value || "").trim();
        if (!rawCode) {
          throw new Error("请输入货架号");
        }
        const normalizedCode = normalizeShelfCodeInput(rawCode);
        if (!normalizedCode) {
          throw new Error("货架号格式无效");
        }
        const codeChanged = normalizedCode !== originalCode;
        if (codeChanged && !/^(?:00|[A-Z][0-9])$/.test(normalizedCode)) {
          throw new Error("货架号必须是00或A0格式");
        }

        const name = String(nameInput.value || "").trim();
        const nameChanged = name !== originalName;
        if (nameChanged && !name && originalName) {
          throw new Error("货架名称不能为空");
        }
        if (!codeChanged && !nameChanged) {
          state.shelfEditingIds.delete(String(id));
          renderShelvesManageTable();
          return;
        }

        const payload = {};
        if (codeChanged) payload.shelfCode = normalizedCode;
        if (nameChanged && name) payload.name = name;

        await request(`/shelves/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        state.shelfEditingIds.delete(String(id));
        showToast("货架已变更");
        await Promise.all([loadShelves(), loadBoxes(), loadInventory(), loadAudit()]);
      } else if (action === "deleteShelfManage") {
        const shelfCode = button.dataset.code || id;
        const deleteCheck = await request(`/shelves/${id}/delete-check`);
        if (!deleteCheck?.canDelete) {
          showToast(buildDeleteBlockedMessage("货架", deleteCheck?.reasons), true);
          return;
        }
        const ok = await openActionConfirmModal(
          `确认删除货架 ${shelfCode} ？`,
          "确认操作",
          "确认删除",
        );
        if (!ok) return;
        await request(`/shelves/${id}`, { method: "DELETE" });
        state.shelfEditingIds.delete(String(id));
        showToast("货架已删除");
        await Promise.all([loadShelves(), loadBoxes(), loadInventory(), loadAudit()]);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("boxManageBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (!id) return;
    try {
      if (action === "queryBoxManage") {
        await openBoxContentQueryModalForBoxCode(button.dataset.code || id, id);
      } else if (action === "archiveReleaseBoxManage") {
        await archiveReleaseBox(id, button.dataset.code || id);
      } else if (action === "editBoxManage") {
        const codeInput = $(`boxCodeManage-${id}`);
        const shelfSelect = $(`boxShelfManage-${id}`);
        if (!codeInput || !shelfSelect) return;
        const isEditing = state.boxEditingIds.has(String(id));
        if (!isEditing) {
          state.boxEditingIds.add(String(id));
          renderBoxesManageTable();
          const focusInput = $(`boxCodeManage-${id}`);
          if (focusInput) {
            focusInput.focus();
            focusInput.select?.();
          }
          return;
        }

        const originalCode = String(codeInput.getAttribute("data-original-code") || "").trim();
        const rawCode = String(codeInput.value || "").trim();
        if (!rawCode) {
          throw new Error("请输入箱号");
        }
        const normalizedCode = normalizeBoxCodeInput(rawCode);
        if (!normalizedCode) {
          throw new Error("箱号格式无效");
        }
        const codeChanged = normalizedCode !== originalCode;
        if (codeChanged && !/^\d{3}$/.test(normalizedCode)) {
          throw new Error("箱号必须是3位数字");
        }

        const shelfId = Number(shelfSelect.value);
        if (!Number.isInteger(shelfId) || shelfId <= 0) {
          throw new Error("请选择货架号");
        }
        const originalShelfId = Number(String(shelfSelect.getAttribute("data-original-shelf-id") || "0"));
        const shelfChanged = shelfId !== originalShelfId;
        if (!codeChanged && !shelfChanged) {
          state.boxEditingIds.delete(String(id));
          renderBoxesManageTable();
          return;
        }

        const payload = {};
        if (codeChanged) payload.boxCode = normalizedCode;
        if (shelfChanged) payload.shelfId = shelfId;

        await request(`/boxes/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        state.boxEditingIds.delete(String(id));
        showToast("箱号已变更");
        await reloadBoxesAfterManageMutation();
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("boxContentQueryBody")?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = String(button.dataset.action || "");
    const id = String(button.dataset.id || "").trim();
    if (!id) return;

    try {
      if (action === "archiveReleaseBoxQuery") {
        const boxCode = button.dataset.code || id;
        const result = await archiveReleaseBox(id, boxCode);
        if (!result) return;
        await openBoxContentQueryModalForBoxCode(result?.releasedBoxCode || boxCode);
      } else if (action === "editBoxQuery") {
        closeModal("boxContentQueryModal");
        await openBoxManageModalForEdit(id);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("emptyBoxManageBody")?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='deleteEmptyBox']");
    if (!button) return;
    const id = button.dataset.id;
    if (!id) return;
    const boxCode = button.dataset.code || id;
    try {
      const ok = await openActionConfirmModal(
        `确认废除空箱 ${boxCode} 吗？`,
        "确认操作",
        "确认废除",
      );
      if (!ok) return;
      await request(`/boxes/${id}`, { method: "DELETE" });
      showToast("空箱已废除");
      await Promise.all([loadShelves(), loadBoxes(), loadInventory(), loadAudit()]);
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
        "确认执行“移动主商品到新箱子”？",
        "确认操作",
        "确认",
      );
      if (!confirmed) return;
      const result = await submitMoveBoxCodeForm();
      showToast(`已将${result.qty}件主商品从 ${result.oldBoxCode} 移动到 ${result.newBoxCode}`);
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
      if (action === "fbaOpenMasterProductDetail") {
        const productId = String(button.dataset.productId || "").trim();
        if (!productId) return;
        const detail = await request(`/master-products/${encodeURIComponent(productId)}/detail`);
        switchPanel("inventory");
        renderInventoryHomeDetail(detail);
        setInventoryDisplayMode(true);
        return;
      }

      const id = Number(button.dataset.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error("申请单ID无效");
      }

      if (action === "fbaConfirmRow") {
        const row = state.fbaReplenishments.find((item) => Number(item?.id) === id);
        if (row && hasPendingProductEditRequestBySkuId(Number(row?.sku?.id))) {
          throw new Error(SKU_EDIT_PENDING_BLOCK_MESSAGE);
        }
        const inputId = button.dataset.inputId || "";
        const input = $(inputId);
        const actualQty = Number(String(input?.value || "").trim());
        if (!Number.isInteger(actualQty) || actualQty <= 0) {
          throw new Error("实际数量必须是大于0的整数");
        }
        await confirmFbaReplenishmentRequest(id, actualQty);
        showToast("已转为待出库", false, {
          labelData: {
            fnsku: row?.sku?.fnsku || "",
            qty: actualQty,
            sku: row?.sku?.sku || "",
          },
        });
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

      const keyword = $("inventoryKeyword").value.trim();
      const shouldRefreshSearch = state.inventorySearchMode && Boolean(keyword);
      state.selectedFbaIds.delete(String(id));
      await loadFbaReplenishments();
      await loadFbaPendingSummary();
      await loadInventory({ preserveSearch: shouldRefreshSearch });
      await loadBoxes();
      if (shouldRefreshSearch) {
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

  $("amazonOrdersBody").addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-action='amazonOrderToggleRow']");
    if (!checkbox) return;

    const id = String(checkbox.dataset.id || "");
    if (!id) return;
    if (checkbox.checked) {
      state.selectedAmazonOrderIds.add(id);
    } else {
      state.selectedAmazonOrderIds.delete(id);
    }
    updateAmazonOrdersSelectAll();
    updateAmazonBatchDeleteButtonState();
  });

  $("manualOrdersBody")?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-action='manualOrderToggleRow']");
    if (!checkbox) return;

    const id = String(checkbox.dataset.id || "");
    if (!id) return;
    if (checkbox.checked) {
      state.selectedManualOrderIds.add(id);
    } else {
      state.selectedManualOrderIds.delete(id);
    }
    updateManualOrdersSelectAll();
    updateManualOrderBatchDeleteButtonState();
  });

  $("rakutenOrdersBody").addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-action='rakutenOrderToggleRow']");
    if (!checkbox) return;

    const id = String(checkbox.dataset.id || "");
    if (!id) return;
    if (checkbox.checked) {
      state.selectedRakutenOrderIds.add(id);
    } else {
      state.selectedRakutenOrderIds.delete(id);
    }
    updateRakutenOrdersSelectAll();
    updateRakutenBatchDeleteButtonState();
  });

  $("overseasOrderProcessingBody").addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-action='overseasOrderToggleRow']");
    if (!checkbox) return;

    const key = String(checkbox.dataset.key || "");
    if (!key) return;
    if (checkbox.checked) {
      state.selectedOverseasOrderKeys.add(key);
    } else {
      state.selectedOverseasOrderKeys.delete(key);
    }
    updateOverseasOrderProcessingSelectAll();
    updateOverseasCreatePickingBatchButtonState();
  });

  $("rakutenOrdersBody").addEventListener("click", (event) => {
    try {
      const editTrigger = event.target.closest("button[data-action='editRakutenOrder']");
      if (editTrigger) {
        openOrderEditModal("rakuten", editTrigger.dataset.id || "");
        return;
      }
      const trigger = event.target.closest("button[data-action='openRakutenOrderDetail']");
      if (!trigger) return;
      openRakutenOrderDetailModal(trigger.dataset.id || "");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("overseasOrderProcessingBody").addEventListener("click", async (event) => {
    try {
      const rakutenTrigger = event.target.closest("button[data-action='openOverseasRakutenOrderDetail']");
      if (rakutenTrigger) {
        const item = state.overseasOrderProcessingOrders.find(
          (row) => row?.source === "rakuten" && String(row?.id || "") === String(rakutenTrigger.dataset.id || ""),
        );
        openRakutenOrderDetailModalFromItem(item);
        return;
      }

      const amazonTrigger = event.target.closest("button[data-action='openOverseasAmazonOrderDetail']");
      if (amazonTrigger) {
        const item = state.overseasOrderProcessingOrders.find(
          (row) => row?.source === "amazon" && String(row?.id || "") === String(amazonTrigger.dataset.id || ""),
        );
        openAmazonOrderDetailModalFromItem(item);
        return;
      }

      const manualTrigger = event.target.closest("button[data-action='openOverseasManualOrderDetail']");
      if (manualTrigger) {
        const item = state.overseasOrderProcessingOrders.find(
          (row) => row?.source === "manual" && String(row?.id || "") === String(manualTrigger.dataset.id || ""),
        );
        openAmazonOrderDetailModalFromItem(item, "manual");
        return;
      }

      const switchTrigger = event.target.closest("button[data-action='switchOverseasPendingOrderToChina']");
      if (!switchTrigger) return;
      const source = String(switchTrigger.dataset.source || "").trim();
      const id = String(switchTrigger.dataset.id || "").trim();
      const orderId = String(switchTrigger.dataset.orderId || "").trim();
      if (!source || !id) {
        throw new Error("缺少订单标识");
      }
      const ok = await openDeleteConfirmModal(
        `确认将订单 ${orderId || id} 切换为中国发？切换后该订单会从海外仓待处理移到中国发待处理。`,
      );
      if (!ok) return;
      await switchOverseasPendingOrderToChina(source, id);
      state.selectedOverseasOrderKeys.delete(`${source}:${id}`);
      await Promise.all([loadOverseasOrderProcessingOrders(), loadChinaOrderProcessingOrders()]);
      showToast(`订单 ${orderId || id} 已切换为中国发`);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  const handleChinaOrderProcessingClick = (event) => {
    try {
      const rakutenTrigger = event.target.closest("button[data-action='openChinaRakutenOrderDetail']");
      if (rakutenTrigger) {
        const item = state.chinaOrderProcessingOrders.find(
          (row) => row?.source === "rakuten" && String(row?.id || "") === String(rakutenTrigger.dataset.id || ""),
        );
        openRakutenOrderDetailModalFromItem(item);
        return;
      }

      const amazonTrigger = event.target.closest("button[data-action='openChinaAmazonOrderDetail']");
      if (amazonTrigger) {
        const item = state.chinaOrderProcessingOrders.find(
          (row) => row?.source === "amazon" && String(row?.id || "") === String(amazonTrigger.dataset.id || ""),
        );
        openAmazonOrderDetailModalFromItem(item);
        return;
      }

      const manualTrigger = event.target.closest("button[data-action='openChinaManualOrderDetail']");
      if (!manualTrigger) return;
      const item = state.chinaOrderProcessingOrders.find(
        (row) => row?.source === "manual" && String(row?.id || "") === String(manualTrigger.dataset.id || ""),
      );
      openAmazonOrderDetailModalFromItem(item, "manual");
    } catch (error) {
      showToast(error.message, true);
    }
  };

  $("chinaOrderProcessingPendingBody")?.addEventListener("click", handleChinaOrderProcessingClick);
  $("chinaOrderProcessingExportedBody")?.addEventListener("click", handleChinaOrderProcessingClick);

  $("overseasPickingBatchListBody")?.addEventListener("click", async (event) => {
    const trigger = event.target.closest("button[data-action='openOverseasPickingBatchDetail']");
    if (!trigger) return;

    try {
      await openOverseasPickingBatchDetail(String(trigger.dataset.id || "").trim(), { focusScan: false });
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("overseasPickingBatchItemsBody")?.addEventListener("click", async (event) => {
    const resetTrigger = event.target.closest("button[data-action='resetOverseasPickedItem']");
    if (resetTrigger) {
      try {
        const detail = state.selectedOverseasPickingBatchDetail;
        if (!detail?.id) {
          throw new Error("请先选择一个拣货批次");
        }
        const productId = String(resetTrigger.dataset.productId || "").trim();
        if (!productId) {
          throw new Error("缺少产品ID");
        }
        const ok = await openDeleteConfirmModal(
          `确认将产品 ${productId} 变更回未拣货状态？`,
        );
        if (!ok) return;
        await resetOverseasPickingBatchProductPicking(detail.id, productId);
        await Promise.all([loadOverseasPickingBatches(), loadOverseasPickingBatchDetail(detail.id)]);
        showToast(`产品 ${productId} 已恢复为未拣货状态`);
        focusOverseasPickingScanInput();
      } catch (error) {
        showToast(error.message, true);
      }
      return;
    }

    const trigger = event.target.closest("button[data-action='switchOverseasItemToChina']");
    if (!trigger) return;

    try {
      const detail = state.selectedOverseasPickingBatchDetail;
      if (!detail?.id) {
        throw new Error("请先选择一个拣货批次");
      }
      const productId = String(trigger.dataset.productId || "").trim();
      if (!productId) {
        throw new Error("缺少产品ID");
      }
      const ok = await openDeleteConfirmModal(
        `确认将产品 ${productId} 切换为中国发？该产品关联订单将不再参与当前海外仓 Yamato 出单。`,
      );
      if (!ok) return;
      const result = await switchOverseasPickingBatchProductToChina(detail.id, productId);
      await Promise.all([
        loadOverseasOrderProcessingOrders(),
        loadChinaOrderProcessingOrders(),
        loadOverseasPickingBatches(),
      ]);
      if (result?.batchDeleted) {
        state.selectedOverseasPickingBatchId = "";
        state.selectedOverseasPickingBatchDetail = null;
        state.overseasPickingBatchView = "list";
        renderOverseasPickingBatchControls();
        showToast(`产品 ${productId} 已移出当前批次并进入中国发待处理，当前批次已清空`);
        return;
      }
      await loadOverseasPickingBatchDetail(detail.id);
      showToast(`产品 ${productId} 已移出当前批次并进入中国发待处理`);
      focusOverseasPickingScanInput();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("overseasPickingBatchOrdersBody")?.addEventListener("click", async (event) => {
    try {
      const detail = state.selectedOverseasPickingBatchDetail;
      const orders = Array.isArray(detail?.orders) ? detail.orders : [];

      const rakutenTrigger = event.target.closest("button[data-action='openPickingBatchRakutenOrderDetail']");
      if (rakutenTrigger) {
        const itemId = String(rakutenTrigger.dataset.itemId || "").trim();
        const item = orders.find((row) => String(row?.itemId || "") === itemId);
        openRakutenOrderDetailModalFromItem(item);
        return;
      }

      const amazonTrigger = event.target.closest("button[data-action='openPickingBatchAmazonOrderDetail']");
      if (amazonTrigger) {
        const itemId = String(amazonTrigger.dataset.itemId || "").trim();
        const item = orders.find((row) => String(row?.itemId || "") === itemId);
        openAmazonOrderDetailModalFromItem(item);
        return;
      }

      const manualTrigger = event.target.closest("button[data-action='openPickingBatchManualOrderDetail']");
      if (manualTrigger) {
        const itemId = String(manualTrigger.dataset.itemId || "").trim();
        const item = orders.find((row) => String(row?.itemId || "") === itemId);
        openAmazonOrderDetailModalFromItem(item, "manual");
        return;
      }

      const removeTrigger = event.target.closest("button[data-action='removeOverseasOrderFromBatch']");
      if (!removeTrigger) return;
      if (!detail?.id) {
        throw new Error("请先选择一个拣货批次");
      }
      const itemId = String(removeTrigger.dataset.itemId || "").trim();
      const orderId = String(removeTrigger.dataset.orderId || "").trim();
      const productId = String(removeTrigger.dataset.productId || "").trim();
      if (!itemId) {
        throw new Error("缺少拣货明细ID");
      }
      const ok = await openDeleteConfirmModal(
        `确认将订单 ${orderId || itemId} 踢出本批次发货？该订单会退回海外仓待处理订单列表。`,
      );
      if (!ok) return;
      const result = await removeOverseasPickingBatchItem(detail.id, itemId);
      await Promise.all([
        loadOverseasOrderProcessingOrders(),
        loadChinaOrderProcessingOrders(),
        loadOverseasPickingBatches(),
      ]);
      if (result?.batchDeleted) {
        state.selectedOverseasPickingBatchId = "";
        state.selectedOverseasPickingBatchDetail = null;
        state.overseasPickingBatchView = "list";
        renderOverseasPickingBatchControls();
        showToast(`订单 ${orderId || productId || itemId} 已踢出本批次，当前批次已清空`);
        return;
      }
      await loadOverseasPickingBatchDetail(detail.id);
      showToast(`订单 ${orderId || productId || itemId} 已踢出本批次发货`);
      focusOverseasPickingScanInput();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("amazonOrdersBody").addEventListener("click", (event) => {
    try {
      const editTrigger = event.target.closest("button[data-action='editAmazonOrder']");
      if (editTrigger) {
        openOrderEditModal("amazon", editTrigger.dataset.id || "");
        return;
      }
      const trigger = event.target.closest("button[data-action='openAmazonOrderDetail']");
      if (!trigger) return;
      openAmazonOrderDetailModal(trigger.dataset.id || "");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("manualOrdersBody")?.addEventListener("click", (event) => {
    try {
      const editTrigger = event.target.closest("button[data-action='editManualOrder']");
      if (editTrigger) {
        openOrderEditModal("manual", editTrigger.dataset.id || "");
        return;
      }
      const trigger = event.target.closest("button[data-action='openManualOrderDetail']");
      if (!trigger) return;
      openAmazonOrderDetailModal(trigger.dataset.id || "", "manual");
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
        const confirmed = await openActionConfirmModal("出库1件成功", "提示", "确认", { showCancel: false });
        if (!confirmed) return;
        await loadInventory({ preserveSearch: shouldRefreshSearch });
        await loadBoxes();
        await loadAudit();
        if (shouldRefreshSearch) {
          await searchInventoryProducts(keyword);
        }
        return;
      }

      const direction = action === "inventoryOutbound" ? "outbound" : "inbound";
      if (direction === "outbound") {
        ensureSkuReadyForFbaReplenishment(skuId);
      }
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

  const openInventoryEditByAction = async (event) => {
    const button = event.target.closest("button[data-action='inventoryEdit'], button[data-action='deleteSkuRow']");
    if (!button) return;
    const skuId = Number(button.dataset.skuId);
    if (!Number.isInteger(skuId) || skuId <= 0) return;
    try {
      if (button.dataset.action === "deleteSkuRow") {
        const skuCode = String(button.dataset.skuCode || `#${skuId}`).trim();
        const ok = await openDeleteConfirmModal(`确定物理删除SKU：${skuCode}？`);
        if (!ok) return;
        await deleteSku(skuId);
        showToast("SKU已删除");
        await Promise.all([
          loadInventory({ preserveSearch: true }),
          loadAudit(),
        ]);
        return;
      }
      await openEditSkuModal(skuId);
    } catch (error) {
      showToast(error.message, true);
    }
  };

  $("inventoryBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    try {
      const action = String(button.dataset.action || "");
      if (action === "inventoryOpenMasterProductDetail") {
        const productId = String(button.dataset.productId || "").trim();
        if (!productId) return;
        await loadInventoryHomeProductDetail(productId);
        return;
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  const openMasterProductDetailFromManageModal = async (event) => {
    const button = event.target.closest("button[data-action='openMasterProductDetail']");
    if (!button) return;
    try {
      const productId = String(button.dataset.productId || "").trim();
      if (!productId) return;
      const detail = await request(`/master-products/${encodeURIComponent(productId)}/detail`);
      switchPanel("inventory");
      renderInventoryHomeDetail(detail);
      setInventoryDisplayMode(true);
    } catch (error) {
      showToast(error.message, true);
    }
  };

  $("boxContentQueryBody")?.addEventListener("click", openMasterProductDetailFromManageModal);
  $("shelfBoxQueryBody")?.addEventListener("click", openMasterProductDetailFromManageModal);

  $("usersBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const userId = String(button.dataset.id || "").trim();
    const username = String(button.dataset.username || "").trim();
    if (!userId) return;

    try {
      if (button.dataset.action === "editUser") {
        const role = String(button.dataset.role || "employee");
        const department = String(button.dataset.department || "china_warehouse");
        const status = Number(button.dataset.status ?? 1);
        openEditUserModal(userId, username, role, department, status);
        return;
      }

      if (button.dataset.action === "resetUserPassword") {
        const passwordInitialized = String(button.dataset.passwordInitialized || "0") === "1";
        openResetUserPasswordModal(userId, username, passwordInitialized);
        return;
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  const handleUserOptionClick = async (event, kind) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = String(button.dataset.action || "");
    const isDepartment = kind === "departments";
    const editAction = isDepartment ? "editDepartmentOption" : "editRoleOption";
    const deleteAction = isDepartment ? "deleteDepartmentOption" : "deleteRoleOption";
    if (![editAction, deleteAction].includes(action)) return;

    const row = button.closest("tr[data-user-option-code]");
    if (!row) return;
    const code = String(row.dataset.userOptionCode || "").trim();
    const endpointKind = kind === "roles" ? "roles" : "departments";
    if (!code) return;
    const editingSet = isDepartment ? state.departmentOptionEditingCodes : state.roleOptionEditingCodes;

    try {
      if (action === editAction) {
        const nameInput = row.querySelector("input[data-field='name']");
        if (!nameInput) return;

        const isEditing = editingSet.has(code);
        if (!isEditing) {
          editingSet.add(code);
          renderUserOptionsTable();
          const focusInput = isDepartment ? $(`departmentOptionName-${code}`) : $(`roleOptionName-${code}`);
          if (focusInput) {
            focusInput.focus();
            focusInput.select?.();
          }
          return;
        }

        const name = String(nameInput.value || "").trim();
        if (!name) {
          throw new Error("名称不能为空");
        }
        const originalName = String(nameInput.getAttribute("data-original-name") || "").trim();
        if (name === originalName) {
          editingSet.delete(code);
          renderUserOptionsTable();
          return;
        }

        await request(`/user-options/${endpointKind}/${encodeURIComponent(code)}`, {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
        editingSet.delete(code);
        showToast("变更成功");
      } else if (action === deleteAction) {
        const nameInput = row.querySelector("input[data-field='name']");
        const optionName = String(nameInput?.value || code).trim() || code;
        const ok = await openActionConfirmModal(
          `确认删除${isDepartment ? "部门" : "角色"} ${optionName} 吗？`,
          "确认操作",
          "确认删除",
        );
        if (!ok) return;
        await request(`/user-options/${endpointKind}/${encodeURIComponent(code)}`, {
          method: "PUT",
          body: JSON.stringify({ status: 0 }),
        });
        editingSet.delete(code);
        showToast("删除成功");
      }

      await Promise.all([loadUserOptions(), loadUsers(), loadAudit()]);
    } catch (error) {
      showToast(error.message, true);
    }
  };
  $("departmentOptionsBody").addEventListener("click", (event) => {
    handleUserOptionClick(event, "departments");
  });

  $("productEditRequestBody").addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[data-action='toggleProductEditRequestSelect']");
    if (!checkbox) return;
    const requestId = String(checkbox.dataset.id || "").trim();
    if (!requestId) return;
    if (checkbox.checked) {
      state.selectedProductEditRequestIds.add(requestId);
    } else {
      state.selectedProductEditRequestIds.delete(requestId);
    }
    updateProductEditRequestSelectAll();
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
        await Promise.all([loadProductEditRequests({ reset: true }), loadProductEditPendingSummary()]);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("masterProductBody")?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='openMasterProductDetail']");
    if (!button) return;
    const productId = String(button.dataset.productId || "").trim();
    if (!productId) return;
    try {
      await loadMasterProductDetail(productId);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("masterProductBoxBody").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const boxCode = String(button.dataset.boxCode || "").trim();
    if (!boxCode) return;

    if (button.dataset.action === "fillMasterProductInboundBox") {
      prefillMasterProductBoxInputs(boxCode, "inbound");
      return;
    }
    if (button.dataset.action === "fillMasterProductOutboundBox") {
      prefillMasterProductBoxInputs(boxCode, "outbound");
      return;
    }
    if (button.dataset.action === "fillMasterProductFbaBox") {
      prefillMasterProductBoxInputs(boxCode, "fba");
    }
  });

  $("inventoryDetailBoxBody").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const boxCode = String(button.dataset.boxCode || "").trim();
    if (!boxCode) return;
    const productId = getSelectedInventoryDetailProductId();
    if (!productId) return;

    if (button.dataset.action === "openInventoryDetailInboundBox") {
      loadBoxes()
        .then(() => {
          openInventoryDetailInboundModal(boxCode, { lockBoxCode: true });
        })
        .catch((error) => {
          showToast(error.message, true);
        });
      return;
    }
    if (button.dataset.action === "openInventoryDetailFbaBox") {
      try {
        openInventoryDetailFbaModal(boxCode);
      } catch (error) {
        showToast(error.message, true);
      }
      return;
    }
    if (button.dataset.action === "inventoryDetailOutboundOne") {
      openActionConfirmModal(`确认从箱号 ${boxCode} 出库 1 件当前主商品吗？`, "确认出库", "出库1件")
        .then(async (confirmed) => {
          if (!confirmed) return;
          await withBusyButton(button, "处理中...", async () => {
            await quickInventoryDetailOutboundOne(boxCode);
            showToast("主商品已出库 1 件");
            await Promise.all([
              loadInventory({ preserveSearch: true }),
              loadBoxes(),
              loadAudit(),
            ]);
            await loadInventoryHomeProductDetail(productId);
          });
        })
        .catch((error) => {
          showToast(error.message, true);
        });
    }
  });

  $("productEditSelectAll").addEventListener("change", (event) => {
    const checked = Boolean(event.target.checked);
    const visibleRows = state.skuEditRequests
      .filter((item) => canSelectProductEditRequestForBatchConfirm(item))
      .map((item) => String(item.id));
    if (checked) {
      visibleRows.forEach((id) => state.selectedProductEditRequestIds.add(id));
    } else {
      visibleRows.forEach((id) => state.selectedProductEditRequestIds.delete(id));
    }
    renderProductEditRequestTable();
  });

  $("batchConfirmProductEditRequestBtn").addEventListener("click", async () => {
    try {
      const ids = [...state.selectedProductEditRequestIds]
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0);
      if (!ids.length) {
        throw new Error("请选择需要批量确认的申请");
      }

      const ok = await openActionConfirmModal(
        `确认批量确认 ${ids.length} 条编辑SKU申请？`,
        "批量确认编辑SKU申请",
        "批量确认",
      );
      if (!ok) return;

      let successCount = 0;
      const failedMessages = [];
      for (const id of ids) {
        try {
          await confirmProductEditRequest(id);
          successCount += 1;
        } catch (error) {
          const message = String(error?.message || "确认失败");
          failedMessages.push(`#${id}: ${message}`);
        }
      }

      state.selectedProductEditRequestIds = new Set();
      await Promise.all([
        loadProductEditRequests({ reset: true }),
        loadProductEditPendingSummary(),
        loadInventory(),
        loadAudit(),
      ]);

      if (state.selectedProductEditRequestId) {
        try {
          const detail = await loadProductEditRequestDetail(state.selectedProductEditRequestId);
          renderProductEditRequestDetail(detail);
        } catch {
          renderProductEditRequestDetail(null);
        }
      }

      if (!failedMessages.length) {
        showToast(`批量确认完成，共 ${successCount} 条`);
      } else {
        const firstError = failedMessages[0];
        showToast(
          `批量确认完成：成功 ${successCount} 条，失败 ${failedMessages.length} 条。${firstError}`,
          true,
        );
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("confirmProductEditRequestBtn").addEventListener("click", async () => {
    try {
      const permission = resolveProductEditConfirmPermission(
        state.selectedProductEditRequestChangedFields,
      );
      if (!permission.allowed) {
        throw new Error(permission.contactMessage || permission.message);
      }
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
        loadProductEditRequests({ reset: true }),
        loadProductEditPendingSummary(),
        loadInventory(),
        loadAudit(),
      ]);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("dataBackupBody").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action='downloadDataBackup']");
    if (!button) return;
    const fileName = String(button.dataset.fileName || "").trim();
    if (!fileName) return;
    try {
      await downloadDataBackup(fileName);
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("inventorySearchResults")?.addEventListener("click", openAdjustByAction);
  $("inventorySearchResults")?.addEventListener("click", openInventoryEditByAction);
  $("skuManagementBody")?.addEventListener("click", openInventoryEditByAction);

  document.addEventListener("click", (event) => {
    const runDataBackupBtn = event.target.closest("#runDataBackupBtn");
    if (runDataBackupBtn) {
      runDataBackupNow(runDataBackupBtn).catch((error) => showToast(error.message, true));
      return;
    }
    const refreshDataBackupBtn = event.target.closest("#refreshDataBackup");
    if (refreshDataBackupBtn) {
      loadDataBackups().catch((error) => showToast(error.message, true));
      return;
    }
    const button = event.target.closest("button[data-action='closeCreateSkuModal']");
    if (button) {
      closeModal("createSkuModal");
      return;
    }
    const bulkSkuUploadClose = event.target.closest("button[data-action='closeBulkSkuUploadModal']");
    if (bulkSkuUploadClose) {
      closeModal("bulkSkuUploadModal");
      return;
    }
    const bulkInventoryUpdateClose = event.target.closest(
      "button[data-action='closeBulkInventoryUpdateModal']",
    );
    if (bulkInventoryUpdateClose) {
      closeModal("bulkInventoryUpdateModal");
      return;
    }
    const bossStockAdjustmentClose = event.target.closest(
      "button[data-action='closeBossStockAdjustmentModal']",
    );
    if (bossStockAdjustmentClose) {
      closeModal("bossStockAdjustmentModal");
      return;
    }
    const masterProductImportClose = event.target.closest(
      "button[data-action='closeMasterProductImportModal']",
    );
    if (masterProductImportClose) {
      closeModal("masterProductImportModal");
      return;
    }
    const createRakutenComboProductClose = event.target.closest(
      "button[data-action='closeCreateRakutenComboProductModal']",
    );
    if (createRakutenComboProductClose) {
      closeModal("createRakutenComboProductModal");
      return;
    }
    const bulkRakutenComboProductUploadClose = event.target.closest(
      "button[data-action='closeBulkRakutenComboProductUploadModal']",
    );
    if (bulkRakutenComboProductUploadClose) {
      closeModal("bulkRakutenComboProductUploadModal");
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
    const inventoryDetailInboundClose = event.target.closest(
      "button[data-action='closeInventoryDetailInboundModal']",
    );
    if (inventoryDetailInboundClose) {
      closeModal("inventoryDetailInboundModal");
      return;
    }
    const inventoryDetailFbaClose = event.target.closest(
      "button[data-action='closeInventoryDetailFbaModal']",
    );
    if (inventoryDetailFbaClose) {
      closeModal("inventoryDetailFbaModal");
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
    const createUserClose = event.target.closest("button[data-action='closeCreateUserModal']");
    if (createUserClose) {
      closeModal("createUserModal");
      return;
    }
    const editUserClose = event.target.closest("button[data-action='closeEditUserModal']");
    if (editUserClose) {
      closeModal("editUserModal");
      state.selectedEditUserId = null;
      return;
    }
    const resetUserPasswordClose = event.target.closest("button[data-action='closeResetUserPasswordModal']");
    if (resetUserPasswordClose) {
      closeModal("resetUserPasswordModal");
      state.selectedResetPasswordUserId = null;
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
    const shelfManageClose = event.target.closest("button[data-action='closeShelfManageModal']");
    if (shelfManageClose) {
      closeModal("shelfManageModal");
      return;
    }
    const boxManageClose = event.target.closest("button[data-action='closeBoxManageModal']");
    if (boxManageClose) {
      closeModal("boxManageModal");
      return;
    }
    const emptyBoxManageClose = event.target.closest("button[data-action='closeEmptyBoxManageModal']");
    if (emptyBoxManageClose) {
      closeModal("emptyBoxManageModal");
      return;
    }
    const boxContentQueryClose = event.target.closest("button[data-action='closeBoxContentQueryModal']");
    if (boxContentQueryClose) {
      closeModal("boxContentQueryModal");
      return;
    }
    const shelfBoxQueryClose = event.target.closest("button[data-action='closeShelfBoxQueryModal']");
    if (shelfBoxQueryClose) {
      closeModal("shelfBoxQueryModal");
      return;
    }
    const stocktakeTaskDetailClose = event.target.closest("button[data-action='closeStocktakeTaskDetailModal']");
    if (stocktakeTaskDetailClose) {
      closeModal("stocktakeTaskDetailModal");
      return;
    }

    const departmentManageClose = event.target.closest("button[data-action='closeDepartmentManageModal']");
    if (departmentManageClose) {
      closeModal("departmentManageModal");
      return;
    }
    const productEditRequestDetailClose = event.target.closest(
      "button[data-action='closeProductEditRequestDetailModal']",
    );
    if (productEditRequestDetailClose) {
      closeModal("productEditRequestDetailModal");
      return;
    }
    const rakutenOrderDetailClose = event.target.closest("button[data-action='closeRakutenOrderDetailModal']");
    if (rakutenOrderDetailClose) {
      closeModal("rakutenOrderDetailModal");
      return;
    }
    const amazonOrderDetailClose = event.target.closest("button[data-action='closeAmazonOrderDetailModal']");
    if (amazonOrderDetailClose) {
      closeModal("amazonOrderDetailModal");
      return;
    }
    const amazonManualOrderClose = event.target.closest("button[data-action='closeAmazonManualOrderModal']");
    if (amazonManualOrderClose) {
      closeModal("amazonManualOrderModal");
      return;
    }
    const orderEditClose = event.target.closest("button[data-action='closeOrderEditModal']");
    if (orderEditClose) {
      closeModal("orderEditModal");
      return;
    }
    const deleteConfirmClose = event.target.closest("button[data-action='closeDeleteConfirmModal']");
    if (deleteConfirmClose) {
      resolveDeleteConfirm(false);
      return;
    }
    const deleteConfirmOk = event.target.closest("#deleteConfirmOkBtn");
    if (deleteConfirmOk) {
      resolveDeleteConfirm(true);
      return;
    }
    const deleteConfirmCancel = event.target.closest("#deleteConfirmCancelBtn");
    if (deleteConfirmCancel) {
      resolveDeleteConfirm(false);
      return;
    }
    const actionConfirmClose = event.target.closest("button[data-action='closeActionConfirmModal']");
    if (actionConfirmClose) {
      resolveActionConfirm(false);
      return;
    }
    const actionConfirmOk = event.target.closest("#actionConfirmOkBtn");
    if (actionConfirmOk) {
      resolveActionConfirm(true);
      return;
    }
    const actionConfirmCancel = event.target.closest("#actionConfirmCancelBtn");
    if (actionConfirmCancel) {
      resolveActionConfirm(false);
      return;
    }
    const errorModalClose = event.target.closest("button[data-action='closeErrorModal']");
    if (errorModalClose) {
      closeErrorModal();
      return;
    }
    const errorModalCloseBtn = event.target.closest("#errorModalCloseBtn");
    if (errorModalCloseBtn) {
      closeErrorModal();
      return;
    }
    const errorModalPrintLabelBtn = event.target.closest("#errorModalPrintLabelBtn");
    if (errorModalPrintLabelBtn) {
      try {
        printPendingLabelFromErrorModal();
      } catch (error) {
        showToast(error.message, true);
      }
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

  $("bulkSkuUploadModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("bulkSkuUploadModal");
    }
  });

  $("bulkInventoryUpdateModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("bulkInventoryUpdateModal");
    }
  });

  $("createRakutenComboProductModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("createRakutenComboProductModal");
    }
  });

  $("bulkRakutenComboProductUploadModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("bulkRakutenComboProductUploadModal");
    }
  });

  $("adjustModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("adjustModal");
    }
  });

  $("inventoryDetailInboundModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("inventoryDetailInboundModal");
    }
  });

  $("inventoryDetailFbaModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("inventoryDetailFbaModal");
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

  $("createUserModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("createUserModal");
    }
  });

  $("editUserModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("editUserModal");
      state.selectedEditUserId = null;
    }
  });

  $("resetUserPasswordModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("resetUserPasswordModal");
      state.selectedResetPasswordUserId = null;
    }
  });

  $("editSkuModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("editSkuModal");
    }
  });

  $("brandManageModal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("brandManageModal");
    }
  });

  $("skuTypeManageModal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("skuTypeManageModal");
    }
  });

  $("shopManageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("shopManageModal");
    }
  });

  $("shelfManageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("shelfManageModal");
    }
  });

  $("boxManageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("boxManageModal");
    }
  });

  $("emptyBoxManageModal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("emptyBoxManageModal");
    }
  });

  $("boxContentQueryModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("boxContentQueryModal");
    }
  });

  $("shelfBoxQueryModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("shelfBoxQueryModal");
    }
  });

  $("departmentManageModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("departmentManageModal");
    }
  });

  $("productEditRequestDetailModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("productEditRequestDetailModal");
    }
  });

  $("rakutenOrderDetailModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("rakutenOrderDetailModal");
    }
  });

  $("amazonOrderDetailModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("amazonOrderDetailModal");
    }
  });

  $("orderEditModal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("orderEditModal");
    }
  });

  $("amazonManualOrderModal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeModal("amazonManualOrderModal");
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

  $("deleteConfirmModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      resolveDeleteConfirm(false);
    }
  });

  $("actionConfirmModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      resolveActionConfirm(false);
    }
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
    loadMoreInventorySearchIfNeeded();
    loadMoreSkuManagementIfNeeded();
    loadMoreProductEditRequestsIfNeeded();
    loadMoreRakutenComboProductsIfNeeded();
    loadMoreUsersIfNeeded();
    loadMoreAuditIfNeeded();
  });

  const inventoryHomeTableWrap = $("inventoryHomeTableWrap");
  if (inventoryHomeTableWrap) {
    inventoryHomeTableWrap.addEventListener("scroll", () => {
      maybeAutoLoadInventoryHome();
    });
  }

  const skuManagementTableWrap = $("skuManagementTableWrap");
  if (skuManagementTableWrap) {
    skuManagementTableWrap.addEventListener("scroll", () => {
      maybeAutoLoadSkuManagement();
    });
  }

  const rakutenComboProductTableWrap = $("rakutenComboProductTableWrap");
  if (rakutenComboProductTableWrap) {
    rakutenComboProductTableWrap.addEventListener("scroll", () => {
      maybeAutoLoadRakutenComboProducts();
    });
  }

  const amazonOrdersTableWrap = $("amazonOrdersTableWrap");
  if (amazonOrdersTableWrap) {
    amazonOrdersTableWrap.addEventListener("scroll", () => {
      maybeAutoLoadAmazonOrders();
    });
  }

  const manualOrdersTableWrap = $("manualOrdersTableWrap");
  if (manualOrdersTableWrap) {
    manualOrdersTableWrap.addEventListener("scroll", () => {
      maybeAutoLoadManualOrders();
    });
  }

  const rakutenOrdersTableWrap = $("rakutenOrdersTableWrap");
  if (rakutenOrdersTableWrap) {
    rakutenOrdersTableWrap.addEventListener("scroll", () => {
      maybeAutoLoadOrders();
    });
  }

  const usersTableWrap = $("usersTableWrap");
  if (usersTableWrap) {
    usersTableWrap.addEventListener("scroll", () => {
      maybeAutoLoadUsers();
    });
  }

  const batchInboundTableWrap = $("batchInboundTableWrap");
  if (batchInboundTableWrap) {
    batchInboundTableWrap.addEventListener("scroll", () => {
      maybeAutoLoadBatchInboundOrders();
    });
  }

  const fbaReplenishmentTableWrap = $("fbaReplenishmentTableWrap");
  if (fbaReplenishmentTableWrap) {
    fbaReplenishmentTableWrap.addEventListener("scroll", () => {
      maybeAutoLoadFbaReplenishments();
    });
  }

  const stocktakePlannerTableWrap = $("stocktakePlannerTableWrap");
  if (stocktakePlannerTableWrap) {
    stocktakePlannerTableWrap.addEventListener("scroll", () => {
      maybeAutoLoadStocktakeTasks();
    });
  }

  const dataBackupTableWrap = $("dataBackupTableWrap");
  if (dataBackupTableWrap) {
    dataBackupTableWrap.addEventListener("scroll", () => {
      maybeAutoLoadDataBackups();
    });
  }

  const auditTableWrap = $("auditTableWrap");
  if (auditTableWrap) {
    auditTableWrap.addEventListener("scroll", () => {
      maybeAutoLoadAudit();
    });
  }

  const myAuditTableWrap = $("myAuditTableWrap");
  if (myAuditTableWrap) {
    myAuditTableWrap.addEventListener("scroll", () => {
      loadMoreMyAuditIfNeeded();
    });
  }

  const shelfManageTableWrap = $("shelfManageTableWrap");
  if (shelfManageTableWrap) {
    shelfManageTableWrap.addEventListener("scroll", () => {
      loadMoreShelvesManageIfNeeded();
    });
  }

  const boxManageTableWrap = $("boxManageTableWrap");
  if (boxManageTableWrap) {
    boxManageTableWrap.addEventListener("scroll", () => {
      loadMoreBoxesManageIfNeeded();
    });
  }
}

function bindRefresh() {
  $("refreshOverviewDashboard").addEventListener("click", () =>
    loadOverviewDashboard().catch((error) => showToast(error.message, true)),
  );
  $("downloadInventorySkuSummaryBtn")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await withBusyButton(button, "下载中...", async () => {
        await downloadInventorySkuSummaryCsv();
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("refreshInventory")?.addEventListener("click", () =>
    (state.inventorySearchMode && state.inventoryHomeSelectedDetail
      ? loadInventoryHomeProductDetail(state.inventoryHomeSelectedDetail?.product?.productId || "")
      : loadInventoryHomeProducts({ reset: true })
    ).catch((error) => showToast(error.message, true)),
  );
  $("refreshOverseasWarehouse").addEventListener("click", () =>
    Promise.all([loadShelves(), loadBoxes()]).catch((error) => showToast(error.message, true)),
  );
  $("refreshProductManagement").addEventListener("click", () =>
    Promise.all([
      loadProductEditRequests({ reset: true }),
      loadProductEditPendingSummary(),
    ]).catch((error) =>
      showToast(error.message, true),
    ),
  );
  $("refreshSkuManagement").addEventListener("click", () =>
    loadInventory({ preserveSearch: true }).catch((error) => showToast(error.message, true)),
  );
  $("refreshUsers").addEventListener("click", () =>
    Promise.all([loadUsers(), loadUserOptions()]).catch((error) => showToast(error.message, true)),
  );
  $("refreshShelves").addEventListener("click", () => loadShelves().catch((error) => showToast(error.message, true)));
  $("refreshBoxes").addEventListener("click", () => loadBoxes().catch((error) => showToast(error.message, true)));
  $("refreshBatchInbound").addEventListener("click", () =>
    loadBatchInboundOrders().catch((error) => showToast(error.message, true)),
  );
  $("refreshRakutenOrders")?.addEventListener("click", () =>
    loadOrders().catch((error) => showToast(error.message, true)),
  );
  $("refreshOrders")?.addEventListener("click", () =>
    loadAmazonOrders().catch((error) => showToast(error.message, true)),
  );
  $("refreshFbaReplenishment").addEventListener("click", () =>
    Promise.all([loadFbaReplenishments(), loadFbaPendingSummary()]).catch((error) =>
      showToast(error.message, true),
    ),
  );
  $("refreshAudit").addEventListener("click", () => loadAudit().catch((error) => showToast(error.message, true)));
}

ensureBrandingUi();
ensureInventoryPanelUi();
ensureOrderProcessingLandingUi();
setupInventoryHomeLoadObserver();
setupProductEditRequestLoadObserver();
setupOrdersLoadObserver();
setupAmazonOrdersLoadObserver();
setupManualOrdersLoadObserver();
setupBatchInboundLoadObserver();
setupUsersLoadObserver();
setupAuditLoadObserver();
setupFbaReplenishmentLoadObserver();
setupStocktakePlannerLoadObserver();
setupDataBackupLoadObserver();
setupRakutenComboProductLoadObserver();
setupResponsiveTableLabels();
ensureOverseasWarehouseQueryUi();
renderStocktakePlanner();
bindTabs();
bindInputRules();
bindForms();
ensureBossStockAdjustmentUi();
ensureBossMappingDownloadUi();
ensureBossNewItemDownloadUi();
bindDelegates();
bindScrollLoad();
bindRefresh();
renderOverseasPickingBatchControls();
renderYamatoShipmentBatchControls();
updateOverseasCreatePickingBatchButtonState();
updateAmazonBatchDeleteButtonState();
updateAmazonOrdersSelectAll();
updateManualOrderBatchDeleteButtonState();
updateManualOrdersSelectAll();
updateFbaOutboundButtonState();
updateFbaSelectAll();
bootstrapAuthTokenFromLocationHash();
switchPanel("inventory", { markAsUserNavigation: false });
reloadAll()
  .then(() => openInventoryStartupView())
  .catch((error) => showToast(error.message, true));
