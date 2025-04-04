import Stats from 'three/examples/jsm/libs/stats.module.js';
import * as dat from 'three/examples/jsm/libs/lil-gui.module.min.js';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import Delaunator from 'delaunator'; // Delaunator 라이브러리 필요

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

let stats, scene, camera, renderer, controls;
let targetMesh = null;
let material;

const params = {
  matcap: 'Clay',
  clearPoints: function() {
    clearAllPointsAndCurves();
  }
};

const matcaps = {};
const stlLoader = new STLLoader();
const gui = new dat.GUI();

let clickPoints = [];   // { point, normal, marker }
let curveLines = [];    // 빨간 곡선(Line) 객체들
let closedArea = null;  // 닫힌 경계(선)
let closedSurface = null; // 생성된 커브드 패치(곡면)
let isDrawingClosed = false; // 닫힘 여부

const POINT_DETECTION_RADIUS = 0.02;
let hoveredPointIndex = -1;

function isPointInsidePolygon(pt, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
                      (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

///////////////////////
// 초기화/클리어 함수
///////////////////////
function clearAllPointsAndCurves() {
  clickPoints.forEach(pointData => {
    if (pointData.marker) {
      scene.remove(pointData.marker);
    }
  });
  curveLines.forEach(line => {
    scene.remove(line);
  });
  if (closedArea) {
    scene.remove(closedArea);
    closedArea = null;
  }
  if (closedSurface) {
    scene.remove(closedSurface);
    closedSurface = null;
  }
  clickPoints = [];
  curveLines = [];
  isDrawingClosed = false;
  hoveredPointIndex = -1;
  renderer.domElement.style.cursor = 'auto';
}

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
  targetMesh.position.set(0, 0, 0);
}

///////////////////////
// 초기화 및 이벤트 설정
///////////////////////
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
  
  gui.add(params, 'matcap', Object.keys(matcaps)).name('Material');
  gui.add(params, 'clearPoints').name('Clear All Points');
  
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
  
  renderer.domElement.addEventListener('click', onClick, false);
  renderer.domElement.addEventListener('mousemove', onMouseMove, false);
  
  render();
}

///////////////////////
// 빨간 곡선(경계) 생성 함수 – 두 점 사이를 Catmull-Rom 보간
///////////////////////
function createCurveBetweenPoints(pointA, pointB) {
  const { point: pointAPos, normal: normA } = pointA;
  const { point: pointBPos, normal: normB } = pointB;
  const sampleCount = 20000;
  const pointsOnSurface = [];
  
  for (let i = 0; i <= sampleCount; i++) {
    const t = i / sampleCount;
    let pos = new THREE.Vector3().lerpVectors(pointAPos, pointBPos, t);
    let norm = new THREE.Vector3().lerpVectors(normA, normB, t).normalize();
    const rayOrigin = pos.clone().addScaledVector(norm, 0.1);
    const sampleRaycaster = new THREE.Raycaster(rayOrigin, norm.clone().negate());
    const sampleIntersects = sampleRaycaster.intersectObject(targetMesh, true);
    const offset = 0.001;
    
    if (sampleIntersects.length > 0) {
      pos = sampleIntersects[0].point.clone().addScaledVector(sampleIntersects[0].face.normal, offset);
    } else {
      pos.addScaledVector(norm, offset);
    }
    pointsOnSurface.push(pos);
  }
  
  const curve = new THREE.CatmullRomCurve3(pointsOnSurface);
  const curvePoints = curve.getPoints(100);
  const curveGeometry = new THREE.BufferGeometry().setFromPoints(curvePoints);
  const curveLine = new THREE.Line(curveGeometry, new THREE.LineBasicMaterial({ color: 0xff0000 }));
  scene.add(curveLine);
  
  return curveLine;
}

///////////////////////
// 닫힌 경계 생성 – 첫 번째 점에서 다시 클릭하면 경계를 닫음
///////////////////////
function createClosedArea() {
  if (closedArea) {
    scene.remove(closedArea);
  }
  
  const firstPoint = clickPoints[0];
  const lastPoint = clickPoints[clickPoints.length - 1];
  const closingLine = createCurveBetweenPoints(lastPoint, firstPoint);
  curveLines.push(closingLine);
  
  isDrawingClosed = true;
  
  if (firstPoint.marker) {
    firstPoint.marker.material.color.set(0x00ff00);
  }
  
  console.log("영역이 닫혔습니다!");
  
  // 평면이 아닌, 경계(red curve)를 그대로 따르는 커브드 패치 생성
  createCurvedSurfaceFromClosedCurve();
}

