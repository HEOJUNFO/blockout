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
  showOriginal: false,
  showSurface: true,
  extrudeDistance: 0.02,
  performExtrude: function() {
    extrudeSurface(params.extrudeDistance);
  },
  clearPoints: function() {
    clearAllPointsAndCurves();
  }
};

const matcaps = {};
const stlLoader = new STLLoader();
const gui = new dat.GUI();

// 배열 선언
let clickPoints = [];
let curveLines = [];
let closedArea = null;
let isDrawingClosed = false;

// 마우스 관련 변수
let isDrawing = false;
let minDistanceBetweenPoints = 0.025;
let hoveredPointIndex = -1;
let lastMousePosition = new THREE.Vector2();

// Alt 키 상태 변수
let isAltKeyDown = false;

// 점 드래그 관련 변수
let selectedPointIndex = -1;
let isDraggingPoint = false;

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
  selectedPointIndex = -1;
  isDrawing = false;
  isDraggingPoint = false;
  
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

  // 메시 생성
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
    transparent: true,
    opacity: 0.7 // 반투명하게 설정
  });
  
  const surfaceMesh = new THREE.Mesh(surfaceGeometry, surfaceMaterial);
  scene.add(surfaceMesh);
  
  // Store the surface mesh for future reference
  closedArea = surfaceMesh;
  
  return surfaceMesh;
}

// 생성된 곡면을 기준으로 extrude 처리하는 함수
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
  
  // 조명 추가
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  
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

  // 이벤트 리스너 설정
  setupEventListeners();

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
  extrudeFolder.open();
  
  gui.add(params, 'clearPoints').name('Clear All');
}

// 이벤트 리스너 설정 함수
function setupEventListeners() {
  // 마우스 이벤트 리스너
  renderer.domElement.addEventListener('mousedown', onMouseDown);
  renderer.domElement.addEventListener('mousemove', onMouseMove);
  renderer.domElement.addEventListener('mouseup', onMouseUp);
  renderer.domElement.addEventListener('click', onClick);
  
  // 키보드 이벤트 리스너 추가 - Alt 키 감지
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  
  // Alt 키 상태가 변경될 때 확인용
  window.addEventListener('blur', () => {
    // 창이 비활성화되면 Alt 키 상태 초기화
    isAltKeyDown = false;
    if (isDrawing) {
      isDrawing = false;
      controls.enabled = true;
    }
    
    if (isDraggingPoint) {
      isDraggingPoint = false;
      selectedPointIndex = -1;
      controls.enabled = true;
    }
  });
}

// 키 다운 이벤트 핸들러
function onKeyDown(event) {
  // Alt 키 (18)가 눌렸을 때
  if (event.keyCode === 18) {
    isAltKeyDown = true;
    
    // 그리기 모드가 활성화되고 닫힌 영역이 없을 때 커서 변경
    if (!isDrawingClosed) {
      renderer.domElement.style.cursor = 'crosshair';
      
      // 컨트롤 비활성화 (Alt 키를 누른 상태에서 일시적으로)
      controls.enabled = false;
    }
  }
}

// 키 업 이벤트 핸들러
function onKeyUp(event) {
  // Alt 키가 떼졌을 때
  if (event.keyCode === 18) {
    isAltKeyDown = false;
    
    // 그리기 중이었다면 중단
    if (isDrawing) {
      isDrawing = false;
    }
    
    // 닫힌 영역이 없고 그리기 모드가 아닐 때 커서 복원
    if (!isDrawingClosed) {
      renderer.domElement.style.cursor = 'auto';
    }
    
    // 드래그 중이 아니면 컨트롤 다시 활성화
    if (!isDraggingPoint) {
      controls.enabled = true;
    }
  }
}

// 마우스 다운 이벤트 핸들러
function onMouseDown(event) {
  // 1. 닫힌 영역이 있고 점 위에 마우스가 있으면 드래그 모드 시작
  if (isDrawingClosed && hoveredPointIndex !== -1) {
    selectedPointIndex = hoveredPointIndex;
    isDraggingPoint = true;
    controls.enabled = false;
    return;
  }
  
  // 2. Alt 키를 누른 상태에서 그리기 모드 시작
  if (!targetMesh || isDrawingClosed || !isAltKeyDown) return;
  
  // Alt 키를 누른 상태에서는 컨트롤 비활성화 유지
  controls.enabled = false;
  
  // 화면 좌표를 정규화된 디바이스 좌표(NDC)로 변환
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  
  lastMousePosition.copy(mouse);
  
  // Raycaster로 모델과의 교차점 계산
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(targetMesh, true);
  
  if (intersects.length > 0) {
    isDrawing = true;
    
    // 첫 번째 점 추가
    addPointAtIntersection(intersects[0]);
    
    // 커서 변경
    renderer.domElement.style.cursor = 'crosshair';
  }
}

