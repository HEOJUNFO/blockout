import Stats from 'three/examples/jsm/libs/stats.module.js';
import * as dat from 'three/examples/jsm/libs/lil-gui.module.min.js';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

let stats, scene, camera, renderer, controls;
let targetMesh = null;
let originalMesh = null;   // 원본 메시 저장
let undercutMesh = null; 
let material;
let savedCameraState = null;  // 카메라 상태 저장
let detectCount = 0;          // 언더컷 감지 호출 횟수 추적

const params = {
  matcap: 'Clay',
  detectUndercuts: false,
  blockout: false,
  showOriginal: false,  // true이면 원본 모델만, false이면 블록아웃 후 모델만 표시
};

const matcaps = {};

const stlLoader = new STLLoader();
const gui = new dat.GUI();

// STL 파일 로드 및 처리
function setTargetMeshGeometry(geometry) {
  // 기존 메시들 제거
  if (targetMesh) {
    scene.remove(targetMesh);
    targetMesh.geometry.dispose();
  }
  if (originalMesh) {
    scene.remove(originalMesh);
    originalMesh.geometry.dispose();
  }
  
  geometry.center();
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) {
    const radius = geometry.boundingSphere.radius;
    geometry.scale(1 / radius, 1 / radius, 1 / radius);
  }
  
  geometry.deleteAttribute( 'uv' );
  geometry = BufferGeometryUtils.mergeVertices( geometry );
  geometry.computeVertexNormals();
  geometry.attributes.position.setUsage( THREE.DynamicDrawUsage );
  geometry.attributes.normal.setUsage( THREE.DynamicDrawUsage );
  geometry.computeBoundsTree( { setBoundingBox: false } );

  
  // 블록아웃 후 모델로 사용될 메시
  targetMesh = new THREE.Mesh(geometry, material);
  scene.add(targetMesh);
  
  // 원본 메시 deep clone
  const originalGeometry = geometry.clone();
  originalMesh = new THREE.Mesh(originalGeometry, material);
  scene.add(originalMesh);
  
  // 둘 다 동일한 위치에 배치
  originalMesh.position.set(0, 0, 0);
  targetMesh.position.set(0, 0, 0);
  
  // 토글 상태 업데이트
  updateComparison();
}

// 언더컷 감지 기능 (기존과 동일)
function detectUndercuts() {
  if (!targetMesh) return;
  
  if (!savedCameraState) {
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    savedCameraState = {
      position: camera.position.clone(),
      target: controls.target.clone(),
      quaternion: camera.quaternion.clone(),
      direction: direction.clone()
    };
    console.log('Camera state saved:', savedCameraState);
  }
  
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
  
  let triangleCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;
  const threshold = (detectCount === 0) ? 0.1 : 0.0;
  
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

  detectCount++;
}

// 블록아웃 및 내부 면 제거 (기존과 동일)
function Blockout() {
  if (!targetMesh || !undercutMesh) return;
  
  const blockoutDistance = 0.1;
  const insertionDir = new THREE.Vector3();
  if (savedCameraState && savedCameraState.direction) {
    insertionDir.copy(savedCameraState.direction);
  } else {
    camera.getWorldDirection(insertionDir);
  }
  
  if (targetMesh.geometry.index !== null) {
    targetMesh.geometry = targetMesh.geometry.toNonIndexed();
  }
  
  const undercutPositions = undercutMesh.geometry.attributes.position.array;
  const triangleCount = undercutPositions.length / 9;
  const blockoutGeometries = [];
  
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

  const mergedBlockoutGeometry = BufferGeometryUtils.mergeGeometries(blockoutGeometries, false);
  let mergedGeometry = BufferGeometryUtils.mergeGeometries(
    [targetMesh.geometry, mergedBlockoutGeometry],
    false
  );
  
  mergedGeometry = BufferGeometryUtils.mergeVertices(mergedGeometry, 1e-5);
  mergedGeometry.computeVertexNormals();
  mergedGeometry.computeBoundingSphere();
  
  targetMesh.geometry.dispose();
  targetMesh.geometry = mergedGeometry;
  
  scene.remove(undercutMesh);
  undercutMesh.geometry.dispose();
  undercutMesh.material.dispose();
  undercutMesh = null;
  
  // 블록아웃 후 모델이 업데이트 되었으므로 토글 상태 재적용
  updateComparison();
}

