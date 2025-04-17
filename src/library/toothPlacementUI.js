// Tooth Placement UI module
import * as THREE from 'three';
import { highlightSelectedTooth } from './dentalChartUI.js';

// Module variables
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
 * @param {THREE.Scene} sceneObj - The Three.js scene
 * @param {THREE.Camera} cameraObj - The Three.js camera
 * @param {THREE.WebGLRenderer} rendererObj - The Three.js renderer
 * @param {OrbitControls} controlsObj - The OrbitControls
 */
export function initToothPlacement(sceneObj, cameraObj, rendererObj, controlsObj) {
  scene = sceneObj;
  camera = cameraObj;
  renderer = rendererObj;
  controls = controlsObj;
  
  // Add styles for placement UI
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    #placement-ui {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: white;
      border-radius: 10px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
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
  document.head.appendChild(styleElement);
  
  // Create UI elements
  const placementUI = document.createElement('div');
  placementUI.id = 'placement-ui';
  placementUI.innerHTML = `
    <div id="placement-status">치아 위치 선정</div>
    <div id="placement-instructions">빈 공간의 양쪽 치아 위치를 클릭하세요</div>
    <div class="placement-buttons">
      <button id="confirm-placement-btn" class="placement-button" disabled>확인</button>
      <button id="cancel-placement-btn" class="placement-button">취소</button>
    </div>
  `;
  document.body.appendChild(placementUI);
  
  // Add event listeners
  document.getElementById('confirm-placement-btn').addEventListener('click', confirmPlacement);
  document.getElementById('cancel-placement-btn').addEventListener('click', cancelPlacement);
  
  // Add mouse event listeners for 3D scene
  renderer.domElement.addEventListener('click', onMouseClick);
}

/**
 * Start tooth placement process
 * @param {string} toothId - The tooth ID being placed
 * @param {string} modelPath - The path to the tooth model
 */
export function startToothPlacement(toothId, modelPath) {
  // Reset placement state
  placementActive = true;
  selectedToothId = toothId;
  selectedModelPath = modelPath;
  placementPoints = [];
  
  // Remove any existing markers
  clearPlacementMarkers();
  
  // Highlight selected tooth in chart
  highlightSelectedTooth(toothId);
  
  // Show placement UI
  const placementUI = document.getElementById('placement-ui');
  const placementInstructions = document.getElementById('placement-instructions');
  const confirmButton = document.getElementById('confirm-placement-btn');
  
  placementUI.style.display = 'block';
  
  // Set instructions based on tooth number
  if (['17', '27', '37', '47'].includes(toothId)) {
    placementInstructions.textContent = '치아 위치의 기준점을 클릭하세요';
  } else {
    placementInstructions.textContent = '빈 공간의 양쪽 치아 위치를 클릭하세요';
  }
  
  confirmButton.disabled = true;
}

/**
 * Handle mouse click in 3D scene during placement
 * @param {Event} event - Mouse click event
 */
function onMouseClick(event) {
  if (!placementActive) return;
  
  // Calculate mouse position in normalized device coordinates (-1 to +1)
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  
  // Update the raycaster
  raycaster.setFromCamera(mouse, camera);
  
  // Find intersections with the jaw model
  const jawMesh = scene.children.find(child => 
    child.type === 'Mesh' && !child.userData.type
  );
  
  if (!jawMesh) return;
  
  const intersects = raycaster.intersectObject(jawMesh);
  
  if (intersects.length > 0) {
    const intersectionPoint = intersects[0].point;
    
    // Add point to placement points
    placementPoints.push(intersectionPoint);
    
    // Create a marker at the intersection point
    createMarker(intersectionPoint);
    
    // Check if we have enough points
    const isRearTooth = ['17', '27', '37', '47'].includes(selectedToothId);
    const requiredPoints = isRearTooth ? 1 : 2;
    
    // Update UI based on points collected
    const confirmButton = document.getElementById('confirm-placement-btn');
    const placementInstructions = document.getElementById('placement-instructions');
    
    if (placementPoints.length === requiredPoints) {
      // Enable confirm button
      confirmButton.disabled = false;
      placementInstructions.textContent = '위치 선정 완료. 확인 버튼을 클릭하세요.';
    } else if (!isRearTooth && placementPoints.length === 1) {
      placementInstructions.textContent = '두 번째 치아 위치를 클릭하세요';
    }
  }
}

/**
 * Create a visual marker at a point
 * @param {THREE.Vector3} position - The position to place the marker
 */
function createMarker(position) {
  const geometry = new THREE.SphereGeometry(0.025, 16, 16);
  const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const marker = new THREE.Mesh(geometry, material);
  
  marker.position.copy(position);
  scene.add(marker);
  placementMarkers.push(marker);
}

/**
 * Clear all placement markers from the scene
 */
function clearPlacementMarkers() {
  placementMarkers.forEach(marker => {
    scene.remove(marker);
    marker.geometry.dispose();
    marker.material.dispose();
  });
  
  placementMarkers = [];
}

/**
 * Calculate placement position based on selected points
 * @returns {THREE.Vector3} - The calculated position
 */
function calculatePlacementPosition() {
  const isRearTooth = ['17', '27', '37', '47'].includes(selectedToothId);
  
  if (isRearTooth) {
    // For rear teeth, use the single point directly
    return placementPoints[0].clone();
  } else {
    // For other teeth, calculate midpoint between two points
    const midpoint = new THREE.Vector3();
    midpoint.addVectors(placementPoints[0], placementPoints[1]);
    midpoint.multiplyScalar(0.5);
    return midpoint;
  }
}

/**
 * Confirm placement and load tooth model
 */
function confirmPlacement() {
  if (placementPoints.length === 0) return;
  
  // Calculate placement position
  const position = calculatePlacementPosition();
  
  // Call external function to load and place the model
  if (window.placeToothModel) {
    window.placeToothModel(selectedToothId, selectedModelPath, position);
  }
  
  // Clean up
  cleanupPlacement();
}

/**
 * Cancel placement
 */
function cancelPlacement() {
  cleanupPlacement();
}

/**
 * Clean up after placement
 */
function cleanupPlacement() {
  // Reset state
  placementActive = false;
  selectedToothId = null;
  selectedModelPath = null;
  placementPoints = [];
  
  // Clear markers
  clearPlacementMarkers();
  
  // Hide UI
  const placementUI = document.getElementById('placement-ui');
  placementUI.style.display = 'none';
  
  // Re-enable orbit controls
  if (controls) {
    controls.enabled = true;
  }
}

/**
 * Check if placement mode is active
 * @returns {boolean} - True if placement is active
 */
export function isPlacementActive() {
  return placementActive;
}

/**
 * Add a placed tooth to the tracking array
 * @param {THREE.Mesh} toothMesh - The placed tooth mesh
 */
export function addPlacedTooth(toothMesh) {
  placedTeeth.push(toothMesh);
}