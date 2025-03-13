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
  thickness: 0.05, // Adding thickness parameter with default value
  curveQuality: 20, // 곡선 품질 파라미터
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
let minDistanceBetweenPoints = 0.01;
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

// 두 점 사이에 모델 표면을 따라 곡선 생성 함수
function createCurveBetweenPoints(pointA, pointB) {
  const { point: pointAPos, normal: normA } = pointA;
  const { point: pointBPos, normal: normB } = pointB;
  
  // 두 점 사이의 거리에 따라 샘플 수 조정
  const distance = pointAPos.distanceTo(pointBPos);
  // 기본 샘플 수
  const baseSampleCount = params.curveQuality; 
  // 거리에 따라 샘플 수 조정 (최소 20개)
  const sampleCount = Math.max(baseSampleCount, Math.floor(distance * 500));
  
  // 표면상의 점들 샘플링
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
      // 레이캐스트 히트 포인트를 사용하고 법선 방향으로 약간 오프셋
      let hitNormal = sampleIntersects[0].face.normal.clone();
      hitNormal.transformDirection(targetMesh.matrixWorld);
      pos = sampleIntersects[0].point.clone().addScaledVector(hitNormal, offset);
    } else {
      // 레이캐스트 실패 시 기존 보간점을 사용하고 보간된 법선 방향으로 오프셋
      pos.addScaledVector(norm, offset);
    }
    pointsOnSurface.push(pos);
  }

  // 샘플링된 점이 너무 많으면 간소화 (성능 최적화)
  const simplifiedPoints = [];
  const simplificationFactor = Math.max(1, Math.floor(pointsOnSurface.length / 100));
  for (let i = 0; i < pointsOnSurface.length; i += simplificationFactor) {
    simplifiedPoints.push(pointsOnSurface[i]);
  }
  // 끝점 추가 (간소화 과정에서 빠질 수 있음)
  if (simplifiedPoints[simplifiedPoints.length - 1] !== pointsOnSurface[pointsOnSurface.length - 1]) {
    simplifiedPoints.push(pointsOnSurface[pointsOnSurface.length - 1]);
  }

  // Catmull-Rom 커브를 이용해 부드러운 곡선 생성
  const curve = new THREE.CatmullRomCurve3(simplifiedPoints);
  const curvePoints = curve.getPoints(50); // 최종 표시용 점 개수
  const curveGeometry = new THREE.BufferGeometry().setFromPoints(curvePoints);
  const lineMaterial = new THREE.LineBasicMaterial({ 
    color: (pointA === clickPoints[clickPoints.length - 1] && pointB === clickPoints[0]) ? 0x00ff00 : 0xff0000 
  });
  const curveLine = new THREE.Line(curveGeometry, lineMaterial);
  scene.add(curveLine);
  
  // 생성된 곡선 반환
  return curveLine;
}

