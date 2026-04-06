import { Vector3 } from "three";
import { Five, parseWork } from "./vendor/realsee-five/index.mjs?v=20260406p";

const bundleIdEl = document.querySelector("#bundle-id");
const bundleTitleEl = document.querySelector("#bundle-title");
const statusTextEl = document.querySelector("#status-text");
const metaTextEl = document.querySelector("#meta-text");
const viewerRootEl = document.querySelector("#viewer-root");
const modelPanelEl = document.querySelector("#model-panel");
const modelFloorsEl = document.querySelector("#model-floors");
const modelFloorStyleEl = document.querySelector("#model-floor-style");
const floorplanPanelEl = document.querySelector("#floorplan-panel");
const floorplanLevelsEl = document.querySelector("#floorplan-levels");
const floorplanTypesEl = document.querySelector("#floorplan-types");
const floorplanImageEl = document.querySelector("#floorplan-image");

const modeButtons = {
  Model: document.querySelector("#mode-model"),
  Panorama: document.querySelector("#mode-panorama"),
  Floorplan: document.querySelector("#mode-floorplan"),
};

const VIEW_MODES = {
  Model: Five.Mode.Mapview,
  Panorama: Five.Mode.Panorama,
  Floorplan: Five.Mode.Floorplan,
};

const DEFAULT_MODEL_CAMERA = {
  longitude: Math.PI / 4,
  latitude: Math.PI / 4,
  fov: 60,
};
const NON_SELECTED_FLOOR_OPACITY = 0.8;

const params = new URLSearchParams(window.location.search);
const bundleId = params.get("bundle");

let five = null;
let currentMode = null;
let lastThreeDMode = null;
let modeAvailability = {
  Model: false,
  Panorama: false,
  Floorplan: false,
};
let modelState = {
  floors: [],
  shownFloor: null,
  floorStyle: "OPACITY",
  floorBoundaries: {},
};
const materialPresentationSnapshot = new WeakMap();
const objectPresentationSnapshot = new WeakMap();
let floorplanState = {
  floors: [],
  floorIndex: 0,
  type: "hierarchy",
};

function publishDebugState() {
  window.__offlineDebug = {
    currentMode,
    lastThreeDMode,
    modelState: {
      floors: [...modelState.floors],
      shownFloor: modelState.shownFloor,
      floorStyle: modelState.floorStyle,
      floorBoundaries: { ...modelState.floorBoundaries },
    },
    floorplanVisible: floorplanPanelEl.classList.contains("floorplan--hidden") === false,
    modelPanelVisible: modelPanelEl.classList.contains("model-panel--hidden") === false,
    fiveState: five?.getCurrentState?.() || null,
  };
}

function absolutizeBundlePaths(value, baseUrl, path = []) {
  if (Array.isArray(value)) {
    return value.map((item) => absolutizeBundlePaths(item, baseUrl, path));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        absolutizeBundlePaths(item, baseUrl, [...path, key]),
      ]),
    );
  }

  if (typeof value !== "string") {
    return value;
  }

  const inMaterialTextures = path[path.length - 1] === "material_textures";
  if (inMaterialTextures) {
    // Five resolves model textures against material_base_url, so these should stay as file names.
    return value.includes("/") ? value.split("/").pop() || value : value;
  }

  if (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("assets/")
  ) {
    return new URL(value, baseUrl).href;
  }

  return value;
}

function setStatus(text) {
  statusTextEl.textContent = text;
  publishDebugState();
}

function isModelViewMode(mode) {
  return mode === VIEW_MODES.Model || mode === Five.Mode.Model;
}

function isPanoramaMode(mode) {
  return (
    mode === VIEW_MODES.Panorama ||
    mode === Five.Mode.VRPanorama ||
    mode === Five.Mode.XRPanorama
  );
}

function getModeLabel(mode) {
  if (isModelViewMode(mode)) {
    return "模型";
  }
  if (isPanoramaMode(mode)) {
    return "全景";
  }
  if (mode === VIEW_MODES.Floorplan) {
    return "户型";
  }
  return String(mode);
}

