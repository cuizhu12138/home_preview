import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

const MODEL_EXTENSIONS = [".glb", ".gltf", ".fbx", ".obj", ".ply", ".stl"];

const canvas = document.querySelector("#viewport");
const dropzone = document.querySelector("#dropzone");
const fileInput = document.querySelector("#file-input");
const folderInput = document.querySelector("#folder-input");
const modelSelect = document.querySelector("#model-select");
const loadButton = document.querySelector("#load-model");
const fitViewButton = document.querySelector("#fit-view");
const toggleGridButton = document.querySelector("#toggle-grid");
const pickFilesButton = document.querySelector("#pick-files");
const pickFolderButton = document.querySelector("#pick-folder");
const statusText = document.querySelector("#status-text");
const fileCount = document.querySelector("#file-count");
const currentModel = document.querySelector("#current-model");
const modelInfo = document.querySelector("#model-info");

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color("#efe6d8");
scene.fog = new THREE.Fog("#efe6d8", 18, 42);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(4.5, 3, 6.5);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.target.set(0, 1, 0);

const hemiLight = new THREE.HemisphereLight("#fff7ea", "#94775f", 1.7);
const keyLight = new THREE.DirectionalLight("#ffffff", 1.8);
keyLight.position.set(8, 10, 6);
const fillLight = new THREE.DirectionalLight("#d8f2f0", 0.85);
fillLight.position.set(-6, 5, -8);

const grid = new THREE.GridHelper(20, 20, "#0d6b6f", "#ab9a87");
grid.material.opacity = 0.42;
grid.material.transparent = true;

const axes = new THREE.AxesHelper(1.5);
axes.position.set(0, 0.01, 0);

const modelRoot = new THREE.Group();

scene.add(hemiLight, keyLight, fillLight, grid, axes, modelRoot);

const state = {
  files: [],
  candidates: [],
  aliasToUrl: new Map(),
  aliasToFile: new Map(),
  currentObject: null,
};

function setStatus(text) {
  statusText.textContent = text;
}