// Function to create a surface from the closed area curves
function createSurfaceFromClosedCurves() {
  if (!isDrawingClosed || curveLines.length === 0) {
    console.warn("Cannot create surface: area is not closed or no curves available");
    return;
  }
  
  // 1. Collect all boundary points from curves
  const boundaryPoints = [];
  
  curveLines.forEach(curveLine => {
    const positions = curveLine.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const point = new THREE.Vector3();
      point.fromBufferAttribute(positions, i);
      boundaryPoints.push(point);
    }
  });
  
  // 2. Calculate average normal from the clicked points
  const averageNormal = new THREE.Vector3();
  clickPoints.forEach(pointData => {
    averageNormal.add(pointData.normal);
  });
  averageNormal.normalize();
  
  // 3. Create a plane using the average normal and centroid
  const centroid = new THREE.Vector3();
  boundaryPoints.forEach(point => {
    centroid.add(point);
  });
  centroid.divideScalar(boundaryPoints.length);
  
  // 4. Project the boundary points onto the plane
  // Create a coordinate system on the plane
  const tempUp = new THREE.Vector3(0, 1, 0);
  if (Math.abs(averageNormal.dot(tempUp)) > 0.9) {
    tempUp.set(1, 0, 0); // Use X axis if normal is close to Y
  }
  
  const tangent1 = new THREE.Vector3().crossVectors(averageNormal, tempUp).normalize();
  const tangent2 = new THREE.Vector3().crossVectors(averageNormal, tangent1).normalize();
  
  // Project boundary points to 2D
  const boundary2D = [];
  boundaryPoints.forEach(point => {
    const relativePos = point.clone().sub(centroid);
    const x = relativePos.dot(tangent1);
    const y = relativePos.dot(tangent2);
    boundary2D.push(new THREE.Vector2(x, y));
  });
  
  // 5. Triangulate the 2D polygon
  const triangles = triangulate2DPolygon(boundary2D);
  
  // 6. Create 3D vertices for the triangulation - for the front face
  const frontPositions = new Float32Array(triangles.length * 3);
  const frontNormals = new Float32Array(triangles.length * 3);
  
  // Map from original point indices to vertices with normals from raycasting
  const vertexMap = new Map();
  
  for (let i = 0; i < triangles.length; i++) {
    const point2D = triangles[i];
    
    // Get or create the 3D vertex
    let vertex3D;
    const key = `${point2D.x.toFixed(5)},${point2D.y.toFixed(5)}`;
    
    if (vertexMap.has(key)) {
      // Reuse existing vertex
      vertex3D = vertexMap.get(key);
    } else {
      // Convert 2D point back to 3D in model space
      const worldPoint = centroid.clone()
        .add(tangent1.clone().multiplyScalar(point2D.x))
        .add(tangent2.clone().multiplyScalar(point2D.y));
      
      // Raycast to find the exact point on the model surface
      const rayStart = worldPoint.clone().add(averageNormal.clone().multiplyScalar(0.1));
      const rayDir = averageNormal.clone().negate();
      
      const raycaster = new THREE.Raycaster(rayStart, rayDir);
      const intersects = raycaster.intersectObject(targetMesh, true);
      
      if (intersects.length > 0) {
        // Use the intersection point and normal
        vertex3D = {
          position: intersects[0].point.clone(),
          normal: intersects[0].face.normal.clone().transformDirection(targetMesh.matrixWorld)
        };
        vertex3D.position.addScaledVector(vertex3D.normal, 0.001); // Slight offset
      } else {
        // Fallback - use the plane point with average normal
        vertex3D = {
          position: worldPoint.clone(),
          normal: averageNormal.clone()
        };
      }
      
      vertexMap.set(key, vertex3D);
    }
    
    // Set position and normal for front face
    frontPositions[i * 3] = vertex3D.position.x;
    frontPositions[i * 3 + 1] = vertex3D.position.y;
    frontPositions[i * 3 + 2] = vertex3D.position.z;
    
    frontNormals[i * 3] = vertex3D.normal.x;
    frontNormals[i * 3 + 1] = vertex3D.normal.y;
    frontNormals[i * 3 + 2] = vertex3D.normal.z;
  }
  
  // 7. Create back face positions by offsetting front face along normals
  const backPositions = new Float32Array(frontPositions.length);
  const backNormals = new Float32Array(frontNormals.length);
  
  for (let i = 0; i < frontPositions.length; i += 3) {
    const nx = frontNormals[i];
    const ny = frontNormals[i + 1];
    const nz = frontNormals[i + 2];
    
    // Offset along normal by thickness amount
    backPositions[i] = frontPositions[i] + nx * params.thickness;
    backPositions[i + 1] = frontPositions[i + 1] + ny * params.thickness;
    backPositions[i + 2] = frontPositions[i + 2] + nz * params.thickness;
    
    // Invert normals for back face
    backNormals[i] = -nx;
    backNormals[i + 1] = -ny;
    backNormals[i + 2] = -nz;
  }
  
  // 동적 배열을 사용하여 정점과 법선 수집
  const positionArray = [];
  const normalArray = [];
  
  // 전면 정점 추가
  for (let i = 0; i < frontPositions.length; i++) {
    positionArray.push(frontPositions[i]);
    normalArray.push(frontNormals[i]);
  }
  
  // 후면 정점 추가
  for (let i = 0; i < backPositions.length; i++) {
    positionArray.push(backPositions[i]);
    normalArray.push(backNormals[i]);
  }
  
  // 삼각형 인덱스를 구성하여 전면과 후면을 채움
  const frontFaceCount = triangles.length / 3;
  const vertexCount = frontPositions.length / 3;
  
  // 측면 벽 생성
  const edgeMap = new Map(); // 가장자리를 추적하기 위한 맵
  
  // 전면 면의 가장자리 찾기
  for (let i = 0; i < frontFaceCount; i++) {
    const idx0 = i * 3;
    const idx1 = idx0 + 1;
    const idx2 = idx0 + 2;
    
    // 세 변 검사
    addEdge(idx0, idx1);
    addEdge(idx1, idx2);
    addEdge(idx2, idx0);
  }
  
  // 가장자리 추가 헬퍼 함수
  function addEdge(a, b) {
    const edgeKey = a < b ? `${a}-${b}` : `${b}-${a}`;
    
    if (edgeMap.has(edgeKey)) {
      // 내부 가장자리는 제거 (두 번 나타남)
      edgeMap.delete(edgeKey);
    } else {
      // 새 가장자리 추가
      edgeMap.set(edgeKey, [a, b]);
    }
  }
  
  // 남은 가장자리는 경계 가장자리
  for (const [key, [a, b]] of edgeMap.entries()) {
    // 전면 정점
    const ax = frontPositions[a * 3];
    const ay = frontPositions[a * 3 + 1];
    const az = frontPositions[a * 3 + 2];
    
    const bx = frontPositions[b * 3];
    const by = frontPositions[b * 3 + 1];
    const bz = frontPositions[b * 3 + 2];
    
    // 후면 정점 (전면 + vertexCount)
    const cx = backPositions[a * 3];
    const cy = backPositions[a * 3 + 1];
    const cz = backPositions[a * 3 + 2];
    
    const dx = backPositions[b * 3];
    const dy = backPositions[b * 3 + 1];
    const dz = backPositions[b * 3 + 2];
    
    // 벽 법선 계산 (전면과 가장자리 방향에 수직)
    const edgeDir = new THREE.Vector3(
      bx - ax,
      by - ay,
      bz - az
    ).normalize();
    
    const faceNormal = new THREE.Vector3(
      frontNormals[a * 3],
      frontNormals[a * 3 + 1],
      frontNormals[a * 3 + 2]
    );
    
    const wallNormal = new THREE.Vector3().crossVectors(edgeDir, faceNormal).normalize();
    
    // 첫 번째 삼각형: a, b, c
    positionArray.push(ax, ay, az);
    positionArray.push(bx, by, bz);
    positionArray.push(cx, cy, cz);
    
    for (let i = 0; i < 3; i++) {
      normalArray.push(wallNormal.x, wallNormal.y, wallNormal.z);
    }
    
    // 두 번째 삼각형: b, d, c
    positionArray.push(bx, by, bz);
    positionArray.push(dx, dy, dz);
    positionArray.push(cx, cy, cz);
    
    for (let i = 0; i < 3; i++) {
      normalArray.push(wallNormal.x, wallNormal.y, wallNormal.z);
    }
  }
  
  // 수집된 데이터로 Float32Array 생성
  const positions = new Float32Array(positionArray);
  const normals = new Float32Array(normalArray);
  
  // 단일 지오메트리 생성
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  
  // 재질 생성
  const surfaceMaterial = new THREE.MeshMatcapMaterial({
    matcap: matcaps['Red Wax'],
    side: THREE.FrontSide,
    flatShading: false
  });
  
  // 메시 생성
  const surfaceMesh = new THREE.Mesh(geometry, surfaceMaterial);
  scene.add(surfaceMesh);
  
  // 참조를 위해 저장
  closedArea = surfaceMesh;
  
  return surfaceMesh;
}

