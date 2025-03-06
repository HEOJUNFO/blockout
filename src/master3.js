import Stats from 'three/examples/jsm/libs/stats.module.js';
import * as dat from 'three/examples/jsm/libs/lil-gui.module.min.js';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

let stats, scene, camera, renderer, controls;
let targetMesh = null;
let material;

const params = {
  matcap: 'Clay',
  detectUndercuts: false,
  blockout: false,
  showOriginal: false,  // true이면 원본 모델만, false이면 블록아웃 후 모델만 표시
  showSurface: true,    // Surface visibility toggle
  extrudeDistance: 0.01, // 기본 돌출 거리
  performExtrude: function() {
    // Extrude 기능 실행
    extrudeSurface(params.extrudeDistance);
  },
  clearPoints: function() {
    // 모든 점과 곡선 초기화
    clearAllPointsAndCurves();
  }
};

const matcaps = {};
const stlLoader = new STLLoader();
const gui = new dat.GUI();

// 배열 선언: 클릭한 점과 생성된 선(Line)을 저장
let clickPoints = []; // { point, normal, clickDirection, marker } 형태
let curveLines = []; // 생성된 선(Line) 객체들의 배열
let closedArea = null; // 닫힌 영역을 저장할 변수
let isDrawingClosed = false; // 닫힌 영역인지 여부

// 점 영역 감지 관련 상수
const POINT_DETECTION_RADIUS = 0.02; // 점 감지 반경
let hoveredPointIndex = -1; // 현재 마우스가 위치한 점의 인덱스 (없으면 -1)

// 모든 점과 곡선 초기화 함수
function clearAllPointsAndCurves() {
  // 모든 마커 제거
  clickPoints.forEach(pointData => {
    if (pointData.marker) {
      scene.remove(pointData.marker);
    }
  });

  // 모든 곡선 제거
  curveLines.forEach(line => {
    scene.remove(line);
  });

  // 닫힌 영역 제거
  if (closedArea) {
    scene.remove(closedArea);
    closedArea = null;
  }

  // 배열 초기화
  clickPoints = [];
  curveLines = [];
  isDrawingClosed = false;
  hoveredPointIndex = -1;
  
  // 커서 스타일 초기화
  renderer.domElement.style.cursor = 'auto';
}

// STL 파일 로드 및 처리 함수
function setTargetMeshGeometry(geometry) {
  // 기존 메시 제거
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

  // 블록아웃 후 모델로 사용될 메시 생성
  targetMesh = new THREE.Mesh(geometry, material);
  scene.add(targetMesh);
  targetMesh.position.set(0, 0, 0);
}

