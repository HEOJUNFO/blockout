import Stats from 'three/examples/jsm/libs/stats.module.js';
import * as dat from 'three/examples/jsm/libs/lil-gui.module.min.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

let stats, scene, camera, renderer, controls;
let targetMesh = null;
let undercutMesh = null; 
let material;
let savedCameraState = null;  // 카메라 상태 저장 변수
let detectCount = 0;          // 언더컷 감지 호출 횟수를 추적

const params = {
  matcap: 'Clay',
  displayHelper: false,
  detectUndercuts: false,
  blockout: false,
};

const matcaps = {};

const stlLoader = new STLLoader();
const gui = new dat.GUI();

// STL 파일 로드 및 처리
function setTargetMeshGeometry(geometry) {
  if (targetMesh) {
    scene.remove(targetMesh);
    targetMesh.geometry.dispose();
  }
  geometry.center();
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) {
    const radius = geometry.boundingSphere.radius;
    geometry.scale(1 / radius, 1 / radius, 1 / radius);
  }
  geometry.computeVertexNormals();
  targetMesh = new THREE.Mesh(geometry, material);
  scene.add(targetMesh);
}

// 언더컷 감지 기능
function detectUndercuts() {
  if (!targetMesh) return;
  
  // 처음 호출 시 카메라 상태 저장
  if (!savedCameraState) {
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    savedCameraState = {
      position: camera.position.clone(),
      target: controls.target.clone(),
      quaternion: camera.quaternion.clone(),
      direction: direction.clone()  // 감지 당시의 카메라 시선 저장
    };
    console.log('Camera state saved:', savedCameraState);
  }
  
  // 기존 언더컷 메쉬 제거
  if (undercutMesh) {
    scene.remove(undercutMesh);
    undercutMesh.geometry.dispose();
    undercutMesh.material.dispose();
    undercutMesh = null;
  }
  
  targetMesh.updateMatrixWorld(true);
  const geometry = targetMesh.geometry;
  const posAttr = geometry.attributes.position;
  const indexAttr = geometry.index;
  const matrixWorld = targetMesh.matrixWorld;
  const cameraPos = camera.position;
  
  const undercutPositions = [];
  const undercutNormals = [];
  
  let triangleCount;
  if (indexAttr) {
    triangleCount = indexAttr.count / 3;
  } else {
    triangleCount = posAttr.count / 3;
  }
  
  // 첫 호출은 dot <= 0.01, 두번째부터는 dot <= 0.0 조건 사용
  const threshold = (detectCount === 0) ? 0.01 : 0.0;
  
  // 각 삼각형의 법선과 카메라 시선 방향을 비교하여 언더컷 면을 검출합니다.
  for (let i = 0; i < triangleCount; i++) {
    let a, b, c;
    if (indexAttr) {
      const aIndex = indexAttr.getX(i * 3);
      const bIndex = indexAttr.getX(i * 3 + 1);
      const cIndex = indexAttr.getX(i * 3 + 2);
      a = new THREE.Vector3().fromBufferAttribute(posAttr, aIndex).applyMatrix4(matrixWorld);
      b = new THREE.Vector3().fromBufferAttribute(posAttr, bIndex).applyMatrix4(matrixWorld);
      c = new THREE.Vector3().fromBufferAttribute(posAttr, cIndex).applyMatrix4(matrixWorld);
    } else {
      a = new THREE.Vector3().fromBufferAttribute(posAttr, i * 3).applyMatrix4(matrixWorld);
      b = new THREE.Vector3().fromBufferAttribute(posAttr, i * 3 + 1).applyMatrix4(matrixWorld);
      c = new THREE.Vector3().fromBufferAttribute(posAttr, i * 3 + 2).applyMatrix4(matrixWorld);
    }
  
    const center = new THREE.Vector3().addVectors(a, b).add(c).divideScalar(3);
    const ab = new THREE.Vector3().subVectors(b, a);
    const ac = new THREE.Vector3().subVectors(c, a);
    const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();
    const viewVec = new THREE.Vector3().subVectors(cameraPos, center).normalize();
  
    const dot = normal.dot(viewVec);
    if (dot <= threshold) {
      undercutPositions.push(a.x, a.y, a.z);
      undercutPositions.push(b.x, b.y, b.z);
      undercutPositions.push(c.x, c.y, c.z);
  
      undercutNormals.push(normal.x, normal.y, normal.z);
      undercutNormals.push(normal.x, normal.y, normal.z);
      undercutNormals.push(normal.x, normal.y, normal.z);
    }
  }
  
  const undercutGeometry = new THREE.BufferGeometry();
  undercutGeometry.setAttribute('position', new THREE.Float32BufferAttribute(undercutPositions, 3));
  undercutGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(undercutNormals, 3));
  
  const redMaterial = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.5
  });
  
  undercutMesh = new THREE.Mesh(undercutGeometry, redMaterial);
  scene.add(undercutMesh);

  // 호출 횟수 증가: 두번째부터는 dot <= 0.0 조건이 적용됩니다.
  detectCount++;
}