// Function to triangulate a 2D polygon
function triangulate2DPolygon(points) {
  // Simple ear clipping algorithm for triangulation
  if (points.length < 3) return [];
  
  // Make a copy of the points to work with
  const polygon = [...points];
  
  // Make sure the polygon is oriented correctly
  if (!isPolygonClockwise(polygon)) {
    polygon.reverse();
  }
  
  const triangleVertices = [];
  
  // Continue until we can't remove any more ears
  while (polygon.length > 3) {
    let earFound = false;
    
    // Try to find and remove an ear
    for (let i = 0; i < polygon.length; i++) {
      const prev = (i === 0) ? polygon.length - 1 : i - 1;
      const next = (i === polygon.length - 1) ? 0 : i + 1;
      
      const p0 = polygon[prev];
      const p1 = polygon[i];
      const p2 = polygon[next];
      
      // Check if vertex forms an ear (convex and no points inside)
      if (isEar(polygon, i)) {
        // Add triangle vertices in clockwise order
        triangleVertices.push(p0.clone(), p1.clone(), p2.clone());
        
        // Remove the ear tip
        polygon.splice(i, 1);
        earFound = true;
        break;
      }
    }
    
    // If we can't find any more ears, we're stuck - add dense sampling
    if (!earFound) {
      // Fall back to dense sampling
      return createDenseTriangleGrid(points);
    }
  }
  
  // Add the final triangle
  if (polygon.length === 3) {
    triangleVertices.push(
      polygon[0].clone(),
      polygon[1].clone(),
      polygon[2].clone()
    );
  }
  
  return triangleVertices;
}

