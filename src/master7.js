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
  showSurface: true,
  thickness: 0.01,
  curveQuality: 20,
  clearPoints: function() {
    clearAllPointsAndCurves();
  }
};

const matcaps = {};
const stlLoader = new STLLoader();
const gui = new dat.GUI();

// Arrays and variables
let clickPoints = [];
let curveLines = [];
let closedArea = null;
let isDrawingClosed = false;

// Mouse variables
let isDrawing = false;
let minDistanceBetweenPoints = 0.01;
let hoveredPointIndex = -1;
let lastMousePosition = new THREE.Vector2();

// Alt key state
let isAltKeyDown = false;

// Point dragging variables
let selectedPointIndex = -1;
let isDraggingPoint = false;

// Clear all points and curves function
function clearAllPointsAndCurves() {
  // Remove all markers
  clickPoints.forEach(pointData => {
    if (pointData.marker) {
      scene.remove(pointData.marker);
    }
  });

  // Remove all curves
  curveLines.forEach(line => {
    scene.remove(line);
  });

  // Remove closed area
  if (closedArea) {
    scene.remove(closedArea);
    closedArea = null;
  }

  // Reset arrays
  clickPoints = [];
  curveLines = [];
  isDrawingClosed = false;
  hoveredPointIndex = -1;
  selectedPointIndex = -1;
  isDrawing = false;
  isDraggingPoint = false;
  
  // Reset cursor style
  renderer.domElement.style.cursor = 'auto';
}

// STL file load and processing function
function setTargetMeshGeometry(geometry) {
  // Remove existing mesh
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

  // Create mesh
  targetMesh = new THREE.Mesh(geometry, material);
  scene.add(targetMesh);
  targetMesh.position.set(0, 0, 0);
}

// Create curve between two points function
function createCurveBetweenPoints(pointA, pointB) {
  const { point: pointAPos, normal: normA } = pointA;
  const { point: pointBPos, normal: normB } = pointB;
  
  // Adjust sample count based on distance
  const distance = pointAPos.distanceTo(pointBPos);
  const baseSampleCount = params.curveQuality; 
  const sampleCount = Math.max(baseSampleCount, Math.floor(distance * 500));
  
  // Sample points on surface
  const pointsOnSurface = [];

  for (let i = 0; i <= sampleCount; i++) {
    const t = i / sampleCount;
    // Linear interpolation between points
    let pos = new THREE.Vector3().lerpVectors(pointAPos, pointBPos, t);
    // Interpolate normals for direction
    let norm = new THREE.Vector3().lerpVectors(normA, normB, t).normalize();
    // Raycast from slightly above in normal direction
    const rayOrigin = pos.clone().addScaledVector(norm, 0.1);
    const sampleRaycaster = new THREE.Raycaster(rayOrigin, norm.clone().negate());
    const sampleIntersects = sampleRaycaster.intersectObject(targetMesh, true);
    const offset = 0.001;
    
    if (sampleIntersects.length > 0) {
      // Use raycast hit point and offset slightly in normal direction
      let hitNormal = sampleIntersects[0].face.normal.clone();
      hitNormal.transformDirection(targetMesh.matrixWorld);
      pos = sampleIntersects[0].point.clone().addScaledVector(hitNormal, offset);
    } else {
      // If raycast fails, use interpolated point with offset
      pos.addScaledVector(norm, offset);
    }
    pointsOnSurface.push(pos);
  }

  // Simplify points for performance
  const simplifiedPoints = [];
  const simplificationFactor = Math.max(1, Math.floor(pointsOnSurface.length / 100));
  for (let i = 0; i < pointsOnSurface.length; i += simplificationFactor) {
    simplifiedPoints.push(pointsOnSurface[i]);
  }
  // Add end point if missing
  if (simplifiedPoints[simplifiedPoints.length - 1] !== pointsOnSurface[pointsOnSurface.length - 1]) {
    simplifiedPoints.push(pointsOnSurface[pointsOnSurface.length - 1]);
  }

  // Create smooth curve using Catmull-Rom
  const curve = new THREE.CatmullRomCurve3(simplifiedPoints);
  const curvePoints = curve.getPoints(50);
  const curveGeometry = new THREE.BufferGeometry().setFromPoints(curvePoints);
  const lineMaterial = new THREE.LineBasicMaterial({ 
    color: (pointA === clickPoints[clickPoints.length - 1] && pointB === clickPoints[0]) ? 0x00ff00 : 0xff0000 
  });
  const curveLine = new THREE.Line(curveGeometry, lineMaterial);
  scene.add(curveLine);
  
  // Return created curve
  return curveLine;
}

