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
};

const matcaps = {};
const stlLoader = new STLLoader();
const gui = new dat.GUI();

// 배열 선언: 클릭한 점과 생성된 선(Line)을 저장
let clickPoints = []; // { point, normal } 형태
let curveLine = null; // 생성된 선(Line) 객체

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

  render();
}

// 클릭 이벤트 핸들러
function onClick(event) {
  // 화면 좌표를 정규화된 디바이스 좌표(NDC)로 변환
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );

  if (!targetMesh) return; // 모델이 로드되지 않은 경우

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

    // 약간 오프셋하여 z-fighting 방지 (법선 방향으로 0.01 만큼 이동)
    point.addScaledVector(normal, 0.001);

    // 빨간 구체 마커 생성
    const sphereGeom = new THREE.SphereGeometry(0.005, 8, 8);
    const sphereMat  = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const marker = new THREE.Mesh(sphereGeom, sphereMat);
    marker.position.copy(point);
    scene.add(marker);

    // 클릭한 점과 해당 법선 정보를 저장
    clickPoints.push({ point: point, normal: normal });

    // 두 번째 점이 추가되면 선(곡선) 생성
    if (clickPoints.length === 2) {
      // 기존 선이 있다면 제거
      if (curveLine) {
        scene.remove(curveLine);
      }

      // 두 점 사이를 N등분하여 표면상의 점들을 샘플링
      const sampleCount = 20000;
      const pointsOnSurface = [];
      const { point: pointA, normal: normA } = clickPoints[0];
      const { point: pointB, normal: normB } = clickPoints[1];

      for (let i = 0; i <= sampleCount; i++) {
        const t = i / sampleCount;
        // 두 점 사이 선형 보간
        let pos = new THREE.Vector3().lerpVectors(pointA, pointB, t);
        // 두 점의 법선을 보간하여 방향 결정
        let norm = new THREE.Vector3().lerpVectors(normA, normB, t).normalize();
        // 보간점에서 약간 위쪽(법선 방향)에서부터 반대 방향으로 레이캐스트
        const rayOrigin = pos.clone().addScaledVector(norm, 0.1);
        const sampleRaycaster = new THREE.Raycaster(rayOrigin, norm.clone().negate());
        const sampleIntersects = sampleRaycaster.intersectObject(targetMesh, true);
        // 원하는 오프셋 값 (필요에 따라 값을 조정하세요)
        const offset = 0.001;
        
        if (sampleIntersects.length > 0) {
          pos = sampleIntersects[0].point.clone().addScaledVector(norm, offset);
        } else {
          pos.addScaledVector(norm, offset);
        }
        pointsOnSurface.push(pos);
      }

      // Catmull-Rom 커브를 이용해 부드러운 곡선 생성
      const curve = new THREE.CatmullRomCurve3(pointsOnSurface);
      const curvePoints = curve.getPoints(100);
      const curveGeometry = new THREE.BufferGeometry().setFromPoints(curvePoints);
      curveLine = new THREE.Line(curveGeometry, new THREE.LineBasicMaterial({ color: 0xff0000 }));
      scene.add(curveLine);

      // 선 생성 후 클릭한 점 배열 초기화 (다음 작업을 위해)
      clickPoints = [];
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
