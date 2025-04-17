// toothPlacementUI.js

import * as THREE from 'three';
import { highlightSelectedTooth } from './dentalChartUI.js';

/**
 * Module-level state
 */
let scene, camera, renderer, controls;
let placementActive = false;
let selectedToothId = null;
let selectedModelPath = null;
let placementPoints = [];
let placementMarkers = [];
let placedTeeth = [];
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();

/**
 * Initialize tooth placement functionality
 * @param {THREE.Scene} sceneObj
 * @param {THREE.Camera} cameraObj
 * @param {THREE.WebGLRenderer} rendererObj
 * @param {OrbitControls} controlsObj
 */
export function initToothPlacement(sceneObj, cameraObj, rendererObj, controlsObj) {
  scene    = sceneObj;
  camera   = cameraObj;
  renderer = rendererObj;
  controls = controlsObj;

  // Add CSS for placement UI
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    #placement-ui {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: white;
      border-radius: 10px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      padding: 15px;
      z-index: 1200;
      display: none;
      width: 350px;
    }
    #placement-status {
      margin-bottom: 10px;
      text-align: center;
      font-weight: bold;
      color: #333;
    }
    #placement-instructions {
      margin-bottom: 15px;
      text-align: center;
      color: #555;
    }
    .placement-buttons {
      display: flex;
      gap: 10px;
      justify-content: center;
    }
    .placement-button {
      padding: 8px 16px;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      font-weight: bold;
      transition: background-color 0.2s;
    }
    #confirm-placement-btn {
      background-color: #4caf50;
      color: white;
    }
    #confirm-placement-btn:hover {
      background-color: #45a049;
    }
    #confirm-placement-btn:disabled {
      background-color: #a5d6a7;
      cursor: not-allowed;
    }
    #cancel-placement-btn {
      background-color: #f5f5f5;
      color: #333;
    }
    #cancel-placement-btn:hover {
      background-color: #e0e0e0;
    }
  `;
  document.head.appendChild(styleEl);

  // Create the placement UI container
  const placementUI = document.createElement('div');
  placementUI.id = 'placement-ui';
  placementUI.innerHTML = `
    <div id="placement-status">치아 위치 선정</div>
    <div id="placement-instructions">빈 공간의 양쪽 치아 위치를 클릭하세요</div>
    <div class="placement-buttons">
      <button id="confirm-placement-btn" class="placement-button" disabled>확인</button>
      <button id="cancel-placement-btn"  class="placement-button">취소</button>
    </div>
  `;
  document.body.appendChild(placementUI);

  // Wire up buttons
  document.getElementById('confirm-placement-btn').addEventListener('click', confirmPlacement);
  document.getElementById('cancel-placement-btn').addEventListener('click', cancelPlacement);

  // Listen for clicks in the 3D canvas
  renderer.domElement.addEventListener('click', onMouseClick);
}

/**
 * Begin placement for a specific tooth
 * @param {string} toothId 
 * @param {string} modelPath 
 */
export function startToothPlacement(toothId, modelPath) {
  placementActive   = true;
  selectedToothId   = toothId;
  selectedModelPath = modelPath;
  placementPoints   = [];

  clearPlacementMarkers();
  highlightSelectedTooth(toothId);

  const ui          = document.getElementById('placement-ui');
  const instr       = document.getElementById('placement-instructions');
  const confirmBtn  = document.getElementById('confirm-placement-btn');

  ui.style.display = 'block';
  confirmBtn.disabled = true;

  // Tailor instructions for molars vs. other teeth
  if (['17','27','37','47'].includes(toothId)) {
    instr.textContent = '치아 중심 위치를 클릭하세요';
  } else {
    instr.textContent = '두 지점을 클릭하세요 (중앙에 배치됩니다)';
  }
}

/**
 * Handle clicks in the Three.js canvas during placement
 */
function onMouseClick(event) {
  if (!placementActive) return;

  // Convert to normalized device coords
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left)/rect.width)*2 - 1;
  mouse.y = -((event.clientY - rect.top)/rect.height)*2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // Check if click is on an existing marker
  const markerIntersects = raycaster.intersectObjects(placementMarkers);
  if (markerIntersects.length > 0) {
    // Remove clicked marker
    const clickedMarker = markerIntersects[0].object;
    const markerIndex = placementMarkers.indexOf(clickedMarker);
    if (markerIndex !== -1) {
      // Remove from scene and arrays
      scene.remove(clickedMarker);
      clickedMarker.geometry.dispose();
      clickedMarker.material.dispose();
      placementMarkers.splice(markerIndex, 1);
      placementPoints.splice(markerIndex, 1);
      
      // Update UI
      const isMolar = ['17','27','37','47'].includes(selectedToothId);
      const needed  = isMolar ? 1 : 2;
      const instr   = document.getElementById('placement-instructions');
      const confirmBtn = document.getElementById('confirm-placement-btn');
      
      confirmBtn.disabled = placementPoints.length < needed;
      
      if (placementPoints.length === 0) {
        instr.textContent = isMolar
          ? '치아 중심 위치를 클릭하세요'
          : '두 지점을 클릭하세요 (중앙에 배치됩니다)';
      } else if (!isMolar && placementPoints.length === 1) {
        instr.textContent = '두 번째 지점을 클릭하세요.';
      }
      
      return;
    }
  }

  // Find the jaw mesh (the root mesh without userData.type)
  const jaw = scene.children.find(c => c.isMesh && !c.userData.type);
  if (!jaw) return;

  const hits = raycaster.intersectObject(jaw);
  if (hits.length === 0) return;

  // Check if we've reached the maximum number of markers
  const isMolar = ['17','27','37','47'].includes(selectedToothId);
  const maxMarkers = isMolar ? 1 : 2;
  if (placementPoints.length >= maxMarkers) {
    return; // Don't add more markers if we already have enough
  }

  const point = hits[0].point.clone();
  placementPoints.push(point);
  createMarker(point);

  const needed  = isMolar ? 1 : 2;
  const instr   = document.getElementById('placement-instructions');
  const confirmBtn = document.getElementById('confirm-placement-btn');

  if (placementPoints.length >= needed) {
    confirmBtn.disabled = false;
    instr.textContent = isMolar
      ? '위치 선정 완료. 확인을 클릭하세요.'
      : '두 지점 선택 완료. 확인을 클릭하세요.';
  } else if (!isMolar && placementPoints.length === 1) {
    instr.textContent = '두 번째 지점을 클릭하세요.';
  }
}

/**
 * Create a small red sphere marker at the selected point
 * @param {THREE.Vector3} pos 
 */
function createMarker(pos) {
  const geom = new THREE.SphereGeometry(0.025, 16, 16);
  const mat  = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const marker = new THREE.Mesh(geom, mat);
  marker.position.copy(pos);
  scene.add(marker);
  placementMarkers.push(marker);
}

/**
 * Remove all existing markers from the scene
 */
function clearPlacementMarkers() {
  placementMarkers.forEach(m => {
    scene.remove(m);
    m.geometry.dispose();
    m.material.dispose();
  });
  placementMarkers = [];
}

/**
 * Compute the final placement position
 */
function calculatePlacementPosition() {
  const isMolar = ['17','27','37','47'].includes(selectedToothId);
  if (isMolar) {
    return placementPoints[0].clone();
  } else {
    const mid = new THREE.Vector3();
    mid.addVectors(placementPoints[0], placementPoints[1]).multiplyScalar(0.5);
    return mid;
  }
}

/**
 * User confirms placement → calls global placeToothModel
 */
function confirmPlacement() {
  if (!placementActive) return;

  const pos = calculatePlacementPosition();
  if (window.placeToothModel) {
    window.placeToothModel(selectedToothId, selectedModelPath, pos);
  }
  cleanupPlacement();
}

/**
 * User cancels placement
 */
function cancelPlacement() {
  cleanupPlacement();
}

/**
 * Reset state and hide UI
 */
function cleanupPlacement() {
  placementActive = false;
  selectedToothId = null;
  selectedModelPath = null;
  placementPoints = [];
  clearPlacementMarkers();
  document.getElementById('placement-ui').style.display = 'none';
}

/**
 * Utility to check if placement is active
 */
export function isPlacementActive() {
  return placementActive;
}

/**
 * Optionally track placed tooth meshes
 * @param {THREE.Mesh} toothMesh 
 */
export function addPlacedTooth(toothMesh) {
  placedTeeth.push(toothMesh);
}