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

const params = {
  matcap: 'Clay',
  displayHelper: false,
  detectUndercuts: false,
  blockout: false,
};

const matcaps = {};

const stlLoader = new STLLoader();
const gui = new dat.GUI();

// undercut 감지 결과를 캐시할 전역 변수
let cachedUndercutData = null;
// detectUndercuts 시 저장된 카메라 상태 (position, target)
let savedCameraState = null;

// STL 파일 로드 후 메시 업데이트
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
  geometry.deleteAttribute('uv');
  geometry = BufferGeometryUtils.mergeVertices(geometry);
  geometry.computeVertexNormals();
  geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
  geometry.attributes.normal.setUsage(THREE.DynamicDrawUsage);
  geometry.computeBoundsTree({ setBoundingBox: false });
  targetMesh = new THREE.Mesh(geometry, material);
  scene.add(targetMesh);
}

// undercut 감지 (현재 카메라 상태 기반) – 결과를 캐시하여 저장하고, 카메라 상태를 저장
function detectUndercuts() {
  if (!targetMesh) return;
  
  // 이전 undercut 시각화 제거
  if (undercutMesh) {
    scene.remove(undercutMesh);
    undercutMesh.geometry.dispose();
    undercutMesh.material.dispose();
    undercutMesh = null;
  }
  
  // 메시 월드행렬 업데이트
  targetMesh.updateMatrixWorld(true);
  const geometry = targetMesh.geometry;
  const posAttr = geometry.attributes.position;
  const indexAttr = geometry.index;
  
  const matrixWorld = targetMesh.matrixWorld;
  const cameraPos = camera.position;
  
  const undercutPositions = [];
  const undercutNormals = [];
  
  const triangleCount = indexAttr.count / 3;
  const undercutTriangles = new Array(triangleCount);
  let triIndex = 0;
  
  // 각 삼각형마다 undercut 여부 판단
  for (let i = 0; i < indexAttr.count; i += 3) {
    const aIndex = indexAttr.getX(i);
    const bIndex = indexAttr.getX(i + 1);
    const cIndex = indexAttr.getX(i + 2);
  
    const a = new THREE.Vector3().fromBufferAttribute(posAttr, aIndex).applyMatrix4(matrixWorld);
    const b = new THREE.Vector3().fromBufferAttribute(posAttr, bIndex).applyMatrix4(matrixWorld);
    const c = new THREE.Vector3().fromBufferAttribute(posAttr, cIndex).applyMatrix4(matrixWorld);
  
    // 삼각형 중심 계산
    const center = new THREE.Vector3().addVectors(a, b).add(c).divideScalar(3);
  
    // 삼각형의 면 법선 계산
    const ab = new THREE.Vector3().subVectors(b, a);
    const ac = new THREE.Vector3().subVectors(c, a);
    const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();
  
    // 카메라로부터 삼각형 중심을 바라보는 벡터
    const viewVec = new THREE.Vector3().subVectors(cameraPos, center).normalize();
  
    const dot = normal.dot(viewVec);
    if (dot < 0.1) {
      // undercut인 경우 표시 및 시각화용 데이터 추가
      undercutTriangles[triIndex] = true;
      undercutPositions.push(a.x, a.y, a.z);
      undercutPositions.push(b.x, b.y, b.z);
      undercutPositions.push(c.x, c.y, c.z);
  
      undercutNormals.push(normal.x, normal.y, normal.z);
      undercutNormals.push(normal.x, normal.y, normal.z);
      undercutNormals.push(normal.x, normal.y, normal.z);
    } else {
      undercutTriangles[triIndex] = false;
    }
  
    triIndex++;
  }
  
  // undercut 삼각형 시각화를 위한 메시 생성 (빨간색, 반투명, 양면)
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
  
  // 감지 당시 undercut 삼각형 정보와 카메라 방향을 캐시
  cachedUndercutData = {
    undercutTriangles: undercutTriangles,
    cameraDir: camera.getWorldDirection(new THREE.Vector3()).clone()
  };

  // 카메라 상태 저장 (위치와 controls.target)
  savedCameraState = {
    position: camera.position.clone(),
    target: controls.target.clone()
  };

  console.log(cachedUndercutData);
}