// Function to create a surface from the closed area curves
function createSurfaceFromClosedCurves() {
  if (!isDrawingClosed || curveLines.length === 0) {
    console.warn("Cannot create surface: area is not closed or no curves available");
    return;
  }
  
  // 1. Collect points from all curves
  const pointsSet = new Set(); // To eliminate duplicates
  const pointsList = [];
  
  curveLines.forEach(curveLine => {
    const positions = curveLine.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const point = new THREE.Vector3();
      point.fromBufferAttribute(positions, i);
      
      // Create a unique key for this point
      const key = `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)}`;
      
      if (!pointsSet.has(key)) {
        pointsSet.add(key);
        pointsList.push(point);
      }
    }
  });
  
  // 2. Calculate centroid
  const centroid = new THREE.Vector3();
  pointsList.forEach(p => centroid.add(p));
  centroid.divideScalar(pointsList.length);
  
  // Project the centroid onto the model surface
  const averageNormal = new THREE.Vector3();
  clickPoints.forEach(pointData => {
    averageNormal.add(pointData.normal);
  });
  averageNormal.normalize();
  
  // Cast a ray from slightly above the centroid in the negative normal direction
  const rayOrigin = centroid.clone().addScaledVector(averageNormal, 0.1);
  const raycaster = new THREE.Raycaster(rayOrigin, averageNormal.clone().negate());
  const intersects = raycaster.intersectObject(targetMesh, true);
  
  // If we hit the surface, use that point as the centroid
  if (intersects.length > 0) {
    centroid.copy(intersects[0].point);
  }
  
  // 3. Create vertices array (float32 buffer)
  const vertices = [];
  pointsList.forEach(p => {
    vertices.push(p.x, p.y, p.z);
  });
  
  // Add centroid as the last vertex
  vertices.push(centroid.x, centroid.y, centroid.z);
  const centroidIndex = pointsList.length;
  
  // 4. Create triangles by connecting each boundary point to the next and to the centroid
  const indices = [];
  for (let i = 0; i < pointsList.length; i++) {
    const nextI = (i + 1) % pointsList.length;
    indices.push(i, nextI, centroidIndex);
  }
  
  // 5. Create geometry
  const surfaceGeometry = new THREE.BufferGeometry();
  surfaceGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  surfaceGeometry.setIndex(indices);
  surfaceGeometry.computeVertexNormals();
  
  // 6. Create mesh with material
  const surfaceMaterial = new THREE.MeshStandardMaterial({
    color: 0x00ff00,
    side: THREE.DoubleSide,
    flatShading: false,
    metalness: 0.0,
    roughness: 0.5,
  });
  
  const surfaceMesh = new THREE.Mesh(surfaceGeometry, surfaceMaterial);
  //scene.add(surfaceMesh);
  
  // Store the surface mesh for future reference
  closedArea = surfaceMesh;
  
  return surfaceMesh;
}

