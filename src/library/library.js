// main.js

import * as dat from 'three/examples/jsm/libs/lil-gui.module.min.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh';

// Import UI modules
import { createDentalChartUI } from './dentalChartUI.js';
import { initModelSelection } from './modelSelectionUI.js';
import { initToothPlacement, addPlacedTooth } from './toothPlacementUI.js';

// Raycast / BufferGeometry prototype extensions
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

// Global variables
let scene, camera, renderer, controls, transformControls;
let targetMesh = null;
let material = false;
let placedTeeth = [];

// Sculpt parameters
const params = {
  matcap: 'Clay',
  flatShading: false,
};

// matcaps
const matcaps = {};

// ----------------------------------------------------------------
//    1) Geometry center alignment + scale normalization
// ----------------------------------------------------------------
function centerAndScaleGeometry(geometry) {
  geometry.center();
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) {
    const radius = geometry.boundingSphere.radius;
    const scaleFactor = 1 / radius;
    geometry.scale(scaleFactor, scaleFactor, scaleFactor);
  }
}

function fitCameraToObject(camera, object, offset = 2) {
  object.updateWorldMatrix(true, false);
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  const cameraDistance = (maxDim / 2) / Math.tan(fov / 2) * offset;
  camera.position.set(center.x, center.y, center.z - cameraDistance);
  camera.lookAt(center);
  if (controls) {
    controls.target.copy(center);
    controls.update();
  }
}

// ----------------------------------------------------------------
//    STL geometry setup function (called on STL upload)
// ----------------------------------------------------------------
export function setTargetMeshGeometry(geometry) {
  if (targetMesh) {
    targetMesh.geometry.dispose();
    targetMesh.material.dispose();
    scene.remove(targetMesh);
    targetMesh = null;
  }

  centerAndScaleGeometry(geometry);
  geometry.deleteAttribute('uv');
  geometry = BufferGeometryUtils.mergeVertices(geometry);
  geometry.computeVertexNormals();
  geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
  geometry.attributes.normal.setUsage(THREE.DynamicDrawUsage);
  geometry.computeBoundsTree({ setBoundingBox: false });

  targetMesh = new THREE.Mesh(geometry, material);
  targetMesh.frustumCulled = false;
  scene.add(targetMesh);
  fitCameraToObject(camera, targetMesh);
}

/**
 * Place a tooth model at a specific position
 */
function placeToothModel(toothId, modelPath, position) {
  console.log(`Placing tooth ${toothId} at position:`, position);
  const loader = new STLLoader();

  // loading overlay
  const loadingMessage = document.createElement('div');
  loadingMessage.id = 'placement-loading';
  loadingMessage.style.cssText = `
    position: fixed; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0,0,0,0.7);
    color: #fff; padding: 20px; border-radius: 10px;
    z-index: 2000;
  `;
  loadingMessage.innerHTML = `
    <div class="loading-spinner"></div>
    <p>${toothId}번 치아 모델을 배치 중입니다...</p>
  `;
  document.body.appendChild(loadingMessage);

  loader.load(
    modelPath,
    (geometry) => {
      /*** geometry processing ***/
      const posAttr = geometry.getAttribute('position');
      if (!posAttr) {
        console.error('No position attribute.');
        loadingMessage.remove();
        return;
      }
      const positions = posAttr.array;
      const indices = [];
      for (let i = 0; i < positions.length / 3; i += 3) {
        indices.push(i, i + 1, i + 2);
      }

      let newGeometry = new THREE.BufferGeometry();
      newGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      newGeometry.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
      newGeometry.deleteAttribute('uv');
      newGeometry = BufferGeometryUtils.mergeVertices(newGeometry);
      newGeometry.computeVertexNormals();
      newGeometry.computeBoundingSphere();
      if (newGeometry.boundingSphere) {
        const radius = newGeometry.boundingSphere.radius;
        newGeometry.scale(0.2 / radius, 0.2 / radius, 0.2 / radius);
      }
      newGeometry.center();
      newGeometry.computeBoundingBox();

      const toothMaterial = new THREE.MeshMatcapMaterial({
        flatShading: params.flatShading,
        side: THREE.DoubleSide,
        matcap: matcaps[params.matcap]
      });

      const toothMesh = new THREE.Mesh(newGeometry, toothMaterial);
      toothMesh.position.copy(position);
      toothMesh.userData = { type: 'placedTooth', toothId, modelPath };

      scene.add(toothMesh);
      placedTeeth.push(toothMesh);
      addPlacedTooth(toothMesh);

      // attach transform controls
      transformControls.attach(toothMesh);

      // create the UI for transform controls
      createTransformUI();

      loadingMessage.remove();
      showSuccessMessage(toothId);
    },
    (xhr) => console.log(`${(xhr.loaded / xhr.total * 100).toFixed(1)}% loaded`),
    (error) => {
      console.error('STL load error:', error);
      loadingMessage.remove();
      alert(`모델을 로드할 수 없습니다: ${modelPath}`);
    }
  );
}