function pickInitialMode(availability) {
  if (availability.Panorama) {
    return VIEW_MODES.Panorama;
  }
  if (availability.Model) {
    return VIEW_MODES.Model;
  }
  if (availability.Floorplan) {
    return VIEW_MODES.Floorplan;
  }
  return VIEW_MODES.Model;
}

function setModeAvailability(availability) {
  Object.entries(modeButtons).forEach(([name, button]) => {
    button.disabled = !availability[name];
  });
  publishDebugState();
}

function setFloorplanVisibility(visible) {
  floorplanPanelEl.classList.toggle("floorplan--hidden", !visible);
  publishDebugState();
}

function setModelPanelVisibility(visible) {
  modelPanelEl.classList.toggle("model-panel--hidden", !visible);
  publishDebugState();
}

function buildModelState(work) {
  const floorIndexes = new Set();
  const floorHeights = new Map();

  (work.observers || []).forEach((item) => {
    if (typeof item?.floor_index === "number") {
      floorIndexes.add(item.floor_index);
      const positionY = Array.isArray(item.position) ? item.position[1] : item.position?.y;
      if (typeof positionY === "number") {
        const heights = floorHeights.get(item.floor_index) || [];
        heights.push(positionY);
        floorHeights.set(item.floor_index, heights);
      }
    }
  });

  (work.hierarchy_floor_plan || []).forEach((item) => {
    if (typeof item?.index === "number") {
      floorIndexes.add(item.index);
    }
  });

  (work.outline_floor_plan || []).forEach((item) => {
    if (typeof item?.index === "number") {
      floorIndexes.add(item.index);
    }
  });

  const sortedFloors = [...floorIndexes].sort((a, b) => a - b);
  const floorBoundaries = {};
  for (let index = 0; index < sortedFloors.length - 1; index += 1) {
    const lowerFloor = sortedFloors[index];
    const upperFloor = sortedFloors[index + 1];
    const lowerHeights = floorHeights.get(lowerFloor) || [];
    const upperHeights = floorHeights.get(upperFloor) || [];
    if (!lowerHeights.length || !upperHeights.length) {
      continue;
    }

    const lowerMax = Math.max(...lowerHeights);
    const upperMin = Math.min(...upperHeights);
    floorBoundaries[lowerFloor] = (lowerMax + upperMin) / 2;
  }

  return {
    floors: sortedFloors,
    shownFloor: null,
    floorStyle: "OPACITY",
    floorBoundaries,
  };
}

function buildFloorplanState(work) {
  const floors = new Map();
  const assign = (items, key) => {
    if (!Array.isArray(items)) {
      return;
    }
    items.forEach((item) => {
      if (!item?.url || typeof item.index !== "number") {
        return;
      }
      const entry = floors.get(item.index) || { index: item.index, hierarchy: "", outline: "" };
      entry[key] = item.url;
      floors.set(item.index, entry);
    });
  };

  assign(work.hierarchy_floor_plan, "hierarchy");
  assign(work.outline_floor_plan, "outline");

  const sortedFloors = [...floors.values()]
    .filter((item) => item.hierarchy || item.outline)
    .sort((a, b) => a.index - b.index);

  return {
    floors: sortedFloors,
    floorIndex: 0,
    type: sortedFloors.some((item) => item.hierarchy) ? "hierarchy" : "outline",
  };
}

function renderSegmentedButtons(container, items, activeValue, onClick) {
  container.replaceChildren();

  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segmented__button";
    if (item.value === activeValue) {
      button.classList.add("segmented__button--active");
    }
    button.textContent = item.label;
    button.addEventListener("click", () => onClick(item.value));
    container.append(button);
  });
}