// 마우스 이동 이벤트 핸들러
function onMouseMove(event) {
  if (!targetMesh) return;
  
  // 화면 좌표를 정규화된 디바이스 좌표(NDC)로 변환
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  
  // 마우스 레이캐스터 생성
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  
  // 점 드래그 중일 때 처리
  if (isDraggingPoint && selectedPointIndex !== -1) {
    // 모델과의 교차점 확인
    const intersects = raycaster.intersectObject(targetMesh, true);
    if (intersects.length > 0) {
      // 선택된 점의 위치를 교차점으로 업데이트
      updatePointPosition(selectedPointIndex, intersects[0]);
    }
    return;
  }
  
  // 기존의 점 호버링 검사 코드
  const prevHoveredIndex = hoveredPointIndex;
  hoveredPointIndex = -1;
  
  // 모든 점을 검사하여 마우스가 가까운 점 위에 있는지 확인
  clickPoints.forEach((pointData, index) => {
    if (pointData.marker) {
      const intersects = raycaster.intersectObject(pointData.marker);
      if (intersects.length > 0) {
        hoveredPointIndex = index;
      }
    }
  });
  
  // hover 상태 변경 시 커서 스타일 업데이트
  if (prevHoveredIndex !== hoveredPointIndex) {
    if (hoveredPointIndex > 0 && !isDrawingClosed) {
      // 중간 점 위에 있고 닫힌 영역이 아닌 경우 -> 삭제 가능 표시
      renderer.domElement.style.cursor = 'cell'; // 셀 선택 커서로 변경 (scissors가 없어서 대체)
    } else if (hoveredPointIndex === 0 && clickPoints.length > 2 && !isDrawingClosed) {
      // 첫 번째 점 위에 있고, 점이 3개 이상이고, 아직 닫히지 않은 경우 -> 선택 가능 표시
      renderer.domElement.style.cursor = 'pointer';
    } else if (hoveredPointIndex !== -1 && isDrawingClosed) {
      // 점 위에 있고 닫힌 영역인 경우 -> 드래그 가능 표시
      renderer.domElement.style.cursor = 'move';
    } else if (isDrawing) {
      // 그리기 모드일 때
      renderer.domElement.style.cursor = 'crosshair';
    } else if (isAltKeyDown && !isDrawingClosed) {
      // Alt 키를 누르고 있고 닫힌 영역이 없을 때
      renderer.domElement.style.cursor = 'crosshair';
    } else {
      // 그외 경우
      renderer.domElement.style.cursor = 'auto';
    }
  }
  
  // 드래그 중이면 점 추가
  if (isDrawing) {
    // 마우스가 충분히 이동했는지 확인 (필터링)
    if (mouse.distanceTo(lastMousePosition) > 0.005) {
      lastMousePosition.copy(mouse);
      
      const intersects = raycaster.intersectObject(targetMesh, true);
      if (intersects.length > 0) {
        // 이전 점과 새 점 사이의 거리 확인
        const newIntersection = intersects[0];
        if (clickPoints.length > 0) {
          const lastPoint = clickPoints[clickPoints.length - 1].point;
          const newPoint = newIntersection.point.clone();
          
          // 최소 거리보다 멀리 있으면 새 점 추가
          if (lastPoint.distanceTo(newPoint) > minDistanceBetweenPoints) {
            addPointAtIntersection(newIntersection);
          }
        } else {
          addPointAtIntersection(newIntersection);
        }
      }
    }
  }
}

// 클릭 이벤트 핸들러 - 영역 닫기용 또는 점 제거용
function onClick(event) {
  // 드래그 중이었다면 클릭 처리 안함 (드래그 종료로 처리)
  if (isDraggingPoint) {
    return;
  }
  
  // Alt 키를 누르고 있을 때는 일반 클릭으로 처리하지 않음
  if (!targetMesh || isDrawingClosed || isDrawing || isAltKeyDown) return;
  
  // 첫 번째 점을 클릭했는지 확인 (lasso 닫기)
  if (hoveredPointIndex === 0 && clickPoints.length > 2) {
    createClosedArea();
    return;
  }
  
  // 점을 클릭했고, 닫힌 영역이 아닌 경우 해당 점까지 유지하고 이후 점들 삭제
  if (hoveredPointIndex > 0 && !isDrawingClosed) {
    trimPointsAndLines(hoveredPointIndex);
  }
}