// 블록아웃 및 내부 면 제거 (중복 정점 병합 활용)
function Blockout() {
  if (!targetMesh || !undercutMesh) return;
  
  const blockoutDistance = 0.1; // 블록아웃 이동 거리
  const insertionDir = new THREE.Vector3();
  // 저장된 카메라 방향 사용
  if (savedCameraState && savedCameraState.direction) {
    insertionDir.copy(savedCameraState.direction);
  } else {
    camera.getWorldDirection(insertionDir);
  }
  
  // 타겟 메쉬를 비인덱스 형태로 변환
  if (targetMesh.geometry.index !== null) {
    targetMesh.geometry = targetMesh.geometry.toNonIndexed();
  }
  
  const undercutPositions = undercutMesh.geometry.attributes.position.array;
  const triangleCount = undercutPositions.length / 9;
  const blockoutGeometries = [];
  
  // 각 언더컷 삼각형에 대해 블록아웃 프리즘 생성
  for (let i = 0; i < triangleCount; i++) {
    const a = new THREE.Vector3(
      undercutPositions[i * 9],
      undercutPositions[i * 9 + 1],
      undercutPositions[i * 9 + 2]
    );
    const b = new THREE.Vector3(
      undercutPositions[i * 9 + 3],
      undercutPositions[i * 9 + 4],
      undercutPositions[i * 9 + 5]
    );
    const c = new THREE.Vector3(
      undercutPositions[i * 9 + 6],
      undercutPositions[i * 9 + 7],
      undercutPositions[i * 9 + 8]
    );
  
    const a2 = a.clone().addScaledVector(insertionDir, blockoutDistance);
    const b2 = b.clone().addScaledVector(insertionDir, blockoutDistance);
    const c2 = c.clone().addScaledVector(insertionDir, blockoutDistance);
  
    const vertices = [];
    // 상단 면
    vertices.push(a2.x, a2.y, a2.z, b2.x, b2.y, b2.z, c2.x, c2.y, c2.z);
    // 하단 면
    vertices.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
    // 측면 1
    vertices.push(a.x, a.y, a.z, b.x, b.y, b.z, b2.x, b2.y, b2.z);
    vertices.push(a.x, a.y, a.z, b2.x, b2.y, b2.z, a2.x, a2.y, a2.z);
    // 측면 2
    vertices.push(b.x, b.y, b.z, c.x, c.y, c.z, c2.x, c2.y, c2.z);
    vertices.push(b.x, b.y, b.z, c2.x, c2.y, c2.z, b2.x, b2.y, b2.z);
    // 측면 3
    vertices.push(c.x, c.y, c.z, a.x, a.y, a.z, a2.x, a2.y, a2.z);
    vertices.push(c.x, c.y, c.z, a2.x, a2.y, a2.z, c2.x, c2.y, c2.z);
  
    const prismGeometry = new THREE.BufferGeometry();
    prismGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    prismGeometry.computeVertexNormals();
  
    const nonIndexedPrismGeometry = prismGeometry.index ? prismGeometry.toNonIndexed() : prismGeometry;
    blockoutGeometries.push(nonIndexedPrismGeometry);
  }
  
  // 블록아웃 기하체들을 병합
  const mergedBlockoutGeometry = BufferGeometryUtils.mergeGeometries(blockoutGeometries, false);
  let mergedGeometry = BufferGeometryUtils.mergeGeometries(
    [targetMesh.geometry, mergedBlockoutGeometry],
    false
  );
  
  // 중복 정점을 병합하여 불필요한 면 제거 (1e-5는 tolerance 값으로 모델 스케일에 맞게 조정)
  mergedGeometry = BufferGeometryUtils.mergeVertices(mergedGeometry, 1e-5);
  mergedGeometry.computeVertexNormals();
  mergedGeometry.computeBoundingSphere();
  
  targetMesh.geometry.dispose();
  targetMesh.geometry = mergedGeometry;
  
  // 언더컷 메쉬 제거
  scene.remove(undercutMesh);
  undercutMesh.geometry.dispose();
  undercutMesh.material.dispose();
  undercutMesh = null;
}