function renderFloorplanPanel() {
  const floors = floorplanState.floors;
  if (!floors.length) {
    setFloorplanVisibility(false);
    return;
  }

  const activeFloor = floors[floorplanState.floorIndex] || floors[0];
  const availableTypes = [
    activeFloor.hierarchy ? { value: "hierarchy", label: "原图" } : null,
    activeFloor.outline ? { value: "outline", label: "轮廓" } : null,
  ].filter(Boolean);

  if (!availableTypes.some((item) => item.value === floorplanState.type)) {
    floorplanState.type = availableTypes[0]?.value || "hierarchy";
  }

  renderSegmentedButtons(
    floorplanLevelsEl,
    floors.map((item, idx) => ({
      value: String(idx),
      label: `${item.index + 1}层`,
    })),
    String(floorplanState.floorIndex),
    (value) => {
      floorplanState.floorIndex = Number(value);
      renderFloorplanPanel();
    },
  );

  renderSegmentedButtons(
    floorplanTypesEl,
    availableTypes,
    floorplanState.type,
    (value) => {
      floorplanState.type = value;
      renderFloorplanPanel();
    },
  );

  const imageUrl = activeFloor[floorplanState.type] || activeFloor.hierarchy || activeFloor.outline || "";
  floorplanImageEl.src = imageUrl;
  floorplanImageEl.alt = `第 ${activeFloor.index + 1} 层户型图`;
  setFloorplanVisibility(true);
  publishDebugState();
}

function describeModelStatus() {
  const prefix = "当前模式: 模型（整体外视角";

  if (modelState.shownFloor === null) {
    return `${prefix}，全部楼层）`;
  }

  const floorLabel = `${modelState.shownFloor + 1}F`;
  const styleLabel =
    modelState.floorStyle === "VISIBILITY"
      ? "其他楼层隐藏"
      : "其他楼层半透明";

  return `${prefix}，${floorLabel}，${styleLabel}）`;
}

function getModeButtonKey(mode) {
  if (isModelViewMode(mode)) {
    return "Model";
  }
  if (isPanoramaMode(mode)) {
    return "Panorama";
  }
  if (mode === VIEW_MODES.Floorplan) {
    return "Floorplan";
  }
  return null;
}

function distanceFromBoundingBox(box, fov, aspect) {
  if (!box || typeof box.isEmpty !== "function" || box.isEmpty()) {
    return 10;
  }

  const size = box.getSize(new Vector3());
  let diagonal = Math.hypot(size.x + 1, size.y + 1, size.z + 1);
  diagonal = Number.isFinite(diagonal) && diagonal > 0 ? diagonal : 1;

  let distance = diagonal / 2 / Math.tan((Math.PI * fov) / 360);
  if (aspect < 1) {
    distance /= aspect;
  }

  return Number.isFinite(distance) && distance > 0 ? distance : diagonal;
}

function buildModelViewState() {
  const fallbackOffset = five?.camera?.pose?.offset?.clone?.() || new Vector3(0, 0, 0);

  if (!five?.modelScene?.boundingBox) {
    return {
      ...DEFAULT_MODEL_CAMERA,
      offset: fallbackOffset,
      distance: 10,
    };
  }

  const box = five.modelScene.boundingBox;
  const aspect =
    five?.camera?.aspect ||
    viewerRootEl.clientWidth / Math.max(viewerRootEl.clientHeight, 1) ||
    1;
  const offset = box.isEmpty() ? fallbackOffset : box.getCenter(new Vector3());
  const distance = distanceFromBoundingBox(box, DEFAULT_MODEL_CAMERA.fov, aspect);

  return {
    ...DEFAULT_MODEL_CAMERA,
    offset,
    distance,
  };
}

function rememberMaterialPresentation(material) {
  if (!material || materialPresentationSnapshot.has(material)) {
    return;
  }

  materialPresentationSnapshot.set(material, {
    transparent: material.transparent,
    opacity: material.opacity,
    depthWrite: material.depthWrite,
    clippingPlanes: material.clippingPlanes ? [...material.clippingPlanes] : null,
    clipShadows: material.clipShadows,
  });
}