// Function to create a surface from the closed area curves with dome-like extrusion
function createSurfaceFromClosedCurves() {
  if (!isDrawingClosed || curveLines.length === 0) {
    return;
  }
  
  // 1. Collect all boundary points from curves with deduplication
  const boundaryPoints = [];
  const pointsSet = new Set();
  
  curveLines.forEach(curveLine => {
    const positions = curveLine.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const point = new THREE.Vector3();
      point.fromBufferAttribute(positions, i);
      
      const key = `${point.x.toFixed(6)},${point.y.toFixed(6)},${point.z.toFixed(6)}`;
      if (!pointsSet.has(key)) {
        pointsSet.add(key);
        boundaryPoints.push(point);
      }
    }
  });
  
  // 2. Calculate average normal from clicked points
  const averageNormal = new THREE.Vector3();
  clickPoints.forEach(pointData => {
    averageNormal.add(pointData.normal);
  });
  
  // Ensure valid normal
  if (averageNormal.length() < 0.001) {
    averageNormal.set(0, 0, 1);
  } else {
    averageNormal.normalize();
  }
  
  // 3. Create a plane using average normal and centroid
  const centroid = new THREE.Vector3();
  boundaryPoints.forEach(point => {
    centroid.add(point);
  });
  centroid.divideScalar(boundaryPoints.length);
  
  // 4. Project boundary points onto plane with robust axes
  let tempUp = new THREE.Vector3(0, 1, 0);
  if (Math.abs(averageNormal.dot(tempUp)) > 0.9) {
    tempUp.set(1, 0, 0);
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
  
  // 5. Clean up boundary
  const cleanBoundary2D = [];
  const minPointDistance = 0.0001;
  
  for (let i = 0; i < boundary2D.length; i++) {
    const p1 = boundary2D[i];
    const p2 = boundary2D[(i + 1) % boundary2D.length];
    
    cleanBoundary2D.push(p1);
    
    if (p1.distanceTo(p2) < minPointDistance) {
      continue;
    }
  }
  
  // Use dense grid triangulation
  let triangles = createDenseTriangleGrid(cleanBoundary2D, 80);
  
  // 6. Create 3D vertices for triangulation with improved raycast
  const frontPositions = new Float32Array(triangles.length * 3);
  const frontNormals = new Float32Array(triangles.length * 3);
  
  // Map from original point indices to vertices with normals
  const vertexMap = new Map();
  
  for (let i = 0; i < triangles.length; i++) {
    const point2D = triangles[i];
    
    // Get or create 3D vertex
    let vertex3D;
    const key = `${point2D.x.toFixed(6)},${point2D.y.toFixed(6)}`;
    
    if (vertexMap.has(key)) {
      vertex3D = vertexMap.get(key);
    } else {
      // Convert 2D point back to 3D
      const worldPoint = centroid.clone()
        .add(tangent1.clone().multiplyScalar(point2D.x))
        .add(tangent2.clone().multiplyScalar(point2D.y));
      
      // Multiple raycasts with different offsets
      const raycastOffsets = [0.1, 0.2, 0.05, 0.15];
      let bestIntersect = null;
      let bestDistance = Infinity;
      
      for (const offset of raycastOffsets) {
        const rayStart = worldPoint.clone().add(averageNormal.clone().multiplyScalar(offset));
        const rayDir = averageNormal.clone().negate();
        
        const raycaster = new THREE.Raycaster(rayStart, rayDir);
        raycaster.firstHitOnly = true;
        const intersects = raycaster.intersectObject(targetMesh, true);
        
        if (intersects.length > 0) {
          const distance = intersects[0].distance;
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIntersect = intersects[0];
          }
        }
      }
      
      if (bestIntersect) {
        // Use best intersection point and normal
        vertex3D = {
          position: bestIntersect.point.clone(),
          normal: bestIntersect.face.normal.clone().transformDirection(targetMesh.matrixWorld),
          point2D: new THREE.Vector2(point2D.x, point2D.y)
        };
        // Prevent z-fighting
        vertex3D.position.addScaledVector(vertex3D.normal, 0.002);
      } else {
        // Fallback - use plane point with average normal
        vertex3D = {
          position: worldPoint.clone(),
          normal: averageNormal.clone(),
          point2D: new THREE.Vector2(point2D.x, point2D.y)
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
  
  // Create a 2D shape to calculate distance from border
  const shape2D = new THREE.Shape();
  if (cleanBoundary2D.length > 0) {
    shape2D.moveTo(cleanBoundary2D[0].x, cleanBoundary2D[0].y);
    for (let i = 1; i < cleanBoundary2D.length; i++) {
      shape2D.lineTo(cleanBoundary2D[i].x, cleanBoundary2D[i].y);
    }
    shape2D.closePath();
  }
  
  // Find max distance from border
  const centroid2D = new THREE.Vector2();
  cleanBoundary2D.forEach(point => {
    centroid2D.add(point);
  });
  centroid2D.divideScalar(cleanBoundary2D.length);
  
  let maxDistanceFromBorder = 0;
  cleanBoundary2D.forEach(point => {
    const distToBoundary = point.distanceTo(centroid2D);
    maxDistanceFromBorder = Math.max(maxDistanceFromBorder, distToBoundary);
  });
  
  // 7. Create back face positions with variable extrusion
  const backPositions = new Float32Array(frontPositions.length);
  const backNormals = new Float32Array(frontNormals.length);
  
  // Calculate distance from border for each vertex
  const distancesFromBorder = [];
  
  for (let i = 0; i < triangles.length; i++) {
    const point2D = triangles[i];
    
    let minDistToBorder = Number.MAX_VALUE;
    
    for (let j = 0; j < cleanBoundary2D.length; j++) {
      const p1 = cleanBoundary2D[j];
      const p2 = cleanBoundary2D[(j + 1) % cleanBoundary2D.length];
      
      const distToSegment = distanceToLineSegment(
        point2D.x, point2D.y,
        p1.x, p1.y,
        p2.x, p2.y
      );
      
      minDistToBorder = Math.min(minDistToBorder, distToSegment);
    }
    
    const normalizedDistance = Math.min(minDistToBorder / maxDistanceFromBorder, 1);
    distancesFromBorder[i] = normalizedDistance;
  }
  
  // Filter out invalid triangles
  const validTriangleIndices = [];
  for (let i = 0; i < triangles.length / 3; i++) {
    const idx1 = i * 3;
    const idx2 = idx1 + 1;
    const idx3 = idx1 + 2;
    
    let hasInvalidCoord = false;
    
    for (let j = 0; j < 3; j++) {
      const x = frontPositions[(idx1 + j) * 3];
      const y = frontPositions[(idx1 + j) * 3 + 1];
      const z = frontPositions[(idx1 + j) * 3 + 2];
      
      if (isNaN(x) || isNaN(y) || isNaN(z)) {
        hasInvalidCoord = true;
        break;
      }
    }
    
    if (!hasInvalidCoord) {
      validTriangleIndices.push(idx1, idx2, idx3);
    }
  }
  
  // Apply extrusion based on distance from border
  for (let i = 0; i < frontPositions.length; i += 3) {
    const vertexIndex = i / 3;
    const nx = frontNormals[i];
    const ny = frontNormals[i + 1];
    const nz = frontNormals[i + 2];
    
    const normalizedDistance = distancesFromBorder[vertexIndex];
     
    // Use sigmoid-like function for scale factor
    const sigmoidValue = normalizedDistance / (0.1 + normalizedDistance);
    const scaleFactor = sigmoidValue / (1 / (0.1 + 1));
    
    const extrusionAmount = params.thickness * scaleFactor;
  
    // Offset along normal by variable thickness
    backPositions[i] = frontPositions[i] + nx * extrusionAmount;
    backPositions[i + 1] = frontPositions[i + 1] + ny * extrusionAmount;
    backPositions[i + 2] = frontPositions[i + 2] + nz * extrusionAmount;
    
    // Invert normals for back face
    backNormals[i] = -nx;
    backNormals[i + 1] = -ny;
    backNormals[i + 2] = -nz;
  }
  
  // Collect vertices and normals
  const positionArray = [];
  const normalArray = [];
  
  // Add front vertices
  for (let i = 0; i < frontPositions.length; i++) {
    positionArray.push(frontPositions[i]);
    normalArray.push(frontNormals[i]);
  }
  
  // Add back vertices
  for (let i = 0; i < backPositions.length; i++) {
    positionArray.push(backPositions[i]);
    normalArray.push(backNormals[i]);
  }
  
  // Generate side walls
  const frontFaceCount = triangles.length / 3;
  const vertexCount = frontPositions.length / 3;
  
  // Edge map to track edges
  const edgeMap = new Map();
  
  // Find edges of front face
  for (let i = 0; i < frontFaceCount; i++) {
    const idx0 = i * 3;
    const idx1 = idx0 + 1;
    const idx2 = idx0 + 2;
    
    // Skip invalid vertices
    let hasInvalidCoord = false;
    for (let j = 0; j < 3; j++) {
      const x = frontPositions[(idx0 + j) * 3];
      const y = frontPositions[(idx0 + j) * 3 + 1];
      const z = frontPositions[(idx0 + j) * 3 + 2];
      
      if (isNaN(x) || isNaN(y) || isNaN(z)) {
        hasInvalidCoord = true;
        break;
      }
    }
    
    if (hasInvalidCoord) continue;
    
    // Check all three edges
    addEdge(idx0, idx1);
    addEdge(idx1, idx2);
    addEdge(idx2, idx0);
  }
  
  // Helper function to add edge
  function addEdge(a, b) {
    const edgeKey = a < b ? `${a}-${b}` : `${b}-${a}`;
    
    if (edgeMap.has(edgeKey)) {
      // Remove interior edges (appear twice)
      edgeMap.delete(edgeKey);
    } else {
      // Add new edge
      edgeMap.set(edgeKey, [a, b]);
    }
  }
  
  // Remaining edges are boundary edges
  for (const [key, [a, b]] of edgeMap.entries()) {
    // Validate indices
    if (a >= frontPositions.length / 3 || b >= frontPositions.length / 3) {
      continue;
    }
    
    // Front vertices
    const ax = frontPositions[a * 3];
    const ay = frontPositions[a * 3 + 1];
    const az = frontPositions[a * 3 + 2];
    
    const bx = frontPositions[b * 3];
    const by = frontPositions[b * 3 + 1];
    const bz = frontPositions[b * 3 + 2];
    
    // Back vertices
    const cx = backPositions[a * 3];
    const cy = backPositions[a * 3 + 1];
    const cz = backPositions[a * 3 + 2];
    
    const dx = backPositions[b * 3];
    const dy = backPositions[b * 3 + 1];
    const dz = backPositions[b * 3 + 2];
    
    // Skip invalid vertices
    if (isNaN(ax) || isNaN(ay) || isNaN(az) || 
        isNaN(bx) || isNaN(by) || isNaN(bz) ||
        isNaN(cx) || isNaN(cy) || isNaN(cz) ||
        isNaN(dx) || isNaN(dy) || isNaN(dz)) {
      continue;
    }
    
    // Calculate wall normal
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
    
    // Ensure valid normal
    if (isNaN(wallNormal.x) || isNaN(wallNormal.y) || isNaN(wallNormal.z) ||
        wallNormal.length() < 0.001) {
      wallNormal.copy(averageNormal);
    }
    
    // First triangle: a, b, c
    positionArray.push(ax, ay, az);
    positionArray.push(bx, by, bz);
    positionArray.push(cx, cy, cz);
    
    for (let i = 0; i < 3; i++) {
      normalArray.push(wallNormal.x, wallNormal.y, wallNormal.z);
    }
    
    // Second triangle: b, d, c
    positionArray.push(bx, by, bz);
    positionArray.push(dx, dy, dz);
    positionArray.push(cx, cy, cz);
    
    for (let i = 0; i < 3; i++) {
      normalArray.push(wallNormal.x, wallNormal.y, wallNormal.z);
    }
  }
  
  // Create Float32Arrays
  const positions = new Float32Array(positionArray);
  const normals = new Float32Array(normalArray);
  
  // Create geometry
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  
  // Compute vertex normals for smoother shading
  geometry.computeVertexNormals();
  
  // Create material similar to original model
  const surfaceMaterial = new THREE.MeshMatcapMaterial({
    matcap: matcaps['Red Wax'],
    side: THREE.DoubleSide,
    flatShading: false,
  });
  
  // Create mesh
  const surfaceMesh = new THREE.Mesh(geometry, surfaceMaterial);
  scene.add(surfaceMesh);
  
  // Store reference
  closedArea = surfaceMesh;
  
  return surfaceMesh;
}

// Helper function to calculate distance from point to line segment
function distanceToLineSegment(px, py, x1, y1, x2, y2) {
  const A = px - x1;
  const B = py - y1;
  const C = x2 - x1;
  const D = y2 - y1;

  const dot = A * C + B * D;
  const len_sq = C * C + D * D;
  let param = -1;
  
  if (len_sq !== 0)
    param = dot / len_sq;

  let xx, yy;

  if (param < 0) {
    xx = x1;
    yy = y1;
  } else if (param > 1) {
    xx = x2;
    yy = y2;
  } else {
    xx = x1 + param * C;
    yy = y1 + param * D;
  }

  const dx = px - xx;
  const dy = py - yy;
  
  return Math.sqrt(dx * dx + dy * dy);
}

// Create a dense grid of triangles with adjustable resolution
function createDenseTriangleGrid(boundaryPoints, gridSize = 40) {
  // Find bounding box
  const minX = Math.min(...boundaryPoints.map(p => p.x));
  const maxX = Math.max(...boundaryPoints.map(p => p.x));
  const minY = Math.min(...boundaryPoints.map(p => p.y));
  const maxY = Math.max(...boundaryPoints.map(p => p.y));
  
  // Create dense grid with specified resolution
  const stepX = (maxX - minX) / gridSize;
  const stepY = (maxY - minY) / gridSize;
  
  // Create vertices
  const vertices = [];
  
  // Create grid points inside polygon
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
  
  // Add boundary points
  boundaryPoints.forEach(p => {
    vertices.push(p.clone());
  });
  
  // Create Delaunay triangulation
  const delaunay = computeDelaunay(vertices);
  
  // Filter triangles inside boundary
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
    
    // Keep triangle if centroid is inside boundary
    if (isPointInPolygon(centroid, boundaryPoints)) {
      triangleVertices.push(p0, p1, p2);
    }
  }
  
  return triangleVertices;
}

// Simple Delaunay triangulation
function computeDelaunay(points) {
  // Create super-triangle containing all points
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
  
  // Start with super-triangle
  const triangles = [superTriangle[0], superTriangle[1], superTriangle[2]];
  
  // Add points one by one
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    
    // Find triangles whose circumcircle contains this point
    const badTriangles = [];
    
    for (let j = 0; j < triangles.length; j += 3) {
      const t0 = triangles[j];
      const t1 = triangles[j + 1];
      const t2 = triangles[j + 2];
      
      if (isPointInCircumcircle(p, t0, t1, t2)) {
        badTriangles.push(j);
      }
    }
    
    // Find boundary of polygonal hole
    const polygon = [];
    
    for (let j = 0; j < badTriangles.length; j++) {
      const t = badTriangles[j];
      
      // Each edge of triangle
      const edges = [
        [triangles[t], triangles[t + 1]],
        [triangles[t + 1], triangles[t + 2]],
        [triangles[t + 2], triangles[t]]
      ];
      
      // Check if edge is shared with other bad triangles
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
    badTriangles.sort((a, b) => b - a);
    
    for (const t of badTriangles) {
      triangles.splice(t, 3);
    }
    
    // Add new triangles connecting point with polygon edges
    for (let j = 0; j < polygon.length; j += 2) {
      triangles.push(polygon[j], polygon[j + 1], p);
    }
  }
  
  // Remove triangles that share vertices with super-triangle
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

// Point-in-polygon test
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

// Initialization function
function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  
  // Add lighting
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

  // Load matcap textures
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

  // Setup GUI
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
        setTargetMeshGeometry(geometry);
      }, false);
      reader.readAsArrayBuffer(file);
    }
  }, false);

  // Set up event listeners
  setupEventListeners();

  render();
}

