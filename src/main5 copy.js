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
let blockoutMesh = null;
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
    if ( !targetMesh ) return;
  
    // 이전 undercut 시각화 제거
    if ( undercutMesh ) {
      scene.remove( undercutMesh );
      undercutMesh.geometry.dispose();
      undercutMesh.material.dispose();
      undercutMesh = null;
    }
  
    // targetMesh의 월드 매트릭스 최신화
    targetMesh.updateMatrixWorld( true );
    const geometry = targetMesh.geometry;
    const posAttr = geometry.attributes.position;
    const indexAttr = geometry.index;
  
    const matrixWorld = targetMesh.matrixWorld;
    const cameraPos = camera.position;
  
    const undercutPositions = [];
    const undercutNormals = [];
  
    // 각 삼각형 단위로 undercut 여부 판별
    for ( let i = 0; i < indexAttr.count; i += 3 ) {
      const aIndex = indexAttr.getX( i );
      const bIndex = indexAttr.getX( i + 1 );
      const cIndex = indexAttr.getX( i + 2 );
  
      const a = new THREE.Vector3().fromBufferAttribute( posAttr, aIndex ).applyMatrix4( matrixWorld );
      const b = new THREE.Vector3().fromBufferAttribute( posAttr, bIndex ).applyMatrix4( matrixWorld );
      const c = new THREE.Vector3().fromBufferAttribute( posAttr, cIndex ).applyMatrix4( matrixWorld );
  
      // 삼각형 중심 계산
      const center = new THREE.Vector3().addVectors( a, b ).add( c ).divideScalar( 3 );
  
      // 월드공간에서 삼각형 면의 법선 계산
      const ab = new THREE.Vector3().subVectors( b, a );
      const ac = new THREE.Vector3().subVectors( c, a );
      const normal = new THREE.Vector3().crossVectors( ab, ac ).normalize();
  
      // 카메라에서 삼각형 중심으로 향하는 벡터 (카메라에서 본 방향)
      const viewVec = new THREE.Vector3().subVectors( cameraPos, center ).normalize();
  
      // 삼각형이 카메라를 향하고 있으면 dot 값이 양수,
      // 보이지 않는(후면) 경우에만 undercut으로 판정 (dot <= 0)
      const dot = normal.dot( viewVec );
      if ( dot <= 0.01 ) {
        // undercut 삼각형이면 해당 정점들 추가 (중복 없이 시각화하기 위해 따로 geometry 생성)
        undercutPositions.push( a.x, a.y, a.z );
        undercutPositions.push( b.x, b.y, b.z );
        undercutPositions.push( c.x, c.y, c.z );
  
        // 각 삼각형의 법선을 동일하게 적용
        undercutNormals.push( normal.x, normal.y, normal.z );
        undercutNormals.push( normal.x, normal.y, normal.z );
        undercutNormals.push( normal.x, normal.y, normal.z );
      }
    }
  
    // undercut 시각화용 BufferGeometry 생성
    const undercutGeometry = new THREE.BufferGeometry();
    undercutGeometry.setAttribute( 'position', new THREE.Float32BufferAttribute( undercutPositions, 3 ) );
    undercutGeometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( undercutNormals, 3 ) );
  
    // 빨간색, 반투명 MeshBasicMaterial 사용 (양면 렌더링)
    const redMaterial = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.5
    });
  
    undercutMesh = new THREE.Mesh( undercutGeometry, redMaterial );
    scene.add( undercutMesh );
  }

  function applyBlockoutToTargetMesh() {
    if (!targetMesh) return;
    
    targetMesh.updateMatrixWorld(true);
    const geometry = targetMesh.geometry;
    const posAttr = geometry.attributes.position;
    const indexAttr = geometry.index;
    const matrixWorld = targetMesh.matrixWorld;
    const cameraPos = camera.position;
    
    const offsetDistance = 0.05; // 원하는 오프셋 거리
    
    // 각 정점에 대해 누적 offset과 적용 횟수를 저장할 객체를 만듭니다.
    const offsets = new Array(posAttr.count).fill(0).map(() => new THREE.Vector3());
    const counts = new Array(posAttr.count).fill(0);
    
    // 각 삼각형 단위로 undercut 여부를 판별하고, 해당 삼각형의 정점에 offset 벡터를 누적합니다.
    for (let i = 0; i < indexAttr.count; i += 3) {
      const aIndex = indexAttr.getX(i);
      const bIndex = indexAttr.getX(i + 1);
      const cIndex = indexAttr.getX(i + 2);
      
      // 정점의 world 좌표 계산
      const a = new THREE.Vector3().fromBufferAttribute(posAttr, aIndex).applyMatrix4(matrixWorld);
      const b = new THREE.Vector3().fromBufferAttribute(posAttr, bIndex).applyMatrix4(matrixWorld);
      const c = new THREE.Vector3().fromBufferAttribute(posAttr, cIndex).applyMatrix4(matrixWorld);
      
      // 삼각형 중심과 면의 법선 계산
      const center = new THREE.Vector3().addVectors(a, b).add(c).divideScalar(3);
      const ab = new THREE.Vector3().subVectors(b, a);
      const ac = new THREE.Vector3().subVectors(c, a);
      const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();
      
      // 카메라 방향 벡터 (삼각형 중심에서 카메라로 향하는 방향)
      const viewVec = new THREE.Vector3().subVectors(cameraPos, center).normalize();
      
      // 삼각형이 카메라를 향하지 않으면(후면이면) undercut으로 판단합니다.
      if (normal.dot(viewVec) <= 0.01) {
        // 삼각형마다 offset 방향을 계산합니다.
        // (이전 예제에서는 카메라 방향 성분을 제거한 벡터를 사용)
        const cameraDir = new THREE.Vector3();
        camera.getWorldDirection(cameraDir).normalize();
        const dot = normal.dot(cameraDir);
        let projected = normal.clone().sub(cameraDir.clone().multiplyScalar(dot));
        if (projected.lengthSq() > 0.0001) {
          projected.normalize();
        } else {
          projected.copy(normal).normalize();
        }
        projected.multiplyScalar(offsetDistance);
        
        // 해당 삼각형의 각 정점에 offset 기여를 누적
        offsets[aIndex].add(projected);
        offsets[bIndex].add(projected);
        offsets[cIndex].add(projected);
        
        counts[aIndex]++;
        counts[bIndex]++;
        counts[cIndex]++;
      }
    }
    
    // targetMesh의 로컬 좌표계에서 offset을 적용하기 위해, world -> local 변환 행렬 계산
    const invMatrix = new THREE.Matrix4().copy(targetMesh.matrixWorld).invert();
    
    // 누적된 offset 값을 각 정점에 평균내어 적용
    for (let i = 0; i < posAttr.count; i++) {
      if (counts[i] > 0) {
        // 평균 offset 계산 (world 좌표계)
        offsets[i].multiplyScalar(1 / counts[i]);
        // 로컬 좌표로 변환 (회전 성분만 적용)
        offsets[i].applyMatrix4(invMatrix);
        
        // 기존 정점 위치에 offset 적용
        const x = posAttr.getX(i);
        const y = posAttr.getY(i);
        const z = posAttr.getZ(i);
        posAttr.setXYZ(i, x + offsets[i].x, y + offsets[i].y, z + offsets[i].z);
      }
    }
    
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  function applyBlockoutExtrude() {
    if (!targetMesh) return;
    targetMesh.updateMatrixWorld(true);
    const geometry = targetMesh.geometry;
    const posAttr = geometry.attributes.position;
    const indices = geometry.index.array;
    const vertexCount = posAttr.count;
    const triangleCount = indices.length / 3;
    const matrixWorld = targetMesh.matrixWorld;
    const cameraPos = camera.position;
  
    // 1. Undercut 삼각형 판별 (각 삼각형의 법선과 카메라 방향 비교)
    const undercutTriangles = new Array(triangleCount).fill(false);
    for (let t = 0; t < triangleCount; t++) {
      const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
      const v0 = new THREE.Vector3().fromBufferAttribute(posAttr, i0).applyMatrix4(matrixWorld);
      const v1 = new THREE.Vector3().fromBufferAttribute(posAttr, i1).applyMatrix4(matrixWorld);
      const v2 = new THREE.Vector3().fromBufferAttribute(posAttr, i2).applyMatrix4(matrixWorld);
      const center = new THREE.Vector3().addVectors(v0, v1).add(v2).divideScalar(3);
      const ab = new THREE.Vector3().subVectors(v1, v0);
      const ac = new THREE.Vector3().subVectors(v2, v0);
      const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();
      const viewVec = new THREE.Vector3().subVectors(cameraPos, center).normalize();
      if (normal.dot(viewVec) <= 0.01) {
        undercutTriangles[t] = true;
      }
    }
  
    // 2. undercut 영역에 속하는 정점 집합 생성
    const extrudedVertexSet = new Set();
    for (let t = 0; t < triangleCount; t++) {
      if (undercutTriangles[t]) {
        extrudedVertexSet.add(indices[t * 3]);
        extrudedVertexSet.add(indices[t * 3 + 1]);
        extrudedVertexSet.add(indices[t * 3 + 2]);
      }
    }
  
    // 3. undercut 삼각형의 엣지들을 모아 경계 엣지(단 1회 등장하는 엣지)를 찾습니다.
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
  
    // 4. 각 undercut 정점에 대해 오프셋 벡터(누적 후 평균) 계산
    const vertexOffsets = {}; // 정점별 누적 오프셋 (world space)
    const vertexCounts = {};
    const cameraDir = new THREE.Vector3();
    camera.getWorldDirection(cameraDir).normalize();
    const offsetDistance = 0.05;
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
        // 카메라 방향 성분 제거
        const dot = normal.dot(cameraDir);
        let projected = normal.clone().sub(cameraDir.clone().multiplyScalar(dot));
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
  
    // 5. 오프셋을 적용한 top 정점 생성 (world → local 변환)
    const invMatrix = new THREE.Matrix4().copy(targetMesh.matrixWorld).invert();
    const topPositions = {}; // 정점 인덱스별 top 정점 (local space)
    extrudedVertexSet.forEach(i => {
      const origPos = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      const offsetLocal = averagedOffsets[i].clone().applyMatrix4(invMatrix);
      const topPos = origPos.clone().add(offsetLocal);
      topPositions[i] = topPos;
    });
  
    // 6. 새 기하를 위한 정점 배열 생성  
    // - bottom: 원본 정점 그대로  
    // - top: extrudedVertexSet에 해당하는 정점을 새로 복제
    const newVertices = [];
    // bottom 정점 (0 ~ vertexCount-1)
    for (let i = 0; i < vertexCount; i++) {
      newVertices.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    }
    // top 정점은 원본 정점 인덱스에 대해 새 인덱스를 할당합니다.
    const extrudedIndexMap = {}; // original index -> top 정점의 새 인덱스
    extrudedVertexSet.forEach(i => {
      extrudedIndexMap[i] = newVertices.length / 3;
      const tp = topPositions[i];
      newVertices.push(tp.x, tp.y, tp.z);
    });
  
    // 7. 새 인덱스 배열 생성  
    // - non-undercut 삼각형은 bottom 면 그대로  
    // - undercut 삼각형은 바닥(bottom) 면과 윗면(top) 면 두 개를 생성  
    // - 경계 엣지를 따라 side face(quad를 두 삼각형으로 분할) 생성
    const newIndices = [];
  
    // non-undercut 삼각형 (원본 그대로)
    for (let t = 0; t < triangleCount; t++) {
      if (!undercutTriangles[t]) {
        const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
        newIndices.push(i0, i1, i2);
      }
    }
  
    // undercut 삼각형의 바닥면 (bottom face)
    for (let t = 0; t < triangleCount; t++) {
      if (undercutTriangles[t]) {
        const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
        newIndices.push(i0, i1, i2);
      }
    }
  
    // undercut 삼각형의 윗면 (top face, 반대 방향으로 배치하여 노멀 유지)
    for (let t = 0; t < triangleCount; t++) {
      if (undercutTriangles[t]) {
        const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
        const j0 = extrudedIndexMap[i0];
        const j1 = extrudedIndexMap[i1];
        const j2 = extrudedIndexMap[i2];
        newIndices.push(j0, j2, j1); // 반대 방향
      }
    }
  
    // 경계 엣지를 따라 side face 생성
    boundaryEdges.forEach(edge => {
      const a = edge.a, b = edge.b;
      if (extrudedIndexMap[a] === undefined || extrudedIndexMap[b] === undefined) return;
      const aTop = extrudedIndexMap[a];
      const bTop = extrudedIndexMap[b];
      // quad를 두 삼각형으로 분할: (a, b, bTop)와 (a, bTop, aTop)
      newIndices.push(a, b, bTop);
      newIndices.push(a, bTop, aTop);
    });
  
    // 8. 새 BufferGeometry 생성 및 targetMesh 업데이트
    const newGeometry = new THREE.BufferGeometry();
    newGeometry.setAttribute('position', new THREE.Float32BufferAttribute(newVertices, 3));
    newGeometry.setIndex(newIndices);
    newGeometry.computeVertexNormals();
  
    scene.remove(targetMesh);
    geometry.dispose();
    targetMesh = new THREE.Mesh(newGeometry, material);
    scene.add(targetMesh);
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
  
  matcaps[ 'Clay' ] = new THREE.TextureLoader().load( 'textures/B67F6B_4B2E2A_6C3A34_F3DBC6-256px.png' );
	matcaps[ 'Red Wax' ] = new THREE.TextureLoader().load( 'textures/763C39_431510_210504_55241C-256px.png' );
	matcaps[ 'Shiny Green' ] = new THREE.TextureLoader().load( 'textures/3B6E10_E3F2C3_88AC2E_99CE51-256px.png' );
	matcaps[ 'Normal' ] = new THREE.TextureLoader().load( 'textures/7877EE_D87FC5_75D9C7_1C78C0-256px.png' );

	material = new THREE.MeshMatcapMaterial( {
		flatShading: true,
        side: THREE.DoubleSide,
	} );
  
  stats = new Stats();
  document.body.appendChild(stats.dom);
  
  gui.add( { detectUndercuts }, 'detectUndercuts' ).name("Detect Undercuts");
  gui.add( { applyBlockoutToTargetMesh}, 'applyBlockoutToTargetMesh' ).name("Apply Blockout");
  gui.add({ applyBlockoutExtrude }, 'applyBlockoutExtrude').name("Apply Extrude Blockout");

  
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  window.addEventListener( 'dragover', e => {
    e.preventDefault();
  }, false );

  window.addEventListener( 'drop', e => {

    e.preventDefault();
  
    if ( e.dataTransfer.files && e.dataTransfer.files.length > 0 ) {
  
      const file = e.dataTransfer.files[ 0 ];
      const reader = new FileReader();
  
      reader.addEventListener( 'load', event => {
  
        const arrayBuffer = event.target.result;
        const geometry = stlLoader.parse( arrayBuffer );
              
              const positionAttr = geometry.getAttribute('position');
              if ( ! positionAttr ) {
                throw new Error('BufferGeometry has no position attribute.');
              }
              const positions = positionAttr.array; 
      
      
              const indices = [];
              for ( let i = 0; i < positions.length / 3; i += 3 ) {
                indices.push( i, i + 1, i + 2 );
              }
      
              let newGeometry = new THREE.BufferGeometry();
      
              newGeometry.setAttribute(
                'position',
                new THREE.Float32BufferAttribute( positions, 3 )
              );
      
              newGeometry.setIndex(
                new THREE.Uint32BufferAttribute( indices, 1 )
              );
      
            setTargetMeshGeometry( newGeometry );
  
      }, false );
  
      reader.readAsArrayBuffer( file );
  
    }
  
  }, false );
  
  render();
}

function render() {
  material.matcap = matcaps[ params.matcap ];
  requestAnimationFrame(render);
  stats.update();
  renderer.render(scene, camera);
}



init();