// 선택한 점 이후의 점과 선들을 제거하는 함수
function trimPointsAndLines(pointIndex) {
  if (pointIndex < 1 || pointIndex >= clickPoints.length - 1) return;
  
  // pointIndex + 1부터 끝까지의 점들 제거
  for (let i = clickPoints.length - 1; i > pointIndex; i--) {
    // 점 마커 제거
    if (clickPoints[i].marker) {
      scene.remove(clickPoints[i].marker);
    }
    
    // 점 제거
    clickPoints.splice(i, 1);
  }
  
  // 선 제거 (점 제거 후에 수행)
  // 선은 pointIndex부터 끝까지 제거
  for (let i = curveLines.length - 1; i >= pointIndex; i--) {
    scene.remove(curveLines[i]);
    curveLines.splice(i, 1);
  }
  
  // 호버 상태 업데이트
  hoveredPointIndex = -1;
  
  console.log(`${pointIndex}번 점 이후의 점과 선들이 제거되었습니다.`);
  console.log(`남은 점: ${clickPoints.length}개, 남은 선: ${curveLines.length}개`);
}

// 마우스 업 이벤트 핸들러
function onMouseUp(event) {
  // 점 드래그 종료
  if (isDraggingPoint) {
    isDraggingPoint = false;
    
    // 표면 업데이트
    if (isDrawingClosed) {
      updateSurface();
    }
    
    // 컨트롤 다시 활성화
    controls.enabled = true;
    return;
  }
  
  if (isDrawing) {
    isDrawing = false;
    console.log(`그리기 완료: ${clickPoints.length}개 점 생성됨`);
    
    // Alt 키가 계속 눌려있으면 컨트롤은 계속 비활성화 유지
    if (isAltKeyDown) {
      controls.enabled = false;
    } else {
      controls.enabled = true;
    }
  }
}

// 점의 위치를 업데이트하는 함수
function updatePointPosition(index, intersection) {
  if (index < 0 || index >= clickPoints.length) return;
  
  // 교차점에서 새 위치와 법선 가져오기
  let point = intersection.point.clone();
  let normal = intersection.face.normal.clone();
  normal.transformDirection(targetMesh.matrixWorld).normalize();
  
  // 클릭 방향 업데이트 (카메라에서 점까지의 방향)
  const clickDirection = new THREE.Vector3().subVectors(point, camera.position).normalize();
  
  // z-fighting 방지를 위한 오프셋
  point.addScaledVector(normal, 0.001);
  
  // 점 데이터 업데이트
  const pointData = clickPoints[index];
  pointData.point.copy(point);
  pointData.normal.copy(normal);
  pointData.clickDirection.copy(clickDirection);
  
  // 마커 위치 업데이트
  if (pointData.marker) {
    pointData.marker.position.copy(point);
  }
  
  // 이 점과 연결된 선들 업데이트
  updateConnectedLines(index);
}

// 점과 연결된 선들을 업데이트하는 함수
function updateConnectedLines(index) {
  if (index < 0 || index >= clickPoints.length) return;
  
  // 이 점은 이전 점과 다음 점과 선으로 연결되어 있음
  const pointsCount = clickPoints.length;
  
  // 이전 점과의 선 업데이트 (첫 번째 점이 아닌 경우)
  if (index > 0) {
    const prevIndex = index - 1;
    updateLine(prevIndex, index);
  } else if (isDrawingClosed) {
    // 첫 번째 점이고 영역이 닫혔으면 마지막 점과의 선 업데이트
    updateLine(pointsCount - 1, 0);
  }
  
  // 다음 점과의 선 업데이트 (마지막 점이 아닌 경우)
  if (index < pointsCount - 1) {
    updateLine(index, index + 1);
  } else if (isDrawingClosed) {
    // 마지막 점이고 영역이 닫혔으면 첫 번째 점과의 선 업데이트
    updateLine(pointsCount - 1, 0);
  }
}