function rememberObjectPresentation(object) {
  if (!object || objectPresentationSnapshot.has(object)) {
    return;
  }

  objectPresentationSnapshot.set(object, {
    visible: object.visible,
  });
}

function restoreMaterialPresentation(material) {
  const snapshot = materialPresentationSnapshot.get(material);
  if (!snapshot) {
    return;
  }

  material.transparent = snapshot.transparent;
  material.opacity = snapshot.opacity;
  material.depthWrite = snapshot.depthWrite;
  material.clippingPlanes = snapshot.clippingPlanes ? [...snapshot.clippingPlanes] : null;
  material.clipShadows = snapshot.clipShadows;
  material.needsUpdate = true;
}

function restoreObjectPresentation(object) {
  const snapshot = objectPresentationSnapshot.get(object);
  if (!snapshot) {
    return;
  }

  object.visible = snapshot.visible;
}

function collectFloorMeshes() {
  const floorMeshes = [];
  const visit = (object) => {
    if (!object) {
      return;
    }

    if (object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const floorIndexes = [...new Set(materials.map((material) => material?.floorIndex))];
      if (floorIndexes.length === 1 && typeof floorIndexes[0] === "number") {
        floorMeshes.push({
          object,
          floorIndex: floorIndexes[0],
          materials,
        });
      }
    }

    if (Array.isArray(object.children)) {
      object.children.forEach(visit);
    }
  };

  (five?.modelScene?.shownModels || []).forEach(visit);
  return floorMeshes;
}

function applyCustomFloorPresentation() {
  if (!five?.modelScene) {
    return;
  }

  const floorMeshes = collectFloorMeshes();
  const selectedFloor = modelState.shownFloor;
  const floorStyle = modelState.floorStyle;

  floorMeshes.forEach(({ object, floorIndex, materials }) => {
    rememberObjectPresentation(object);
    restoreObjectPresentation(object);

    materials.forEach((material) => {
      rememberMaterialPresentation(material);
      restoreMaterialPresentation(material);
    });

    if (selectedFloor === null) {
      return;
    }

    const isSelected = floorIndex === selectedFloor;
    if (floorStyle === "VISIBILITY") {
      object.visible = isSelected;
      return;
    }

    object.visible = true;
    if (!isSelected) {
      materials.forEach((material) => {
        material.transparent = true;
        material.opacity = NON_SELECTED_FLOOR_OPACITY;
        material.depthWrite = false;
        material.needsUpdate = true;
      });
    }
  });
}

function scheduleCustomFloorPresentation() {
  if (!five?.modelScene) {
    return;
  }

  const applyAndRefresh = () => {
    applyCustomFloorPresentation();
    five.modelScene.needsRender = true;
    five.needsRender = true;
    if (typeof five.refresh === "function") {
      five.refresh();
    }
  };

  applyAndRefresh();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      applyAndRefresh();
    });
  });
}

function syncModelScene({ resetShownFloor = false } = {}) {
  if (!five?.modelScene) {
    return;
  }

  five.modelScene.parameter.set({
    floorStyle: modelState.floorStyle,
    shownFloorIndex: resetShownFloor || modelState.shownFloor === null ? -1 : modelState.shownFloor,
  });
  five.modelScene.needsRender = true;
  five.needsRender = true;
  if (typeof five.refresh === "function") {
    five.refresh();
  }
  scheduleCustomFloorPresentation();
  publishDebugState();
}