/**
 * Show placement success toast
 */
function showSuccessMessage(toothId) {
  const msg = document.createElement('div');
  msg.style.cssText = `
    position: fixed; top: 20px; left: 50%;
    transform: translateX(-50%);
    background: rgba(76,175,80,0.9);
    color: #fff; padding: 12px 20px;
    border-radius: 8px; font-weight: bold;
    z-index: 2000; transition: opacity 0.5s;
  `;
  msg.textContent = `${toothId}번 치아가 성공적으로 배치되었습니다.`;
  document.body.appendChild(msg);
  setTimeout(() => {
    msg.style.opacity = '0';
    setTimeout(() => msg.remove(), 500);
  }, 3000);
}

/**
 * Create UI buttons for TransformControls with custom uniform scaling
 */
function createTransformUI() {
  if (document.getElementById('transform-ui')) return;

  const ui = document.createElement('div');
  ui.id = 'transform-ui';
  ui.style.cssText = `
    position: fixed;
    top: 10px; right: 10px;
    z-index: 1100;
    background: rgba(255,255,255,0.8);
    padding: 8px;
    border-radius: 4px;
  `;
  
  // Create the basic transform UI buttons
  ui.innerHTML = `
    <button id="translate-btn">Move</button>
    <button id="rotate-btn">Rotate</button>
    <div id="scale-ui" style="margin-top: 8px; padding: 10px; background: rgba(0,0,0,0.05); border-radius: 4px;">
      <label>Uniform Scale: <span id="scale-value">1.00</span></label>
      <div style="display: flex; margin-top: 5px;">
        <button id="scale-down-btn" style="flex: 1; margin-right: 4px;">-</button>
        <button id="scale-up-btn" style="flex: 1;">+</button>
      </div>
      <input type="range" id="scale-slider" min="0.1" max="3" step="0.01" value="1" style="width: 100%; margin-top: 5px;">
    </div>
    <button id="detach-btn" style="margin-top: 8px; width: 100%;">Done</button>
  `;
  
  document.body.appendChild(ui);

  // Get the currently attached object
  const getActiveObject = () => transformControls.object;
  
  // Store original scale for reset
  let originalScale = new THREE.Vector3(1, 1, 1);
  let currentScale = 1;
  
  // Save initial scale when control is attached
  transformControls.addEventListener('objectChange', () => {
    const object = getActiveObject();
    if (object && !object.userData.initialScale) {
      object.userData.initialScale = object.scale.clone();
      originalScale = object.scale.clone();
      currentScale = 1;
      document.getElementById('scale-value').textContent = currentScale.toFixed(2);
      document.getElementById('scale-slider').value = currentScale;
    }
  });

  // Apply uniform scaling
  function applyUniformScale(newScaleFactor) {
    const object = getActiveObject();
    if (!object) return;
    
    // Make sure we have the initial scale saved
    if (!object.userData.initialScale) {
      object.userData.initialScale = object.scale.clone();
      originalScale = object.scale.clone();
    }
    
    // Apply scaling uniformly to all axes
    object.scale.set(
      originalScale.x * newScaleFactor,
      originalScale.y * newScaleFactor,
      originalScale.z * newScaleFactor
    );
    
    // Update UI
    currentScale = newScaleFactor;
    document.getElementById('scale-value').textContent = newScaleFactor.toFixed(2);
    document.getElementById('scale-slider').value = newScaleFactor;
  }
  
  // Set up event listeners
  document.getElementById('translate-btn')
    .addEventListener('click', () => transformControls.setMode('translate'));
    
  document.getElementById('rotate-btn')
    .addEventListener('click', () => transformControls.setMode('rotate'));
    
  // Scale buttons
  document.getElementById('scale-down-btn')
    .addEventListener('click', () => {
      const newScale = Math.max(0.1, currentScale - 0.01);
      applyUniformScale(newScale);
    });
    
  document.getElementById('scale-up-btn')
    .addEventListener('click', () => {
      const newScale = Math.min(3, currentScale + 0.01);
      applyUniformScale(newScale);
    });
    
  // Scale slider
  document.getElementById('scale-slider')
    .addEventListener('input', (e) => {
      const newScale = parseFloat(e.target.value);
      applyUniformScale(newScale);
    });
  
  document.getElementById('detach-btn')
    .addEventListener('click', () => {
      transformControls.detach();
      ui.remove();
    });
}