// Check if polygon vertices are in clockwise order
function isPolygonClockwise(polygon) {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % polygon.length];
    sum += (p2.x - p1.x) * (p2.y + p1.y);
  }
  return sum > 0;
}

// Check if a vertex is an ear (forms a convex angle and no points inside)
function isEar(polygon, index) {
  const n = polygon.length;
  
  // Get the three consecutive vertices
  const prev = (index === 0) ? n - 1 : index - 1;
  const next = (index === n - 1) ? 0 : index + 1;
  
  const p0 = polygon[prev];
  const p1 = polygon[index];
  const p2 = polygon[next];
  
  // Check if the vertex forms a convex angle
  const crossProduct = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
  if (crossProduct <= 0) return false; // Not convex
  
  // Check if any other vertex is inside the triangle
  for (let i = 0; i < n; i++) {
    if (i === prev || i === index || i === next) continue;
    
    if (isPointInTriangle(polygon[i], p0, p1, p2)) {
      return false; // Another point is inside
    }
  }
  
  return true;
}

// Check if a point is inside a triangle
function isPointInTriangle(p, a, b, c) {
  // Barycentric coordinate method
  const areaABC = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
  const areaPBC = Math.abs((b.x - p.x) * (c.y - p.y) - (c.x - p.x) * (b.y - p.y));
  const areaPAC = Math.abs((a.x - p.x) * (c.y - p.y) - (c.x - p.x) * (a.y - p.y));
  const areaPAB = Math.abs((a.x - p.x) * (b.y - p.y) - (b.x - p.x) * (a.y - p.y));
  
  // Allow for small floating point errors
  const epsilon = 0.0000001;
  return Math.abs(areaABC - (areaPBC + areaPAC + areaPAB)) < epsilon;
}

// Fallback method: create a dense grid of triangles
function createDenseTriangleGrid(boundaryPoints) {
  // Find the bounding box
  const minX = Math.min(...boundaryPoints.map(p => p.x));
  const maxX = Math.max(...boundaryPoints.map(p => p.x));
  const minY = Math.min(...boundaryPoints.map(p => p.y));
  const maxY = Math.max(...boundaryPoints.map(p => p.y));
  
  // Create a dense grid
  const gridSize = 40; // Higher density
  const stepX = (maxX - minX) / gridSize;
  const stepY = (maxY - minY) / gridSize;
  
  // Create vertices
  const vertices = [];
  
  // Create grid points and check if they're inside the polygon
  for (let i = 0; i <= gridSize; i++) {
    for (let j = 0; j <= gridSize; j++) {
      const x = minX + i * stepX;
      const y = minY + j * stepY;
      const point = new THREE.Vector2(x, y);
      
      if (isPointInPolygon(point, boundaryPoints)) {
        vertices.push(point.clone());
      }
    }
  }
  
  // Add boundary points to ensure the edge is well-defined
  boundaryPoints.forEach(p => {
    vertices.push(p.clone());
  });
  
  // Create Delaunay triangulation
  const delaunay = computeDelaunay(vertices);
  
  // Filter triangles to keep only those inside the boundary
  const triangleVertices = [];
  
  for (let i = 0; i < delaunay.length; i += 3) {
    const p0 = delaunay[i];
    const p1 = delaunay[i + 1];
    const p2 = delaunay[i + 2];
    
    // Calculate triangle centroid
    const centroid = new THREE.Vector2(
      (p0.x + p1.x + p2.x) / 3,
      (p0.y + p1.y + p2.y) / 3
    );
    
    // Keep triangle if its centroid is inside the boundary
    if (isPointInPolygon(centroid, boundaryPoints)) {
      triangleVertices.push(p0, p1, p2);
    }
  }
  
  return triangleVertices;
}