// GUI setup function
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
  
  gui.add(params, 'clearPoints').name('Clear All');
}

// Set up event listeners
function setupEventListeners() {
  // Mouse event listeners
  renderer.domElement.addEventListener('mousedown', onMouseDown);
  renderer.domElement.addEventListener('mousemove', onMouseMove);
  renderer.domElement.addEventListener('mouseup', onMouseUp);
  renderer.domElement.addEventListener('click', onClick);
  
  // Keyboard event listeners
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  
  // Reset Alt key state when window loses focus
  window.addEventListener('blur', () => {
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

// Key down event handler
function onKeyDown(event) {
  // Alt key (18)
  if (event.keyCode === 18) {
    isAltKeyDown = true;
    
    // Change cursor when in drawing mode with no closed area
    if (!isDrawingClosed) {
      renderer.domElement.style.cursor = 'crosshair';
      
      // Temporarily disable controls while Alt is pressed
      controls.enabled = false;
    }
  }
}

// Key up event handler
function onKeyUp(event) {
  // Alt key released
  if (event.keyCode === 18) {
    isAltKeyDown = false;
    
    // Stop drawing if in progress
    if (isDrawing) {
      isDrawing = false;
    }
    
    // Reset cursor when not in drawing mode
    if (!isDrawingClosed) {
      renderer.domElement.style.cursor = 'auto';
    }
    
    // Re-enable controls if not dragging
    if (!isDraggingPoint) {
      controls.enabled = true;
    }
  }
}

// Mouse down event handler
function onMouseDown(event) {
  // Handle point dragging
  if (isDrawingClosed && hoveredPointIndex !== -1) {
    event.preventDefault();
    
    controls.enabled = false;
    
    selectedPointIndex = hoveredPointIndex;
    isDraggingPoint = true;
    return;
  } else {
    controls.enabled = true;
  }
  
  // Start drawing when Alt is pressed
  if (!targetMesh || isDrawingClosed || !isAltKeyDown) return;
  
  controls.enabled = false;
  
  // Convert screen coordinates to normalized device coordinates
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  
  lastMousePosition.copy(mouse);
  
  // Raycast to find intersection with model
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(targetMesh, true);
  
  if (intersects.length > 0) {
    isDrawing = true;
    
    // Add first point
    addPointAtIntersection(intersects[0]);
    
    // Change cursor
    renderer.domElement.style.cursor = 'crosshair';
  }
}

// Mouse move event handler
function onMouseMove(event) {
  if (!targetMesh) return;
  
  // Convert screen coordinates to normalized device coordinates
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  
  // Create raycaster
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  
  // Handle point dragging
  if (isDraggingPoint && selectedPointIndex !== -1) {
    const intersects = raycaster.intersectObject(targetMesh, true);
    if (intersects.length > 0) {
      updatePointPosition(selectedPointIndex, intersects[0]);
    }
    return;
  }
  
  // Check for point hovering
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
  
  // Update cursor style on hover state change
  if (prevHoveredIndex !== hoveredPointIndex) {
    if (hoveredPointIndex > 0 && !isDrawingClosed) {
      renderer.domElement.style.cursor = 'cell';
    } else if (hoveredPointIndex === 0 && clickPoints.length > 2 && !isDrawingClosed) {
      renderer.domElement.style.cursor = 'pointer';
    } else if (hoveredPointIndex !== -1 && isDrawingClosed) {
      renderer.domElement.style.cursor = 'move';
    } else if (isDrawing) {
      renderer.domElement.style.cursor = 'crosshair';
    } else if (isAltKeyDown && !isDrawingClosed) {
      renderer.domElement.style.cursor = 'crosshair';
    } else {
      renderer.domElement.style.cursor = 'auto';
    }
  }
  
  // Add points while drawing
  if (isDrawing) {
    // Only add points when mouse moved enough
    if (mouse.distanceTo(lastMousePosition) > 0.01) {
      lastMousePosition.copy(mouse);
      
      const intersects = raycaster.intersectObject(targetMesh, true);
      if (intersects.length > 0) {
        const newIntersection = intersects[0];
        if (clickPoints.length > 0) {
          const lastPoint = clickPoints[clickPoints.length - 1].point;
          const newPoint = newIntersection.point.clone();
          
          // Add point if far enough from last point
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

// Click event handler - for closing area or removing points
function onClick(event) {
  // Skip if currently dragging
  if (isDraggingPoint) {
    return;
  }
  
  // Skip if Alt is pressed or already in drawing mode
  if (!targetMesh || isDrawingClosed || isDrawing || isAltKeyDown) return;
  
  // Close area if clicking first point
  if (hoveredPointIndex === 0 && clickPoints.length > 2) {
    createClosedArea();
    return;
  }
  
  // Remove points after clicked point
  if (hoveredPointIndex > 0 && !isDrawingClosed) {
    trimPointsAndLines(hoveredPointIndex);
  }
}

// Remove points and lines after selected point
function trimPointsAndLines(pointIndex) {
  if (pointIndex < 1 || pointIndex >= clickPoints.length - 1) return;
  
  // Remove points from end to pointIndex+1
  for (let i = clickPoints.length - 1; i > pointIndex; i--) {
    if (clickPoints[i].marker) {
      scene.remove(clickPoints[i].marker);
    }
    
    clickPoints.splice(i, 1);
  }
  
  // Remove lines from end to pointIndex
  for (let i = curveLines.length - 1; i >= pointIndex; i--) {
    scene.remove(curveLines[i]);
    curveLines.splice(i, 1);
  }
  
  // Reset hover state
  hoveredPointIndex = -1;
}

// Mouse up event handler
function onMouseUp(event) {
  // End point dragging
  if (isDraggingPoint) {
    isDraggingPoint = false;
    selectedPointIndex = -1;
    
    // Update surface
    if (isDrawingClosed) {
      updateSurface();
    }
    
    return;
  }
  
  if (isDrawing) {
    isDrawing = false;
    
    if (isAltKeyDown) {
      controls.enabled = false;
    } else {
      setTimeout(() => {
        controls.enabled = true;
      }, 50);
    }
  }
}

// Update point position
function updatePointPosition(index, intersection) {
  if (index < 0 || index >= clickPoints.length) return;
  
  // Get new position and normal
  let point = intersection.point.clone();
  let normal = intersection.face.normal.clone();
  normal.transformDirection(targetMesh.matrixWorld).normalize();
  
  // Update click direction
  const clickDirection = new THREE.Vector3().subVectors(point, camera.position).normalize();
  
  // Prevent z-fighting
  point.addScaledVector(normal, 0.001);
  
  // Update point data
  const pointData = clickPoints[index];
  pointData.point.copy(point);
  pointData.normal.copy(normal);
  pointData.clickDirection.copy(clickDirection);
  
  // Update marker position
  if (pointData.marker) {
    pointData.marker.position.copy(point);
  }
  
  // Update connected curves
  updateConnectedLines(index);
}

// Update curves connected to point
function updateConnectedLines(index) {
  if (index < 0 || index >= clickPoints.length) return;
  
  const pointsCount = clickPoints.length;
  
  // Update line to previous point
  if (index > 0) {
    updateCurveBetweenPoints(index - 1, index);
  } else if (isDrawingClosed) {
    updateCurveBetweenPoints(pointsCount - 1, 0);
  }
  
  // Update line to next point
  if (index < pointsCount - 1) {
    updateCurveBetweenPoints(index, index + 1);
  } else if (isDrawingClosed) {
    updateCurveBetweenPoints(pointsCount - 1, 0);
  }
}

// Update curve between two points
function updateCurveBetweenPoints(startIndex, endIndex) {
  // Validate indices
  if (startIndex < 0 || startIndex >= clickPoints.length || 
      endIndex < 0 || endIndex >= clickPoints.length) {
    return;
  }
  
  // Find line index
  let lineIndex = -1;
  
  // Normal case - adjacent points
  if (endIndex === startIndex + 1) {
    lineIndex = startIndex;
  } 
  // Closing line for closed area
  else if (startIndex === clickPoints.length - 1 && endIndex === 0) {
    lineIndex = curveLines.length - 1;
  }
  
  if (lineIndex >= 0 && lineIndex < curveLines.length) {
    // Remove old line
    scene.remove(curveLines[lineIndex]);
    
    // Create new curve
    const curveLine = createCurveBetweenPoints(clickPoints[startIndex], clickPoints[endIndex]);
    
    // Replace in array
    curveLines[lineIndex] = curveLine;
  }
}

// Update all curves
function updateAllCurves() {
  // Remove all existing curves
  curveLines.forEach(line => {
    scene.remove(line);
  });
  curveLines = [];
  
  // Create new curves between all points
  for (let i = 0; i < clickPoints.length - 1; i++) {
    const curveLine = createCurveBetweenPoints(clickPoints[i], clickPoints[i + 1]);
    curveLines.push(curveLine);
  }
  
  // Add closing curve for closed area
  if (isDrawingClosed) {
    const lastIndex = clickPoints.length - 1;
    const curveLine = createCurveBetweenPoints(clickPoints[lastIndex], clickPoints[0]);
    curveLines.push(curveLine);
    
    // Update surface
    updateSurface();
  }
}

// Update surface
function updateSurface() {
  // Remove existing surface
  if (closedArea) {
    scene.remove(closedArea);
    closedArea = null;
  }
  
  // Create new surface
  createSurfaceFromClosedCurves();
}

// Add point at intersection
function addPointAtIntersection(intersect) {
  let point = intersect.point.clone();
  
  // Convert face normal to world space
  let normal = intersect.face.normal.clone();
  normal.transformDirection(targetMesh.matrixWorld).normalize();
  
  // Store click direction
  const clickDirection = new THREE.Vector3().subVectors(point, camera.position).normalize();
  
  // Prevent z-fighting
  point.addScaledVector(normal, 0.001);
  
  // Create marker with appropriate size and color
  const markerSize = clickPoints.length === 0 ? 0.005 : 0.002;
  const sphereGeom = new THREE.SphereGeometry(markerSize, 8, 8);
  const sphereMat = new THREE.MeshBasicMaterial({ 
    color: clickPoints.length === 0 ? 0x00ff00 : 0xff0000
  });
  const marker = new THREE.Mesh(sphereGeom, sphereMat);
  marker.position.copy(point);
  scene.add(marker);
  
  // Store point data
  const newPointData = { 
    point: point, 
    normal: normal, 
    clickDirection: clickDirection,
    marker: marker 
  };
  
  clickPoints.push(newPointData);
  
  // Create curve between points
  if (clickPoints.length >= 2) {
    const previousPoint = clickPoints[clickPoints.length - 2];
    const currentPoint = clickPoints[clickPoints.length - 1];
    
    const curveLine = createCurveBetweenPoints(previousPoint, currentPoint);
    curveLines.push(curveLine);
  }
}

// Create closed area
function createClosedArea() {
  // Remove existing closed area
  if (closedArea) {
    scene.remove(closedArea);
  }
  
  // Create closing curve
  const firstPoint = clickPoints[0];
  const lastPoint = clickPoints[clickPoints.length - 1];
  
  const closingLine = createCurveBetweenPoints(lastPoint, firstPoint);
  curveLines.push(closingLine);
  
  // Mark as closed
  isDrawingClosed = true;
  
  // Create surface
  createSurfaceFromClosedCurves();
  
  // Re-enable controls
  setTimeout(() => {
    controls.enabled = true;
  }, 50);
}

function render() {
  material.matcap = matcaps[params.matcap];
  requestAnimationFrame(render);
  stats.update();
  controls.update();
  renderer.render(scene, camera);
}

init();