function updateRendererSize() {
  const frame = canvas.parentElement;
  const width = frame.clientWidth;
  const height = frame.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function normalizePath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function basename(path) {
  const normalized = normalizePath(path);
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function getExtension(path) {
  const name = basename(path).toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
}

function isModelFile(file) {
  return MODEL_EXTENSIONS.includes(getExtension(file.name));
}

function addAlias(map, alias, url, file) {
  const key = normalizePath(alias);
  if (!key || map.has(key)) {
    return;
  }
  map.set(key, url);
  state.aliasToFile.set(key, file);
}

function revokeAllUrls() {
  const uniqueUrls = new Set(state.aliasToUrl.values());
  for (const url of uniqueUrls) {
    URL.revokeObjectURL(url);
  }
  state.aliasToUrl.clear();
  state.aliasToFile.clear();
}

function clearSceneObject() {
  if (!state.currentObject) {
    return;
  }
  modelRoot.remove(state.currentObject);
  state.currentObject.traverse((child) => {
    if (child.geometry) {
      child.geometry.dispose();
    }
    if (Array.isArray(child.material)) {
      child.material.forEach((material) => material.dispose());
    } else if (child.material) {
      child.material.dispose();
    }
  });
  state.currentObject = null;
}

function refreshCandidateSelect() {
  modelSelect.innerHTML = "";
  if (!state.candidates.length) {
    modelSelect.innerHTML = "<option>还没有可加载的模型文件</option>";
    modelSelect.disabled = true;
    loadButton.disabled = true;
    currentModel.textContent = "无";
    return;
  }

  for (const file of state.candidates) {
    const option = document.createElement("option");
    option.value = normalizePath(file.webkitRelativePath || file.name);
    option.textContent = normalizePath(file.webkitRelativePath || file.name);
    modelSelect.appendChild(option);
  }

  modelSelect.disabled = false;
  loadButton.disabled = false;
  currentModel.textContent = basename(state.candidates[0].name);
}

function setFiles(files) {
  revokeAllUrls();
  clearSceneObject();

  state.files = Array.from(files);
  state.candidates = state.files.filter(isModelFile);
  fileCount.textContent = String(state.files.length);

  for (const file of state.files) {
    const objectUrl = URL.createObjectURL(file);
    const relative = normalizePath(file.webkitRelativePath || file.name);
    const name = normalizePath(file.name);
    const decodedRelative = decodeSafe(relative);
    const decodedName = decodeSafe(name);

    addAlias(state.aliasToUrl, relative, objectUrl, file);
    addAlias(state.aliasToUrl, decodedRelative, objectUrl, file);
    addAlias(state.aliasToUrl, `./${relative}`, objectUrl, file);
    addAlias(state.aliasToUrl, name, objectUrl, file);
    addAlias(state.aliasToUrl, decodedName, objectUrl, file);
    addAlias(state.aliasToUrl, `./${name}`, objectUrl, file);

    if (relative.includes("/")) {
      addAlias(state.aliasToUrl, basename(relative), objectUrl, file);
      addAlias(state.aliasToUrl, `./${basename(relative)}`, objectUrl, file);
    }
  }

  refreshCandidateSelect();
  modelInfo.textContent = state.files.length
    ? `已接收 ${state.files.length} 个文件。\n如果模型带外部贴图或 .bin 文件，优先使用“选择文件夹”。`
    : "加载后会在这里显示统计信息。";
  setStatus(state.candidates.length ? "文件已准备好，可以开始加载" : "没有发现可识别的模型文件");
}

function makeLoadingManager() {
  const manager = new THREE.LoadingManager();

  manager.setURLModifier((url) => {
    if (/^(blob:|data:|https?:)/i.test(url)) {
      return url;
    }

    const normalized = normalizePath(url);
    const decoded = decodeSafe(normalized);
    const candidateKeys = [
      normalized,
      decoded,
      `./${normalized}`,
      `./${decoded}`,
      basename(normalized),
      basename(decoded),
      `./${basename(normalized)}`,
      `./${basename(decoded)}`,
    ];

    for (const key of candidateKeys) {
      if (state.aliasToUrl.has(key)) {
        return state.aliasToUrl.get(key);
      }
    }

    return url;
  });

  return manager;
}

function fitCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) {
    controls.target.set(0, 0, 0);
    camera.position.set(4.5, 3, 6.5);
    controls.update();
    return;
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  const distance =
    Math.max(2.2, maxDimension / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * 1.35;

  camera.near = Math.max(distance / 100, 0.01);
  camera.far = distance * 40;
  camera.updateProjectionMatrix();

  camera.position.copy(center).add(new THREE.Vector3(distance, distance * 0.65, distance));
  controls.target.copy(center);
  controls.update();
}

function collectStats(object) {
  const stats = {
    meshes: 0,
    points: 0,
    lines: 0,
    triangles: 0,
    vertices: 0,
  };

  object.traverse((child) => {
    if (!child.geometry) {
      return;
    }

    const position = child.geometry.getAttribute("position");
    if (position) {
      stats.vertices += position.count;
    }

    if (child.isMesh) {
      stats.meshes += 1;
      if (child.geometry.index) {
        stats.triangles += child.geometry.index.count / 3;
      } else if (position) {
        stats.triangles += position.count / 3;
      }
    } else if (child.isPoints) {
      stats.points += 1;
    } else if (child.isLine || child.isLineSegments) {
      stats.lines += 1;
    }
  });

  const bounds = new THREE.Box3().setFromObject(object);
  const size = bounds.getSize(new THREE.Vector3());

  modelInfo.textContent = [
    `尺寸: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`,
    `网格数量: ${stats.meshes}`,
    `点云数量: ${stats.points}`,
    `线框数量: ${stats.lines}`,
    `顶点数: ${Math.round(stats.vertices)}`,
    `三角面数: ${Math.round(stats.triangles)}`,
  ].join("\n");
}

function createSurfaceObject(geometry, extension) {
  geometry.computeBoundingBox();
  geometry.center();

  if (extension === ".ply" && !geometry.getAttribute("normal")) {
    const material = new THREE.PointsMaterial({
      size: 0.025,
      vertexColors: Boolean(geometry.getAttribute("color")),
      color: geometry.getAttribute("color") ? "#ffffff" : "#0d6b6f",
    });
    return new THREE.Points(geometry, material);
  }

  if (!geometry.getAttribute("normal")) {
    geometry.computeVertexNormals();
  }

  const material = new THREE.MeshStandardMaterial({
    color: geometry.getAttribute("color") ? "#ffffff" : "#cab597",
    vertexColors: Boolean(geometry.getAttribute("color")),
    roughness: 0.62,
    metalness: 0.08,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geometry, material);
}

function findSiblingFile(rootFile, extension) {
  const currentPath = normalizePath(rootFile.webkitRelativePath || rootFile.name);
  const basePath = currentPath.replace(/\.[^/.]+$/, "");
  const target = `${basePath}${extension}`;

  return (
    state.aliasToFile.get(target) ||
    state.files.find((file) => normalizePath(file.webkitRelativePath || file.name) === target) ||
    null
  );
}

function loadAsync(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}

async function loadObjectFromFile(file) {
  const manager = makeLoadingManager();
  const rootKey = normalizePath(file.webkitRelativePath || file.name);
  const rootUrl = state.aliasToUrl.get(rootKey);
  const extension = getExtension(file.name);

  if (!rootUrl) {
    throw new Error("找不到模型文件的本地 URL。");
  }

  if (extension === ".glb" || extension === ".gltf") {
    const loader = new GLTFLoader(manager);
    const result = await loadAsync(loader, rootUrl);
    return result.scene || result.scenes?.[0];
  }

  if (extension === ".fbx") {
    const loader = new FBXLoader(manager);
    return loadAsync(loader, rootUrl);
  }

  if (extension === ".obj") {
    const mtlFile = findSiblingFile(file, ".mtl");
    const objLoader = new OBJLoader(manager);

    if (mtlFile) {
      const mtlUrl = state.aliasToUrl.get(normalizePath(mtlFile.webkitRelativePath || mtlFile.name));
      const mtlLoader = new MTLLoader(manager);
      const materials = await loadAsync(mtlLoader, mtlUrl);
      materials.preload();
      objLoader.setMaterials(materials);
    }

    return loadAsync(objLoader, rootUrl);
  }

  if (extension === ".ply") {
    const loader = new PLYLoader(manager);
    const geometry = await loadAsync(loader, rootUrl);
    return createSurfaceObject(geometry, extension);
  }

  if (extension === ".stl") {
    const loader = new STLLoader(manager);
    const geometry = await loadAsync(loader, rootUrl);
    return createSurfaceObject(geometry, extension);
  }

  throw new Error(`暂不支持加载 ${extension} 格式。`);
}

async function loadSelectedModel() {
  if (!state.candidates.length) {
    setStatus("请先选择模型文件");
    return;
  }

  const selectedPath = normalizePath(modelSelect.value);
  const selectedFile = state.aliasToFile.get(selectedPath);

  if (!selectedFile) {
    setStatus("没有找到选中的模型文件");
    return;
  }

  setStatus("正在加载模型...");
  currentModel.textContent = basename(selectedFile.name);
  clearSceneObject();

  try {
    const object = await loadObjectFromFile(selectedFile);
    object.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    modelRoot.add(object);
    state.currentObject = object;
    fitCameraToObject(object);
    collectStats(object);
    setStatus("模型加载完成");
  } catch (error) {
    console.error(error);
    modelInfo.textContent = `加载失败:\n${error instanceof Error ? error.message : String(error)}`;
    setStatus("模型加载失败");
  }
}

function animate() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dropzone--active");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dropzone--active");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dropzone--active");
  if (event.dataTransfer?.files?.length) {
    setFiles(event.dataTransfer.files);
  }
});

pickFilesButton.addEventListener("click", () => fileInput.click());
pickFolderButton.addEventListener("click", () => folderInput.click());
loadButton.addEventListener("click", loadSelectedModel);
fitViewButton.addEventListener("click", () => {
  if (state.currentObject) {
    fitCameraToObject(state.currentObject);
  }
});

toggleGridButton.addEventListener("click", () => {
  grid.visible = !grid.visible;
  axes.visible = grid.visible;
  toggleGridButton.classList.toggle("button--active", grid.visible);
});

modelSelect.addEventListener("change", () => {
  currentModel.textContent = basename(modelSelect.value);
});

fileInput.addEventListener("change", () => {
  setFiles(fileInput.files || []);
});

folderInput.addEventListener("change", () => {
  setFiles(folderInput.files || []);
});

window.addEventListener("resize", updateRendererSize);

updateRendererSize();
animate();