// 저장된 카메라 상태 복원 함수
function restoreCamera() {
  if (savedCameraState) {
    camera.position.copy(savedCameraState.position);
    controls.target.copy(savedCameraState.target);
    camera.quaternion.copy(savedCameraState.quaternion);
    controls.update();
    console.log('Camera restored to saved state.');
  }
}

// 초기화 함수
function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);
  
  scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 50);
  camera.position.set(0, 0, 3);
  
  controls = new OrbitControls(camera, renderer.domElement);
  
  // Matcap 텍스처 로드
  matcaps['Clay'] = new THREE.TextureLoader().load('textures/B67F6B_4B2E2A_6C3A34_F3DBC6-256px.png');
  matcaps['Red Wax'] = new THREE.TextureLoader().load('textures/763C39_431510_210504_55241C-256px.png');
  matcaps['Shiny Green'] = new THREE.TextureLoader().load('textures/3B6E10_E3F2C3_88AC2E_99CE51-256px.png');
  matcaps['Normal'] = new THREE.TextureLoader().load('textures/7877EE_D87FC5_75D9C7_1C78C0-256px.png');
  
  material = new THREE.MeshMatcapMaterial({
    flatShading: true,
    side: THREE.DoubleSide,
  });
  
  stats = new Stats();
  document.body.appendChild(stats.dom);
  
  gui.add({ detectUndercuts }, 'detectUndercuts').name("Detect Undercuts");
  gui.add({ applyBlockout: Blockout }, 'applyBlockout').name("Apply Blockout");
  gui.add({ restoreCamera }, 'restoreCamera').name("Restore Camera");
  
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  
  window.addEventListener('dragover', e => {
    e.preventDefault();
  }, false);
  
  window.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const reader = new FileReader();
      reader.addEventListener('load', event => {
        const arrayBuffer = event.target.result;
        const geometry = stlLoader.parse(arrayBuffer);
  
        const positionAttr = geometry.getAttribute('position');
        if (!positionAttr) {
          throw new Error('BufferGeometry has no position attribute.');
        }
        const positions = positionAttr.array;
        const indices = [];
        for (let i = 0; i < positions.length / 3; i += 3) {
          indices.push(i, i + 1, i + 2);
        }
        let newGeometry = new THREE.BufferGeometry();
        newGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        newGeometry.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
        setTargetMeshGeometry(newGeometry);
      }, false);
      reader.readAsArrayBuffer(file);
    }
  }, false);
  
  render();
}

function render() {
  material.matcap = matcaps[params.matcap];
  requestAnimationFrame(render);
  stats.update();
  renderer.render(scene, camera);
}

init();