// 생성된 곡면을 기준으로 extrude 처리하는 함수 - 수정된 버전
function extrudeSurface(extrudeDistance) {
  if (!closedArea) {
    console.warn("Cannot extrude: no surface available");
    return null;
  }
  
  // 클릭 방향의 평균을 계산 (사용자 시점에서 모델 방향)
  const averageClickDirection = new THREE.Vector3();
  clickPoints.forEach(pointData => {
    if (pointData.clickDirection) {
      averageClickDirection.add(pointData.clickDirection);
    }
  });
  
  // 클릭 방향이 없으면 원본 법선 방향 사용
  if (averageClickDirection.length() < 0.001) {
    console.warn("No click direction found, falling back to normal direction");
    // 기존 표면의 법선 방향 사용
    const positions = closedArea.geometry.getAttribute('position');
    const normals = closedArea.geometry.getAttribute('normal');
    for (let i = 0; i < positions.count; i++) {
      averageClickDirection.add(
        new THREE.Vector3(
          normals.getX(i),
          normals.getY(i),
          normals.getZ(i)
        )
      );
    }
  }
  
  // 정규화
  averageClickDirection.normalize();
  
  // 클릭 방향을 거꾸로하여 모델 안쪽으로 향하게 함 (사용자가 모델을 보는 방향에서 반대 방향)
  // 이렇게 해야 사용자가 점을 찍는 방향과 동일한 방향으로 extrude됨
  averageClickDirection.negate();
  
  console.log("Extrude direction:", averageClickDirection);
  
  // 기존 표면 지오메트리에서 정점과 법선 가져오기
  const positions = closedArea.geometry.getAttribute('position');
  const normals = closedArea.geometry.getAttribute('normal');
  const indices = closedArea.geometry.getIndex();
  
  if (!positions || !normals || !indices) {
    console.error("Surface geometry is missing required attributes");
    return null;
  }
  
  // 새로운 extrude된 메시를 위한 지오메트리 생성
  const extrudeGeometry = new THREE.BufferGeometry();
  
  // 정점 복사 (기존 표면 + extrude된 표면)
  const vertexCount = positions.count;
  const vertices = new Float32Array(vertexCount * 2 * 3); // 각 정점은 x,y,z 좌표를 가짐 (기존 + 돌출 표면)
  
  // 기존 표면의 정점 복사
  for (let i = 0; i < vertexCount; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    
    // 기존 정점 복사
    vertices[i * 3] = x;
    vertices[i * 3 + 1] = y;
    vertices[i * 3 + 2] = z;
    
    // 클릭 방향으로 돌출된 정점 생성
    // 법선 방향 대신 클릭 방향을 사용
    vertices[(i + vertexCount) * 3] = x + averageClickDirection.x * extrudeDistance;
    vertices[(i + vertexCount) * 3 + 1] = y + averageClickDirection.y * extrudeDistance;
    vertices[(i + vertexCount) * 3 + 2] = z + averageClickDirection.z * extrudeDistance;
  }
  
  // 정점 속성 설정
  extrudeGeometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  
  // 기존 표면의 인덱스 카운트
  const indexCount = indices.count;
  const indexArray = indices.array;
  
  // 새로운 인덱스 배열 (기존 표면 + 돌출된 표면 + 측면)
  const newIndices = [];
  
  // 기존 표면의 인덱스 복사 (뒤집지 않음)
  for (let i = 0; i < indexCount; i += 3) {
    const a = indexArray[i];
    const b = indexArray[i + 1];
    const c = indexArray[i + 2];
    
    newIndices.push(a, b, c);
  }
  
  // 돌출된 표면의 인덱스 (법선 방향이 반대로 가도록 정점 순서 반대로)
  for (let i = 0; i < indexCount; i += 3) {
    const a = indexArray[i] + vertexCount;
    const b = indexArray[i + 1] + vertexCount;
    const c = indexArray[i + 2] + vertexCount;
    
    newIndices.push(c, b, a); // 역순으로 정렬하여 법선이 바깥쪽을 향하게 함
  }
  
  // 측면 인덱스 생성 (원래 표면의 외곽선)
  // 삼각형 인덱스에서 에지 찾기
  const edges = new Map(); // 에지 맵: "v1,v2" => [count, face]
  
  // 모든 에지 찾기
  for (let i = 0; i < indexCount; i += 3) {
    const a = indexArray[i];
    const b = indexArray[i + 1];
    const c = indexArray[i + 2];
    
    // 에지 추가 (정점 인덱스가 작은 것이 먼저 오도록)
    const addEdge = (v1, v2) => {
      const key = v1 < v2 ? `${v1},${v2}` : `${v2},${v1}`;
      if (!edges.has(key)) {
        edges.set(key, { count: 1, v1, v2 });
      } else {
        const edge = edges.get(key);
        edge.count += 1;
      }
    };
    
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }
  
  // 외곽선 에지만 선택 (한 번만 사용된 에지)
  const outlineEdges = [];
  for (const edge of edges.values()) {
    if (edge.count === 1) {
      outlineEdges.push(edge);
    }
  }
  
  // 외곽선 에지를 따라 측면 삼각형 생성
  for (const edge of outlineEdges) {
    const { v1, v2 } = edge;
    const v3 = v1 + vertexCount;
    const v4 = v2 + vertexCount;
    
    // 사각형을 2개의 삼각형으로 분할
    newIndices.push(v1, v2, v3);
    newIndices.push(v2, v4, v3);
  }
  
  // 인덱스 설정
  extrudeGeometry.setIndex(newIndices);
  
  // 법선 계산
  extrudeGeometry.computeVertexNormals();
  
  // 메시 생성
  const extrudeMaterial = new THREE.MeshStandardMaterial({
    color: 0x2288ff,  // 파란색 계열
    side: THREE.DoubleSide,
    flatShading: false,
    metalness: 0.1,
    roughness: 0.6,
  });
  
  const extrudeMesh = new THREE.Mesh(extrudeGeometry, extrudeMaterial);
  
  // 기존 표면 제거 및 새 메시 추가
  scene.remove(closedArea);
  scene.add(extrudeMesh);
  
  // 메시 참조 업데이트
  closedArea = extrudeMesh;
  
  return extrudeMesh;
}