// This function disables the scale gizmo in TransformControls
function disableScaleMode() {
  // Override the setMode method to prevent 'scale' mode
  const originalSetMode = TransformControls.prototype.setMode;
  TransformControls.prototype.setMode = function(mode) {
    if (mode === 'scale') {
      // Instead of entering scale mode, just stay in the current mode
      // and notify the user that custom scaling should be used
      console.log('Standard scale mode disabled. Please use the uniform scale controls.');
      return;
    }
    // Call the original method for other modes
    originalSetMode.call(this, mode);
  };
}

// ----------------------------------------------------------------
// STL drag-and-drop loader (unchanged)
// ----------------------------------------------------------------
const stlLoader = new STLLoader();
window.addEventListener('dragover', e => e.preventDefault(), false);
window.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer.files.length) {
    const file = e.dataTransfer.files[0];
    const reader = new FileReader();
    reader.onload = (ev) => {
      const geom = stlLoader.parse(ev.target.result);
      if (!geom.getAttribute('position')) {
        throw new Error('No position attribute.');
      }
      const pos = geom.getAttribute('position').array;
      const idx = [];
      for (let i = 0; i < pos.length / 3; i += 3) idx.push(i, i + 1, i + 2);
      const newG = new THREE.BufferGeometry();
      newG.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      newG.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
      setTargetMeshGeometry(newG);
    };
    reader.readAsArrayBuffer(file);
  }
}, false);

// ----------------------------------------------------------------
// Initialization and render loop
// ----------------------------------------------------------------
function init() {
  const bgColor = 0x060609;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(bgColor, 1);
  renderer.outputEncoding = THREE.sRGBEncoding;
  document.body.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = 'none';

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x263238 / 2, 20, 60);
  scene.add(new THREE.DirectionalLight(0xffffff, 0.5));
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 50);
  camera.position.set(0, 0, 3);
  camera.far = 100;
  camera.updateProjectionMatrix();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.screenSpacePanning = false;
  controls.minDistance = 1;
  controls.maxDistance = 10;
  controls.maxPolarAngle = Math.PI;
  controls.update();

  // TransformControls helper only; UI created per-tooth
  transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.addEventListener('mouseDown', () => controls.enabled = false);
  transformControls.addEventListener('mouseUp',   () => controls.enabled = true);
  scene.add(transformControls.getHelper());
  
  // Disable standard scale mode
  disableScaleMode();

  // matcaps setup
  matcaps['Clay']        = new THREE.TextureLoader().load('textures/B67F6B_4B2E2A_6C3A34_F3DBC6-256px.png');
  matcaps['Red Wax']     = new THREE.TextureLoader().load('textures/763C39_431510_210504_55241C-256px.png');
  matcaps['Shiny Green'] = new THREE.TextureLoader().load('textures/3B6E10_E3F2C3_88AC2E_99CE51-256px.png');
  matcaps['Normal']      = new THREE.TextureLoader().load('textures/7877EE_D87FC5_75D9C7_1C78C0-256px.png');

  material = new THREE.MeshMatcapMaterial({
    flatShading: params.flatShading,
    side: THREE.DoubleSide,
  });
  for (const key in matcaps) matcaps[key].encoding = THREE.sRGBEncoding;

  const gui = new dat.GUI();
  gui.add(params, 'matcap', Object.keys(matcaps))
  gui.open()

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }, false);

  createDentalChartUI();
  initModelSelection(stlLoader, setTargetMeshGeometry);
  initToothPlacement(scene, camera, renderer, controls);

  window.placeToothModel = placeToothModel;
}

function render() {
  requestAnimationFrame(render);
  controls.update();
  transformControls.update && transformControls.update();

  if (targetMesh) targetMesh.material.matcap = matcaps[params.matcap];
  placedTeeth.forEach(tooth => {
    tooth.material.matcap = matcaps[params.matcap];
  });

  renderer.render(scene, camera);
}

init();
render();