// Simple implementation of Delaunay triangulation
function computeDelaunay(points) {
  // For simplicity, create a super-triangle that contains all points
  const minX = Math.min(...points.map(p => p.x));
  const maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y));
  const maxY = Math.max(...points.map(p => p.y));
  
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dmax = Math.max(dx, dy) * 2;
  
  const superTriangle = [
    new THREE.Vector2(minX - dmax, minY - dmax),
    new THREE.Vector2(minX + dx + dmax, minY - dmax),
    new THREE.Vector2(minX - dmax, minY + dy + dmax)
  ];
  
  // Start with the super-triangle
  const triangles = [superTriangle[0], superTriangle[1], superTriangle[2]];
  
  // Add points one by one
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    
    // Find all triangles whose circumcircle contains this point
    const badTriangles = [];
    
    for (let j = 0; j < triangles.length; j += 3) {
      const t0 = triangles[j];
      const t1 = triangles[j + 1];
      const t2 = triangles[j + 2];
      
      if (isPointInCircumcircle(p, t0, t1, t2)) {
        badTriangles.push(j);
      }
    }
    
    // Find the boundary of the polygonal hole
    const polygon = [];
    
    for (let j = 0; j < badTriangles.length; j++) {
      const t = badTriangles[j];
      
      // Each edge of the triangle
      const edges = [
        [triangles[t], triangles[t + 1]],
        [triangles[t + 1], triangles[t + 2]],
        [triangles[t + 2], triangles[t]]
      ];
      
      // Check if each edge is not shared with any other bad triangle
      for (const edge of edges) {
        let isShared = false;
        
        for (let k = 0; k < badTriangles.length; k++) {
          if (j === k) continue;
          
          const otherT = badTriangles[k];
          const otherEdges = [
            [triangles[otherT], triangles[otherT + 1]],
            [triangles[otherT + 1], triangles[otherT + 2]],
            [triangles[otherT + 2], triangles[otherT]]
          ];
          
          for (const otherEdge of otherEdges) {
            if ((edge[0] === otherEdge[0] && edge[1] === otherEdge[1]) ||
                (edge[0] === otherEdge[1] && edge[1] === otherEdge[0])) {
              isShared = true;
              break;
            }
          }
          
          if (isShared) break;
        }
        
        if (!isShared) {
          polygon.push(edge[0], edge[1]);
        }
      }
    }
    
    // Remove bad triangles
    badTriangles.sort((a, b) => b - a); // Sort in descending order
    
    for (const t of badTriangles) {
      triangles.splice(t, 3);
    }
    
    // Add new triangles connecting the point with each edge of the polygon
    for (let j = 0; j < polygon.length; j += 2) {
      triangles.push(polygon[j], polygon[j + 1], p);
    }
  }
  
  // Remove any triangle that shares a vertex with the super-triangle
  const result = [];
  
  for (let i = 0; i < triangles.length; i += 3) {
    const t0 = triangles[i];
    const t1 = triangles[i + 1];
    const t2 = triangles[i + 2];
    
    const usesSuperTriangle = 
      superTriangle.some(sp => 
        (t0.x === sp.x && t0.y === sp.y) || 
        (t1.x === sp.x && t1.y === sp.y) || 
        (t2.x === sp.x && t2.y === sp.y)
      );
    
    if (!usesSuperTriangle) {
      result.push(t0, t1, t2);
    }
  }
  
  return result;
}

// Check if a point is in the circumcircle of a triangle
function isPointInCircumcircle(p, a, b, c) {
  const ax = a.x - p.x;
  const ay = a.y - p.y;
  const bx = b.x - p.x;
  const by = b.y - p.y;
  const cx = c.x - p.x;
  const cy = c.y - p.y;
  
  const det = 
    (ax * ax + ay * ay) * (bx * cy - cx * by) -
    (bx * bx + by * by) * (ax * cy - cx * ay) +
    (cx * cx + cy * cy) * (ax * by - bx * ay);
  
  return det > 0;
}

// Helper function for point-in-polygon test
function isPointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    
    const intersect = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
    
    if (intersect) inside = !inside;
  }
  
  return inside;
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
  
  // Add thickness slider
  gui.add(params, 'thickness', 0.001, 0.2).step(0.001).name('Surface Thickness').onChange(() => {
    // Update surface if it exists
    if (isDrawingClosed && closedArea) {
      updateSurface();
    }
  });
  
  // 곡선 품질 조절 옵션 추가
  gui.add(params, 'curveQuality', 5, 50).step(1).name('Curve Quality').onChange(() => {
    // 모든 곡선을 업데이트 (닫혀 있다면 표면도 업데이트)
    if (clickPoints.length >= 2) {
      updateAllCurves();
    }
  });
  
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