// 두 점 사이의 선을 업데이트하는 함수
function updateLine(startIndex, endIndex) {
  // 인덱스가 유효한지 확인
  if (startIndex < 0 || startIndex >= clickPoints.length || 
      endIndex < 0 || endIndex >= clickPoints.length) {
    return;
  }
  
  const startPoint = clickPoints[startIndex].point;
  const endPoint = clickPoints[endIndex].point;
  
  // 곡선 라인 인덱스 찾기
  let lineIndex = -1;
  
  // 일반적인 경우 - 인접한 두 점 사이의 선
  if (endIndex === startIndex + 1) {
    lineIndex = startIndex;
  } 
  // 닫힌 영역의 마지막 선
  else if (startIndex === clickPoints.length - 1 && endIndex === 0) {
    lineIndex = curveLines.length - 1;
  }
  
  if (lineIndex >= 0 && lineIndex < curveLines.length) {
    // 기존 선 제거
    scene.remove(curveLines[lineIndex]);
    
    // 새 선 생성
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([startPoint, endPoint]);
    const lineMaterial = new THREE.LineBasicMaterial({ 
      color: (startIndex === clickPoints.length - 1 && endIndex === 0) ? 0x00ff00 : 0xff0000 
    });
    const line = new THREE.Line(lineGeometry, lineMaterial);
    scene.add(line);
    
    // 배열에서 선 교체
    curveLines[lineIndex] = line;
  }
}

// 표면을 업데이트하는 함수
function updateSurface() {
  // 기존 표면 제거
  if (closedArea) {
    scene.remove(closedArea);
    closedArea = null;
  }
  
  // 새로운 표면 생성
  createSurfaceFromClosedCurves();
}

// 교차점에서 점 추가하는 함수
function addPointAtIntersection(intersect) {
  let point = intersect.point.clone();
  
  // face.normal은 로컬 좌표이므로 월드 좌표로 변환
  let normal = intersect.face.normal.clone();
  normal.transformDirection(targetMesh.matrixWorld).normalize();
  
  // 클릭 방향 저장 (카메라에서 점까지의 방향)
  const clickDirection = new THREE.Vector3().subVectors(point, camera.position).normalize();
  
  // 약간 오프셋하여 z-fighting 방지 (법선 방향으로 0.001 만큼 이동)
  point.addScaledVector(normal, 0.001);
  
  // 마커 크기 설정 (첫 번째 점은 크게, 나머지는 작게)
  const markerSize = clickPoints.length === 0 ? 0.005 : 0.002;
  const sphereGeom = new THREE.SphereGeometry(markerSize, 8, 8);
  const sphereMat = new THREE.MeshBasicMaterial({ 
    color: clickPoints.length === 0 ? 0x00ff00 : 0xff0000 // 첫 번째 점은 초록색
  });
  const marker = new THREE.Mesh(sphereGeom, sphereMat);
  marker.position.copy(point);
  scene.add(marker);
  
  // 새 점 정보 저장
  const newPointData = { 
    point: point, 
    normal: normal, 
    clickDirection: clickDirection,
    marker: marker 
  };
  
  clickPoints.push(newPointData);
  
  // 두 번째 점부터는 이전 점과 현재 점 사이에 직접 연결
  if (clickPoints.length >= 2) {
    const previousPoint = clickPoints[clickPoints.length - 2];
    const currentPoint = clickPoints[clickPoints.length - 1];
    
    // 두 점 사이에 직접 연결하는 선 생성
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      previousPoint.point,
      currentPoint.point
    ]);
    
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0xff0000 });
    const line = new THREE.Line(lineGeometry, lineMaterial);
    scene.add(line);
    
    // 생성된 선을 배열에 추가
    curveLines.push(line);
  }
}

// 닫힌 영역 생성 함수
function createClosedArea() {
  // 이미 닫힌 영역이 있다면 제거
  if (closedArea) {
    scene.remove(closedArea);
  }
  
  // 마지막 점과 첫 번째 점 사이에 직접 연결하는 선 생성
  const firstPoint = clickPoints[0];
  const lastPoint = clickPoints[clickPoints.length - 1];
  
  const lineGeometry = new THREE.BufferGeometry().setFromPoints([
    lastPoint.point,
    firstPoint.point
  ]);
  
  const lineMaterial = new THREE.LineBasicMaterial({ color: 0x00ff00 }); // 닫는 선은 초록색
  const closingLine = new THREE.Line(lineGeometry, lineMaterial);
  scene.add(closingLine);
  
  // 생성된 선을 배열에 추가
  curveLines.push(closingLine);
  
  // 닫힌 영역임을 표시
  isDrawingClosed = true;
  
  // Create the surface mesh
  createSurfaceFromClosedCurves();
  
  // 컨트롤 다시 활성화
  controls.enabled = true;
  
  console.log("영역이 닫혔습니다!");
}

function render() {
  material.matcap = matcaps[params.matcap];
  requestAnimationFrame(render);
  stats.update();
  controls.update();
  renderer.render(scene, camera);
}

init();