// blockout extrude 적용 – 캐시된 undercut 정보를 사용함
function applyBlockoutExtrude() {
  if (!targetMesh) return;
  console.log('applyBlockoutExtrude');
  targetMesh.updateMatrixWorld(true);
  const geometry = targetMesh.geometry;
  const posAttr = geometry.attributes.position;
  const indices = geometry.index.array;
  const vertexCount = posAttr.count;
  const triangleCount = indices.length / 3;
  const matrixWorld = targetMesh.matrixWorld;
  
  // 캐시된 undercut 데이터가 유효하면 사용
  let undercutTriangles;
  if (cachedUndercutData && cachedUndercutData.undercutTriangles && cachedUndercutData.undercutTriangles.length === triangleCount) {
    undercutTriangles = cachedUndercutData.undercutTriangles;
    console.log('Using cached undercut data');
  } else {
    console.log('No cached undercut data');
    undercutTriangles = new Array(triangleCount).fill(false);
    for (let t = 0; t < triangleCount; t++) {
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
      const v0 = new THREE.Vector3().fromBufferAttribute(posAttr, i0).applyMatrix4(matrixWorld);
      const v1 = new THREE.Vector3().fromBufferAttribute(posAttr, i1).applyMatrix4(matrixWorld);
      const v2 = new THREE.Vector3().fromBufferAttribute(posAttr, i2).applyMatrix4(matrixWorld);
      const center = new THREE.Vector3().addVectors(v0, v1).add(v2).divideScalar(3);
      const ab = new THREE.Vector3().subVectors(v1, v0);
      const ac = new THREE.Vector3().subVectors(v2, v0);
      const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();
      const viewVec = new THREE.Vector3().subVectors(camera.position, center).normalize();
      if (normal.dot(viewVec) <= 0.01) {
        undercutTriangles[t] = true;
      }
    }
  }
  
  // 캐시된 감지 시의 카메라 방향 사용 (없으면 현재 카메라 방향)
  const usedCameraDir = cachedUndercutData && cachedUndercutData.cameraDir
    ? cachedUndercutData.cameraDir.clone()
    : camera.getWorldDirection(new THREE.Vector3()).normalize();
  
  // undercut 영역에 속하는 정점 집합 생성
  const extrudedVertexSet = new Set();
  for (let t = 0; t < triangleCount; t++) {
    if (undercutTriangles[t]) {
      extrudedVertexSet.add(indices[t * 3]);
      extrudedVertexSet.add(indices[t * 3 + 1]);
      extrudedVertexSet.add(indices[t * 3 + 2]);
    }
  }
  
  // undercut 삼각형의 엣지를 모아 경계 엣지(한 번만 등장하는 엣지) 찾기
  const edgeCount = {};
  function addEdge(i, j) {
    const key = i < j ? `${i}_${j}` : `${j}_${i}`;
    if (edgeCount[key] === undefined) {
      edgeCount[key] = { count: 1, a: i, b: j };
    } else {
      edgeCount[key].count++;
    }
  }
  for (let t = 0; t < triangleCount; t++) {
    if (undercutTriangles[t]) {
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
      addEdge(i0, i1);
      addEdge(i1, i2);
      addEdge(i2, i0);
    }
  }
  const boundaryEdges = [];
  for (let key in edgeCount) {
    if (edgeCount[key].count === 1) {
      boundaryEdges.push({ a: edgeCount[key].a, b: edgeCount[key].b });
    }
  }
  
  // 각 undercut 정점에 대해 오프셋 벡터(누적 후 평균) 계산
  const vertexOffsets = {};
  const vertexCounts = {};
  const offsetDistance = 0.00001;
  for (let t = 0; t < triangleCount; t++) {
    if (undercutTriangles[t]) {
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
      const v0 = new THREE.Vector3().fromBufferAttribute(posAttr, i0).applyMatrix4(matrixWorld);
      const v1 = new THREE.Vector3().fromBufferAttribute(posAttr, i1).applyMatrix4(matrixWorld);
      const v2 = new THREE.Vector3().fromBufferAttribute(posAttr, i2).applyMatrix4(matrixWorld);
      const center = new THREE.Vector3().addVectors(v0, v1).add(v2).divideScalar(3);
      const ab = new THREE.Vector3().subVectors(v1, v0);
      const ac = new THREE.Vector3().subVectors(v2, v0);
      const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();
      // 카메라 방향 성분 제거 (캐시된 감지 시의 카메라 방향 사용)
      const dot = normal.dot(usedCameraDir);
      let projected = normal.clone().sub(usedCameraDir.clone().multiplyScalar(dot));
      if (projected.lengthSq() > 0.0001) {
        projected.normalize();
      } else {
        projected.copy(normal).normalize();
      }
      projected.multiplyScalar(offsetDistance);
      [i0, i1, i2].forEach(i => {
        if (!vertexOffsets[i]) {
          vertexOffsets[i] = new THREE.Vector3();
          vertexCounts[i] = 0;
        }
        vertexOffsets[i].add(projected);
        vertexCounts[i]++;
      });
    }
  }
  const averagedOffsets = {};
  extrudedVertexSet.forEach(i => {
    if (vertexCounts[i] > 0) {
      averagedOffsets[i] = vertexOffsets[i].clone().multiplyScalar(1 / vertexCounts[i]);
    }
  });
  
  // 오프셋을 적용한 top 정점 생성 (world → local 변환)
  const invMatrix = new THREE.Matrix4().copy(targetMesh.matrixWorld).invert();
  const topPositions = {};
  extrudedVertexSet.forEach(i => {
    const origPos = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    const offsetLocal = averagedOffsets[i].clone().applyMatrix4(invMatrix);
    const topPos = origPos.clone().add(offsetLocal);
    topPositions[i] = topPos;
  });
  
  // 새 기하를 위한 정점 배열 구성  
  // – bottom: 기존 정점 그대로  
  // – top: undercut 정점 복제 후 오프셋 적용
  const newVertices = [];
  for (let i = 0; i < vertexCount; i++) {
    newVertices.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
  }
  const extrudedIndexMap = {};
  extrudedVertexSet.forEach(i => {
    extrudedIndexMap[i] = newVertices.length / 3;
    const tp = topPositions[i];
    newVertices.push(tp.x, tp.y, tp.z);
  });
  
  // 새 인덱스 배열 생성  
  // – non-undercut 삼각형: bottom 면 그대로  
  // – undercut 삼각형: bottom 면과 윗면 생성  
  // – 경계 엣지: side face 생성
  const newIndices = [];
  
  // non-undercut 삼각형 (원본 그대로)
  for (let t = 0; t < triangleCount; t++) {
    if (!undercutTriangles[t]) {
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
      newIndices.push(i0, i1, i2);
    }
  }
  
  // undercut 삼각형의 윗면 (top face – 반대 방향으로)
  for (let t = 0; t < triangleCount; t++) {
    if (undercutTriangles[t]) {
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
      const j0 = extrudedIndexMap[i0];
      const j1 = extrudedIndexMap[i1];
      const j2 = extrudedIndexMap[i2];
      newIndices.push(j0, j2, j1);
    }
  }
  
  // 경계 엣지를 따라 side face 생성 (quad를 두 삼각형으로 분할)
  // boundaryEdges.forEach(edge => {
  //   const a = edge.a, b = edge.b;
  //   if (extrudedIndexMap[a] === undefined || extrudedIndexMap[b] === undefined) return;
  //   const aTop = extrudedIndexMap[a];
  //   const bTop = extrudedIndexMap[b];
  //   newIndices.push(a, b, bTop);
  //   newIndices.push(a, bTop, aTop);
  // });
  
  // 새 BufferGeometry 생성 후 targetMesh 업데이트
  const newGeometry = new THREE.BufferGeometry();
  newGeometry.setAttribute('position', new THREE.Float32BufferAttribute(newVertices, 3));
  newGeometry.setIndex(newIndices);
  newGeometry.computeVertexNormals();
  
  scene.remove(targetMesh);
  geometry.dispose();
  targetMesh = new THREE.Mesh(newGeometry, material);
  scene.add(targetMesh);

  // **** 수정된 부분 ****
  // blockout extrude 후, 캐시된 undercut 데이터는 더 이상 유효하지 않으므로 초기화하여 다음 감지 시 재계산하도록 합니다.
  cachedUndercutData = null;
}

// 카메라 복귀 함수 (저장된 카메라 상태로 복귀)
function restoreCamera() {
  if (savedCameraState) {
    camera.position.copy(savedCameraState.position);
    controls.target.copy(savedCameraState.target);
    controls.update();
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
  
  gui.add({ detectUndercuts }, 'detectUndercuts').name("Detect Undercuts");
  gui.add({ applyBlockoutExtrude }, 'applyBlockoutExtrude').name("Apply Extrude Blockout");
  gui.add({ restoreCamera }, 'restoreCamera').name("카메라 복귀");
  
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
        newGeometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(positions, 3)
        );
        newGeometry.setIndex(
          new THREE.Uint32BufferAttribute(indices, 1)
        );
      
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