///////////////////////
// ★ 핵심: 커브드 패치 생성 함수
// 경계 red curve의 밀집된 3D 점들을 2D로 투영한 후, 내부 grid 점들을 생성하고
// 평균값 좌표(mean value coordinates)를 사용해 3D로 매핑한 후 Delaunay 삼각분할로 메시를 구성
///////////////////////
function createCurvedSurfaceFromClosedCurve() {
  // (1) 경계 점 추출: 각 빨간 곡선(curveLines)에서 충분히 샘플링
  let boundaryPoints3D = [];
  curveLines.forEach(curveLine => {
    const pts = curveLine.geometry.attributes.position.array;
    for (let i = 0; i < pts.length; i += 3) {
      boundaryPoints3D.push(new THREE.Vector3(pts[i], pts[i+1], pts[i+2]));
    }
  });
  
  // (2) 경계점들이 거의 한 평면상에 있다고 가정하고, 첫 3점으로 평면 설정
  const plane = new THREE.Plane().setFromCoplanarPoints(boundaryPoints3D[0], boundaryPoints3D[1], boundaryPoints3D[2]);
  
  // (3) 평면상의 좌표계를 생성 (basis: U, V)
  let U = new THREE.Vector3(1, 0, 0);
  if (Math.abs(plane.normal.dot(U)) > 0.99) {
    U.set(0, 1, 0);
  }
  U.crossVectors(plane.normal, U).normalize();
  const V = new THREE.Vector3().crossVectors(plane.normal, U).normalize();
  const origin = boundaryPoints3D[0].clone();
  
  // (4) 경계 3D 점들을 2D로 투영
  const boundaryPoints2D = boundaryPoints3D.map(p => {
    const diff = new THREE.Vector3().subVectors(p, origin);
    return new THREE.Vector2(diff.dot(U), diff.dot(V));
  });
  
  // (5) 경계 2D 다각형의 바운딩 박스 내에서 grid 방식으로 내부 점 생성
  let interiorPoints2D = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  boundaryPoints2D.forEach(p => {
    if(p.x < minX) minX = p.x;
    if(p.y < minY) minY = p.y;
    if(p.x > maxX) maxX = p.x;
    if(p.y > maxY) maxY = p.y;
  });
  
  const gridSize = 0.02; // 해상도 조절
  for(let x = minX; x <= maxX; x += gridSize) {
    for(let y = minY; y <= maxY; y += gridSize) {
      const pt = new THREE.Vector2(x, y);
      if(isPointInsidePolygon(pt, boundaryPoints2D)) {
        interiorPoints2D.push(pt);
      }
    }
  }
  
  // (6) 2D상의 전체 점: 경계점 + 내부 grid 점들
  const allPoints2D = boundaryPoints2D.concat(interiorPoints2D);
  
  // (7) 내부 점들은 경계에 따른 보간으로 3D 좌표 매핑 – 평균값 좌표 이용
  function meanValueCoordinates(p, polygon) {
    const n = polygon.length;
    let weights = new Array(n).fill(0);
    let totalWeight = 0;
    for(let i=0; i<n; i++){
      const prev = polygon[(i - 1 + n) % n];
      const curr = polygon[i];
      const next = polygon[(i + 1) % n];
      const v_i = new THREE.Vector2().subVectors(curr, p);
      const d_i = v_i.length();
      if(d_i < 1e-6) {
        weights[i] = 1;
        totalWeight = 1;
        for(let j=0; j<n; j++){
          if(j !== i) weights[j] = 0;
        }
        return weights;
      }
      const v_prev = new THREE.Vector2().subVectors(prev, p);
      const v_next = new THREE.Vector2().subVectors(next, p);
      const theta_i = Math.acos(THREE.MathUtils.clamp(v_i.dot(v_next) / (v_i.length()*v_next.length()), -1, 1));
      const theta_prev = Math.acos(THREE.MathUtils.clamp(v_prev.dot(v_i) / (v_prev.length()*v_i.length()), -1, 1));
      const tan1 = Math.tan(theta_prev / 2);
      const tan2 = Math.tan(theta_i / 2);
      const w = (tan1 + tan2) / d_i;
      weights[i] = w;
      totalWeight += w;
    }
    return weights.map(w => w / totalWeight);
  }
  
  function map2Dto3D(pt2D) {
    const weights = meanValueCoordinates(pt2D, boundaryPoints2D);
    let mapped = new THREE.Vector3(0,0,0);
    for(let i=0; i<boundaryPoints3D.length; i++){
      mapped.addScaledVector(boundaryPoints3D[i], weights[i] || 0);
    }
    return mapped;
  }
  
  // (8) 모든 2D 점을 3D로 매핑 (경계점은 그대로 사용)
  const allPoints3D = allPoints2D.map(pt2D => {
    for(let i=0; i<boundaryPoints2D.length; i++){
      if(pt2D.distanceTo(boundaryPoints2D[i]) < 1e-6){
        return boundaryPoints3D[i].clone();
      }
    }
    return map2Dto3D(pt2D);
  });
  
  // (9) 2D 점 배열을 Delaunay 삼각분할 (Delaunator 이용)
  const pointsForTriangulation = allPoints2D.map(p => [p.x, p.y]);
  const delaunay = Delaunator.from(pointsForTriangulation);
  const indices = delaunay.triangles;
  
  // (10) 3D 점과 삼각형 인덱스로 메시 생성
  const geometry = new THREE.BufferGeometry();
  const vertices = new Float32Array(allPoints3D.length * 3);
  for(let i=0; i<allPoints3D.length; i++){
    vertices[i*3] = allPoints3D[i].x;
    vertices[i*3+1] = allPoints3D[i].y;
    vertices[i*3+2] = allPoints3D[i].z;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(Array.from(indices));
  geometry.computeVertexNormals();
  
  const surfaceMaterial = new THREE.MeshBasicMaterial({
    color: 0x00ffff,
    opacity: 0.7,
    transparent: true,
    side: THREE.DoubleSide
  });
  closedSurface = new THREE.Mesh(geometry, surfaceMaterial);
  scene.add(closedSurface);
}

///////////////////////
// 마우스 이동 및 클릭 이벤트 핸들러
///////////////////////
function onMouseMove(event) {
  if (!targetMesh || clickPoints.length === 0) return;
  
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  
  const prevHoveredIndex = hoveredPointIndex;
  hoveredPointIndex = -1;
  
  clickPoints.forEach((pointData, index) => {
    if (pointData.marker) {
      const intersects = raycaster.intersectObject(pointData.marker);
      if (intersects.length > 0) {
        hoveredPointIndex = index;
      }
    }
  });
  
  if (prevHoveredIndex !== hoveredPointIndex) {
    if (hoveredPointIndex === 0 && clickPoints.length > 2 && !isDrawingClosed) {
      renderer.domElement.style.cursor = 'pointer';
    } else if (hoveredPointIndex !== -1) {
      renderer.domElement.style.cursor = 'crosshair';
    } else {
      renderer.domElement.style.cursor = 'auto';
    }
  }
}

function onClick(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  
  if (!targetMesh) return;
  
  if (isDrawingClosed) {
    return;
  }
  
  if (hoveredPointIndex === 0 && clickPoints.length > 2) {
    createClosedArea();
    return;
  }
  
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(targetMesh, true);
  
  if (intersects.length > 0) {
    const intersect = intersects[0];
    let point = intersect.point.clone();
    
    let normal = intersect.face.normal.clone();
    normal.transformDirection(targetMesh.matrixWorld).normalize();
    
    point.addScaledVector(normal, 0.001);
    
    const sphereGeom = new THREE.SphereGeometry(0.01, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const marker = new THREE.Mesh(sphereGeom, sphereMat);
    marker.position.copy(point);
    scene.add(marker);
    
    clickPoints.push({ point: point, normal: normal, marker: marker });
    
    if (clickPoints.length >= 2) {
      const previousPoint = clickPoints[clickPoints.length - 2];
      const currentPoint = clickPoints[clickPoints.length - 1];
      const newCurveLine = createCurveBetweenPoints(previousPoint, currentPoint);
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