// 초기화 함수
function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  
  // 더 나은 조명을 위해 lights 추가
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  
  // 방향성 조명 추가
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(1, 1, 1);
  scene.add(directionalLight);
  
  const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
  directionalLight2.position.set(-1, 0.5, -1);
  scene.add(directionalLight2);

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

  // GUI 설정
  setupGUI();

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

  // 클릭 이벤트 추가: 모델 클릭 시 점 생성 및 선 그리기
  renderer.domElement.addEventListener('click', onClick, false);
  
  // 마우스 이동 이벤트 추가: 기존 점 위에서 커서 변경
  renderer.domElement.addEventListener('mousemove', onMouseMove, false);

  render();
}

// GUI 설정 함수
function setupGUI() {
  gui.add(params, 'matcap', Object.keys(matcaps)).name('Material');
  gui.add(params, 'showSurface').name('Show Surface').onChange(value => {
    if (closedArea) {
      closedArea.visible = value;
    }
  });
  
  // Extrude 관련 폴더 추가
  const extrudeFolder = gui.addFolder('Extrude Options');
  extrudeFolder.add(params, 'extrudeDistance', 0.01, 0.5).step(0.01).name('Extrude Distance');
  extrudeFolder.add(params, 'performExtrude').name('Perform Extrude');
  extrudeFolder.open(); // 폴더를 기본적으로 열어둠
  
  gui.add(params, 'clearPoints').name('Clear All');
}

// 두 점 사이에 곡선 생성 함수
function createCurveBetweenPoints(pointA, pointB) {
  const { point: pointAPos, normal: normA } = pointA;
  const { point: pointBPos, normal: normB } = pointB;
  
  // 두 점 사이를 N등분하여 표면상의 점들을 샘플링
  const sampleCount = 20000;
  const pointsOnSurface = [];

  for (let i = 0; i <= sampleCount; i++) {
    const t = i / sampleCount;
    // 두 점 사이 선형 보간
    let pos = new THREE.Vector3().lerpVectors(pointAPos, pointBPos, t);
    // 두 점의 법선을 보간하여 방향 결정
    let norm = new THREE.Vector3().lerpVectors(normA, normB, t).normalize();
    // 보간점에서 약간 위쪽(법선 방향)에서부터 반대 방향으로 레이캐스트
    const rayOrigin = pos.clone().addScaledVector(norm, 0.1);
    const sampleRaycaster = new THREE.Raycaster(rayOrigin, norm.clone().negate());
    const sampleIntersects = sampleRaycaster.intersectObject(targetMesh, true);
    // 원하는 오프셋 값
    const offset = 0.001;
    
    if (sampleIntersects.length > 0) {
      pos = sampleIntersects[0].point.clone().addScaledVector(sampleIntersects[0].face.normal, offset);
    } else {
      pos.addScaledVector(norm, offset);
    }
    pointsOnSurface.push(pos);
  }

  // Catmull-Rom 커브를 이용해 부드러운 곡선 생성
  const curve = new THREE.CatmullRomCurve3(pointsOnSurface);
  const curvePoints = curve.getPoints(100);
  const curveGeometry = new THREE.BufferGeometry().setFromPoints(curvePoints);
  const curveLine = new THREE.Line(curveGeometry, new THREE.LineBasicMaterial({ color: 0xff0000 }));
  scene.add(curveLine);
  
  // 생성된 곡선 반환
  return curveLine;
}

// 닫힌 영역 생성 함수 
function createClosedArea() {
  // 이미 닫힌 영역이 있다면 제거
  if (closedArea) {
    scene.remove(closedArea);
  }
  
  // 마지막 점과 첫 번째 점 사이에 곡선 생성
  const firstPoint = clickPoints[0];
  const lastPoint = clickPoints[clickPoints.length - 1];
  const closingLine = createCurveBetweenPoints(lastPoint, firstPoint);
  curveLines.push(closingLine);
  
  // 닫힌 영역임을 표시
  isDrawingClosed = true;
  
  // 첫 번째 점의 색상을 변경하여 시각적으로 구분
  if (firstPoint.marker) {
    firstPoint.marker.material.color.set(0x00ff00); // 초록색으로 변경
  }
  
  // Create the surface mesh
  createSurfaceFromClosedCurves();
  
  console.log("영역이 닫혔습니다!");
}