// targetMesh 내보내기 함수
function exportMesh() {
  if (!targetMesh) {
    console.warn('내보낼 메시가 없습니다');
    return;
  }
  
  // 현재 보이는 메시 선택 (원본 또는 수정된 메시)
  const meshToExport = params.showOriginal ? originalMesh : targetMesh;
  
  // STL 내보내기 인스턴스 생성
  const exporter = new STLExporter();
  
  // 메시를 STL 형식으로 변환 (바이너리)
  const result = exporter.parse(meshToExport, { binary: true });
  
  // STL 데이터로 Blob 생성
  const blob = new Blob([result], { type: 'application/octet-stream' });
  
  // Blob에 대한 URL 생성
  const url = URL.createObjectURL(blob);
  
  // 다운로드 링크 생성 및 트리거
  const link = document.createElement('a');
  link.href = url;
  const fileName = params.showOriginal ? 'original_mesh.stl' : 'modified_mesh.stl';
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  
  // 정리
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  
  console.log(`${fileName} 파일이 내보내기 되었습니다.`);
}

// 저장된 카메라 상태 복원 (기존과 동일)
function restoreCamera() {
  if (savedCameraState) {
    camera.position.copy(savedCameraState.position);
    controls.target.copy(savedCameraState.target);
    camera.quaternion.copy(savedCameraState.quaternion);
    controls.update();
    console.log('Camera restored to saved state.');
  }
}

// 토글 상태에 따라 두 모델의 visibility를 업데이트하는 함수
function updateComparison() {
  // 두 메시 모두 동일한 위치에 겹쳐 있습니다.
  originalMesh.position.set(0, 0, 0);
  targetMesh.position.set(0, 0, 0);
  if (params.showOriginal) {
    originalMesh.visible = true;
    targetMesh.visible = false;
  } else {
    originalMesh.visible = false;
    targetMesh.visible = true;
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
  
  controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 5.0;
  controls.zoomSpeed = 1.2;
  controls.panSpeed = 0.8;
  controls.staticMoving = true;
  controls.dynamicDampingFactor = 0.3;
  
  // Matcap 텍스처 로드
  matcaps['Clay'] = new THREE.TextureLoader().load('textures/B67F6B_4B2E2A_6C3A34_F3DBC6-256px.png');
  matcaps['Red Wax'] = new THREE.TextureLoader().load('textures/763C39_431510_210504_55241C-256px.png');
  matcaps['Shiny Green'] = new THREE.TextureLoader().load('textures/3B6E10_E3F2C3_88AC2E_99CE51-256px.png');
  matcaps['Normal'] = new THREE.TextureLoader().load('textures/7877EE_D87FC5_75D9C7_1C78C0-256px.png');
  
  material = new THREE.MeshMatcapMaterial({
    flatShading: false,
    side: THREE.DoubleSide,
  });
  
  stats = new Stats();
  document.body.appendChild(stats.dom);
  
  // GUI 버튼들
  gui.add({ detectUndercuts }, 'detectUndercuts').name("Detect Undercuts");
  gui.add({ applyBlockout: Blockout }, 'applyBlockout').name("Apply Blockout");
  gui.add({ restoreCamera }, 'restoreCamera').name("Restore Camera");
  // showOriginal 토글: true이면 원본, false이면 블록아웃 후 모델만 보임
  gui.add(params, 'showOriginal').name("Show Original").onChange(updateComparison);
  // 내보내기 버튼 추가
  gui.add({ exportMesh }, 'exportMesh').name("Export Mesh");
  
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
  controls.update();
  renderer.render(scene, camera);
}

init();