function renderModelPanel() {
  if (!modelState.floors.length) {
    setModelPanelVisibility(false);
    return;
  }

  renderSegmentedButtons(
    modelFloorsEl,
    [
      { value: "all", label: "全部" },
      ...modelState.floors.map((item) => ({
        value: String(item),
        label: `${item + 1}F`,
      })),
    ],
    modelState.shownFloor === null ? "all" : String(modelState.shownFloor),
    (value) => {
      modelState.shownFloor = value === "all" ? null : Number(value);
      renderModelPanel();
      if (currentMode === VIEW_MODES.Model) {
        syncModelScene();
        setStatus(describeModelStatus());
      }
    },
  );

  renderSegmentedButtons(
    modelFloorStyleEl,
    [
      { value: "OPACITY", label: "半透" },
      { value: "VISIBILITY", label: "隐藏" },
    ],
    modelState.floorStyle,
    (value) => {
      modelState.floorStyle = value;
      renderModelPanel();
      if (currentMode === VIEW_MODES.Model) {
        syncModelScene();
        setStatus(describeModelStatus());
      }
    },
  );

  setModelPanelVisibility(true);
  publishDebugState();
}

function resetModelPanelState() {
  modelState.shownFloor = null;
  modelState.floorStyle = "OPACITY";
}

function reloadModelPanel({ resetSelection = false } = {}) {
  if (resetSelection) {
    resetModelPanelState();
  }

  setModelPanelVisibility(false);
  modelFloorsEl.replaceChildren();
  modelFloorStyleEl.replaceChildren();
  renderModelPanel();
}

function markActiveMode(mode) {
  currentMode = mode;
  const activeKey = getModeButtonKey(mode);
  Object.entries(modeButtons).forEach(([name, button]) => {
    button.classList.toggle("button--primary", name === activeKey);
  });
  publishDebugState();
}

function syncModeUIFromFiveState(state) {
  if (!state || currentMode === VIEW_MODES.Floorplan) {
    publishDebugState();
    return;
  }

  const actualMode = state.mode;
  const sameMode = getModeButtonKey(actualMode) === getModeButtonKey(currentMode);
  if (sameMode) {
    publishDebugState();
    return;
  }

  lastThreeDMode = actualMode;

  if (isModelViewMode(actualMode)) {
    setFloorplanVisibility(false);
    markActiveMode(VIEW_MODES.Model);
    renderModelPanel();
    syncModelScene();
    setStatus(describeModelStatus());
    return;
  }

  if (isPanoramaMode(actualMode)) {
    setFloorplanVisibility(false);
    setModelPanelVisibility(false);
    markActiveMode(VIEW_MODES.Panorama);
    syncModelScene({ resetShownFloor: true });
    setStatus("当前模式: 全景（高清全景）");
    return;
  }

  setFloorplanVisibility(false);
  setModelPanelVisibility(false);
  markActiveMode(actualMode);
  setStatus(`当前模式: ${getModeLabel(actualMode)}`);
}

function attachFiveEventBridge() {
  if (!five || typeof five.on !== "function") {
    return;
  }

  five.on("currentStateChange", (state) => {
    syncModeUIFromFiveState(state);
  });

  five.on("modeChange", (_mode, _prevMode, _panoIndex, state) => {
    syncModeUIFromFiveState(state);
  });
}