// 마우스 이동 이벤트 핸들러
function onMouseMove(event) {
  if (!targetMesh || clickPoints.length === 0) return;
  
  // 화면 좌표를 정규화된 디바이스 좌표(NDC)로 변환
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );

  // 마우스 레이캐스터 생성
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  
  // 이전 hover 상태 저장
  const prevHoveredIndex = hoveredPointIndex;
  hoveredPointIndex = -1;
  
  // 모든 점을 검사하여 마우스가 가까운 점 위에 있는지 확인
  clickPoints.forEach((pointData, index) => {
    if (pointData.marker) {
      // 레이캐스터와 마커 간 거리 계산
      const intersects = raycaster.intersectObject(pointData.marker);
      if (intersects.length > 0) {
        hoveredPointIndex = index;
      }
    }
  });
  
  // hover 상태 변경 시 커서 스타일 업데이트
  if (prevHoveredIndex !== hoveredPointIndex) {
    if (hoveredPointIndex === 0 && clickPoints.length > 2 && !isDrawingClosed) {
      // 첫 번째 점 위에 있고, 점이 3개 이상이고, 아직 닫히지 않은 경우 -> 선택 가능 표시
      renderer.domElement.style.cursor = 'pointer';
    } else if (hoveredPointIndex !== -1) {
      // 다른 점 위에 있는 경우 -> 일반 hover 표시
      renderer.domElement.style.cursor = 'crosshair';
    } else {
      // 점 위에 없는 경우 -> 기본 커서로 복원
      renderer.domElement.style.cursor = 'auto';
    }
  }
}

// 클릭 이벤트 핸들러 - 수정된 버전
function onClick(event) {
  // 화면 좌표를 정규화된 디바이스 좌표(NDC)로 변환
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );

  if (!targetMesh) return; // 모델이 로드되지 않은 경우

  // 이미 닫힌 영역인 경우 새로운 점 추가 방지
  if (isDrawingClosed) {
    return;
  }
  
  // 첫 번째 점을 클릭했는지 확인 (lasso 닫기)
  if (hoveredPointIndex === 0 && clickPoints.length > 2) {
    createClosedArea();
    return;
  }

  // Raycaster로 모델과의 교차점 계산
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(targetMesh, true);

  if (intersects.length > 0) {
    const intersect = intersects[0];
    let point = intersect.point.clone();

    // face.normal은 로컬 좌표이므로 월드 좌표로 변환
    let normal = intersect.face.normal.clone();
    normal.transformDirection(targetMesh.matrixWorld).normalize();
    
    // 클릭 방향 저장 (카메라에서 점까지의 방향)
    const clickDirection = new THREE.Vector3().subVectors(point, camera.position).normalize();

    // 약간 오프셋하여 z-fighting 방지 (법선 방향으로 0.001 만큼 이동)
    point.addScaledVector(normal, 0.001);

    // 빨간 구체 마커 생성
    const sphereGeom = new THREE.SphereGeometry(0.003, 16, 16); // 크기 조정
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const marker = new THREE.Mesh(sphereGeom, sphereMat);
    marker.position.copy(point);
    scene.add(marker);

    // 클릭한 점과 해당 법선 정보, 클릭 방향, 마커를 저장
    clickPoints.push({ 
      point: point, 
      normal: normal, 
      clickDirection: clickDirection, // 클릭 방향 저장 추가
      marker: marker 
    });

    // 두 번째 점부터는 이전 점과 현재 점 사이에 곡선 생성
    if (clickPoints.length >= 2) {
      const previousPoint = clickPoints[clickPoints.length - 2];
      const currentPoint = clickPoints[clickPoints.length - 1];
      
      // 두 점 사이에 곡선 생성
      const newCurveLine = createCurveBetweenPoints(previousPoint, currentPoint);
      
      // 생성된 곡선을 배열에 추가
      curveLines.push(newCurveLine);
    }
  }
}

function render() {
  material.matcap = matcaps[params.matcap];
  requestAnimationFrame(render);
  stats.update();
  controls.update();
  renderer.render(scene, camera);
}

init();