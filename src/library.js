import * as dat from 'three/examples/jsm/libs/lil-gui.module.min.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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

// Raycast / BufferGeometry prototype extensions
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

// Global variables
let scene, camera, renderer, controls;
let targetMesh = null;
let material = false;

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
  // 1) center() : Move model center near (0,0,0)
  geometry.center();

  // 2) Calculate bounding sphere -> adjust radius to 1
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) {
    const radius = geometry.boundingSphere.radius;
    const scaleFactor = 1 / radius; // Scale to make radius 1
    geometry.scale(scaleFactor, scaleFactor, scaleFactor);
  }
}

function fitCameraToObject(camera, object, offset = 2) {
  // Ensure object's World Matrix is up to date
  object.updateWorldMatrix(true, false);

  // Get bounding box
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  // Get maximum dimension
  const maxDim = Math.max(size.x, size.y, size.z);

  // Convert camera FOV to radians
  const fov = camera.fov * (Math.PI / 180);
  // Calculate distance to fit model
  let cameraDistance = maxDim / 2 / Math.tan(fov / 2) * offset;
  camera.position.set(center.x, center.y, center.z - cameraDistance);
    
  // Look at model center
  camera.lookAt(center);

  // If OrbitControls exists, set target to model center
  if (controls) {
    controls.target.copy(center);
    controls.update();
  }
}

// ----------------------------------------------------------------
//    STL geometry setup function (called on STL upload)
// ----------------------------------------------------------------
export function setTargetMeshGeometry(geometry) {
  // Remove existing targetMesh
  if (targetMesh) {
    targetMesh.geometry.dispose();
    targetMesh.material.dispose();
    scene.remove(targetMesh);
    targetMesh = null;
  }

  // (1) Center align and normalize scale of STL geometry
  centerAndScaleGeometry(geometry);

  // (2) Additional processing
  geometry.deleteAttribute('uv');
  geometry = BufferGeometryUtils.mergeVertices(geometry);
  geometry.computeVertexNormals();
  geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
  geometry.attributes.normal.setUsage(THREE.DynamicDrawUsage);
  geometry.computeBoundsTree({ setBoundingBox: false });

  // (3) Create new mesh
  targetMesh = new THREE.Mesh(geometry, material);
  targetMesh.frustumCulled = false;
  scene.add(targetMesh);

  // (4) Adjust camera and controls after model is placed in scene
  fitCameraToObject(camera, targetMesh);
}

// ----------------------------------------------------------------
//                     STL loader & drag-and-drop
// ----------------------------------------------------------------
const stlLoader = new STLLoader();

// Cancel default event when file enters drag area
window.addEventListener('dragover', e => {
  e.preventDefault();
}, false);

// Load STL file on drop event
window.addEventListener('drop', e => {
  e.preventDefault();

  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    const file = e.dataTransfer.files[0];
    const reader = new FileReader();

    reader.addEventListener('load', event => {
      // Parse STL from arrayBuffer
      const arrayBuffer = event.target.result;
      const geometry = stlLoader.parse(arrayBuffer);

      const positionAttr = geometry.getAttribute('position');
      if (!positionAttr) {
        throw new Error('BufferGeometry has no position attribute.');
      }
      const positions = positionAttr.array; // Float32Array

      const indices = [];
      // positions.length is (vertex count * 3), so actual vertex count = positions.length / 3
      for (let i = 0; i < positions.length / 3; i += 3) {
        indices.push(i, i + 1, i + 2);
      }

      // Create new BufferGeometry
      let newGeometry = new THREE.BufferGeometry();

      // Register position attribute (3 per -> x, y, z)
      newGeometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(positions, 3)
      );

      // Set indices
      newGeometry.setIndex(
        new THREE.Uint32BufferAttribute(indices, 1)
      );

      // Setup STL geometry
      setTargetMeshGeometry(newGeometry);
    }, false);

    // Read binary STL
    reader.readAsArrayBuffer(file);
  }
}, false);

function init() {
  const bgColor = 0x060609;

  // renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(bgColor, 1);
  renderer.outputEncoding = THREE.sRGBEncoding;
  document.body.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = 'none';

  // scene
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x263238 / 2, 20, 60);

  // light
  const light = new THREE.DirectionalLight(0xffffff, 0.5);
  light.position.set(1, 1, 1);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));

  // camera
  camera = new THREE.PerspectiveCamera(
    75, window.innerWidth / window.innerHeight, 0.1, 50
  );
  camera.position.set(0, 0, 3);
  camera.far = 100;
  camera.updateProjectionMatrix();

  // Initialize OrbitControls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; // Smooth movement
  controls.dampingFactor = 0.05;
  controls.screenSpacePanning = false;
  controls.minDistance = 1;
  controls.maxDistance = 10;
  controls.maxPolarAngle = Math.PI; // Allow full rotation
  controls.update();

  // matcaps
  matcaps['Clay'] = new THREE.TextureLoader().load('textures/B67F6B_4B2E2A_6C3A34_F3DBC6-256px.png');
  matcaps['Red Wax'] = new THREE.TextureLoader().load('textures/763C39_431510_210504_55241C-256px.png');
  matcaps['Shiny Green'] = new THREE.TextureLoader().load('textures/3B6E10_E3F2C3_88AC2E_99CE51-256px.png');
  matcaps['Normal'] = new THREE.TextureLoader().load('textures/7877EE_D87FC5_75D9C7_1C78C0-256px.png');

  material = new THREE.MeshMatcapMaterial({
    flatShading: params.flatShading,
    side: THREE.DoubleSide,
  });

  for (const key in matcaps) {
    matcaps[key].encoding = THREE.sRGBEncoding;
  }

  // GUI
  const gui = new dat.GUI();
  gui.add(params, 'matcap', Object.keys(matcaps));
  gui.open();

  // Event listeners
  window.addEventListener('resize', onWindowResize, false);
  function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // Add dental chart UI
  createDentalChartUI();
  
  // Initialize model selection functionality
  initModelSelection(stlLoader, setTargetMeshGeometry);
}

function render() {
  requestAnimationFrame(render);

  // Update OrbitControls (apply in next frame)
  if (controls) {
    controls.update();
  }

  material.matcap = matcaps[params.matcap];
  renderer.render(scene, camera);
}

init();
render();