async function switchMode(mode) {
  const previousMode = currentMode;

  if (mode === VIEW_MODES.Floorplan) {
    if (!floorplanState.floors.length) {
      return;
    }
    setModelPanelVisibility(false);
    syncModelScene({ resetShownFloor: true });
    renderFloorplanPanel();
    markActiveMode(VIEW_MODES.Floorplan);
    setStatus("当前模式: Floorplan（原网页户型图）");
    return;
  }

  setFloorplanVisibility(false);
  setModelPanelVisibility(false);

  if (!five) {
    return;
  }

  setStatus(`正在切换到${getModeLabel(mode)}模式...`);

  try {
    const nextState = mode === VIEW_MODES.Model ? buildModelViewState() : undefined;
    await five.changeMode(mode, nextState);
    lastThreeDMode = mode;
    markActiveMode(mode);
    if (mode === VIEW_MODES.Model) {
      reloadModelPanel({
        resetSelection: isPanoramaMode(previousMode),
      });
      syncModelScene();
      setStatus(describeModelStatus());
      return;
    }

    syncModelScene({ resetShownFloor: true });
    setStatus(
      mode === VIEW_MODES.Panorama
        ? "当前模式: 全景（高清全景）"
        : `当前模式: ${getModeLabel(mode)}`,
    );
  } catch (error) {
    console.error(error);
    setStatus(`切换模式失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function bundleBaseURL(id) {
  return new URL(`../../offline_bundles/${encodeURIComponent(id)}/`, window.location.href);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`请求失败 ${response.status}: ${url}`);
  }
  return response.json();
}

async function loadBundle(id) {
  const baseUrl = bundleBaseURL(id);
  const workUrl = new URL("./work.json", baseUrl);
  const metaUrl = new URL("./meta.json", baseUrl);

  bundleIdEl.textContent = id;
  setStatus("正在读取离线 bundle...");

  const [meta, rawWork] = await Promise.all([
    fetchJson(metaUrl),
    fetchJson(workUrl),
  ]);
  const resolvedWork = absolutizeBundlePaths(rawWork, baseUrl);
  modelState = buildModelState(resolvedWork);
  floorplanState = buildFloorplanState(resolvedWork);

  bundleTitleEl.textContent = meta.title || resolvedWork.title || id;
  metaTextEl.textContent = JSON.stringify(meta, null, 2);

  modeAvailability = {
    Model: Boolean(resolvedWork.model?.file_url),
    Panorama: Boolean(resolvedWork.panorama?.count || resolvedWork.observers?.length),
    Floorplan: floorplanState.floors.length > 0,
  };
  setModeAvailability(modeAvailability);
  const initialMode = pickInitialMode(modeAvailability);

  const work = parseWork(resolvedWork);

  five = new Five({
    backgroundColor: 0xf1ebdf,
    backgroundAlpha: 1,
    antialias: true,
    poweredByRealsee: false,
  });

  five.appendTo(viewerRootEl);
  attachFiveEventBridge();
  window.addEventListener("resize", () => five && five.refresh(), false);
  window.__offlineFive = five;
  publishDebugState();

  setStatus("正在载入如视空间...");
  await five.load(work, { mode: initialMode });
  await five.ready();

  lastThreeDMode = initialMode;
  markActiveMode(initialMode);
  syncModelScene({ resetShownFloor: initialMode !== VIEW_MODES.Model });

  if (initialMode === VIEW_MODES.Model) {
    reloadModelPanel();
    setStatus(describeModelStatus());
    return;
  }

  setModelPanelVisibility(false);
  setStatus(
    initialMode === VIEW_MODES.Panorama
      ? "离线空间已加载，当前为高清全景模式"
      : modeAvailability.Floorplan
        ? "离线空间已加载"
        : "离线空间已加载，户型模式已禁用",
  );
}

async function main() {
  if (!bundleId) {
    bundleIdEl.textContent = "未提供";
    bundleTitleEl.textContent = "请通过 ?bundle=<id> 指定 bundle";
    metaTextEl.textContent = "示例: /viewer/realsee_offline/index.html?bundle=BgxP9keL4ql3RNnl";
    setStatus("缺少 bundle 参数");
    setModeAvailability({ Model: false, Panorama: false, Floorplan: false });
    return;
  }

  try {
    await loadBundle(bundleId);
  } catch (error) {
    console.error(error);
    bundleTitleEl.textContent = "加载失败";
    metaTextEl.textContent = error instanceof Error ? error.stack || error.message : String(error);
    setStatus(`加载失败: ${error instanceof Error ? error.message : String(error)}`);
    setModeAvailability({ Model: false, Panorama: false, Floorplan: false });
  }
}

modeButtons.Model.addEventListener("click", () => switchMode(VIEW_MODES.Model));
modeButtons.Panorama.addEventListener("click", () => switchMode(VIEW_MODES.Panorama));
modeButtons.Floorplan.addEventListener("click", () => switchMode(VIEW_MODES.Floorplan));

setModeAvailability({ Model: false, Panorama: false, Floorplan: false });
main();