// 마우스 다운 이벤트 핸들러 - 수정됨
function onMouseDown(event) {
  // 1. 닫힌 영역이 있고 점 위에 마우스가 있으면 드래그 모드 시작
  if (isDrawingClosed && hoveredPointIndex !== -1) {
    // 이벤트 처리 중지
    event.preventDefault();
    
    // TrackballControls 즉시 비활성화 (중요)
    controls.enabled = false;
    
    selectedPointIndex = hoveredPointIndex;
    isDraggingPoint = true;
    return;
  } else {
    // 드래그 중이 아니라면 컨트롤 활성화
    controls.enabled = true;
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
    if (mouse.distanceTo(lastMousePosition) > 0.01) {
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

// 마우스 업 이벤트 핸들러 - 수정됨
function onMouseUp(event) {
  // 점 드래그 종료
  if (isDraggingPoint) {
    // 점 드래그 상태 종료
    isDraggingPoint = false;
    selectedPointIndex = -1;
    
    // 표면 업데이트
    if (isDrawingClosed) {
      updateSurface();
    }
    
    return;
  }
  
  if (isDrawing) {
    isDrawing = false;
    console.log(`그리기 완료: ${clickPoints.length}개 점 생성됨`);
    
    if (isAltKeyDown) {
      controls.enabled = false;
    } else {
      // 여기도 지연 적용
      setTimeout(() => {
        controls.enabled = true;
      }, 50);
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
    updateCurveBetweenPoints(index - 1, index);
  } else if (isDrawingClosed) {
    // 첫 번째 점이고 영역이 닫혔으면 마지막 점과의 선 업데이트
    updateCurveBetweenPoints(pointsCount - 1, 0);
  }
  
  // 다음 점과의 선 업데이트 (마지막 점이 아닌 경우)
  if (index < pointsCount - 1) {
    updateCurveBetweenPoints(index, index + 1);
  } else if (isDrawingClosed) {
    // 마지막 점이고 영역이 닫혔으면 첫 번째 점과의 선 업데이트
    updateCurveBetweenPoints(pointsCount - 1, 0);
  }
}

// 두 점 사이의 곡선을 업데이트하는 함수
function updateCurveBetweenPoints(startIndex, endIndex) {
  // 인덱스가 유효한지 확인
  if (startIndex < 0 || startIndex >= clickPoints.length || 
      endIndex < 0 || endIndex >= clickPoints.length) {
    return;
  }
  
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
    
    // 새 곡선 생성
    const curveLine = createCurveBetweenPoints(clickPoints[startIndex], clickPoints[endIndex]);
    
    // 배열에서 선 교체
    curveLines[lineIndex] = curveLine;
  }
}

// 모든 곡선을 업데이트하는 함수
function updateAllCurves() {
  // 기존의 모든 곡선 제거
  curveLines.forEach(line => {
    scene.remove(line);
  });
  curveLines = [];
  
  // 모든 점 사이에 새 곡선 생성
  for (let i = 0; i < clickPoints.length - 1; i++) {
    const curveLine = createCurveBetweenPoints(clickPoints[i], clickPoints[i + 1]);
    curveLines.push(curveLine);
  }
  
  // 닫힌 영역이면 마지막 점과 첫 점 사이에도 곡선 생성
  if (isDrawingClosed) {
    const lastIndex = clickPoints.length - 1;
    const curveLine = createCurveBetweenPoints(clickPoints[lastIndex], clickPoints[0]);
    curveLines.push(curveLine);
    
    // 표면 업데이트
    updateSurface();
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
  
  // 두 번째 점부터는 이전 점과 현재 점 사이에 곡선 생성
  if (clickPoints.length >= 2) {
    const previousPoint = clickPoints[clickPoints.length - 2];
    const currentPoint = clickPoints[clickPoints.length - 1];
    
    // 두 점 사이에 모델 표면을 따라 곡선 생성
    const curveLine = createCurveBetweenPoints(previousPoint, currentPoint);
    
    // 생성된 선을 배열에 추가
    curveLines.push(curveLine);
  }
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
  
  // 마지막 점과 첫 번째 점 사이에 모델 표면을 따라 곡선 생성
  const closingLine = createCurveBetweenPoints(lastPoint, firstPoint);
  
  // 생성된 선을 배열에 추가
  curveLines.push(closingLine);
  
  // 닫힌 영역임을 표시
  isDrawingClosed = true;
  
  // Create the surface mesh
  createSurfaceFromClosedCurves();
  
  // 컨트롤 다시 활성화 - 지연 추가
  setTimeout(() => {
    controls.enabled = true;
  }, 50);
  
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