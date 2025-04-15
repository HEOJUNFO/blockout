//viwer.js
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import JSZip from 'jszip'; // 압축 파일 처리를 위한 JSZip 라이브러리 추가

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

let scene, camera, renderer, controls;
let meshes = []; // 여러 메시를 관리하기 위한 배열
let meshGroup = null; // 모든 메시를 포함할 그룹
let material; // material 변수를 전역으로 선언

const params = {
  matcap: 'Clay',
};

const matcaps = {};

const stlLoader = new STLLoader();

// 모든 모델이 보이도록 카메라 위치 조정하는 함수
function fitCameraToMeshes() {
  if (!meshGroup || meshes.length === 0) return;
  
  // 모든 메시를 포함하는 바운딩 박스 계산
  const boundingBox = new THREE.Box3();
  
  meshes.forEach(mesh => {
    // 개별 메시의 바운딩 박스 계산
    if (!mesh.geometry.boundingBox) {
      mesh.geometry.computeBoundingBox();
    }
    const meshBounds = new THREE.Box3().copy(mesh.geometry.boundingBox);
    // 메시의 위치와 회전을 고려하여 월드 좌표계로 변환
    meshBounds.applyMatrix4(mesh.matrixWorld);
    // 전체 바운딩 박스에 확장
    boundingBox.union(meshBounds);
  });
  
  // 바운딩 박스 중심과 크기 계산
  const center = new THREE.Vector3();
  boundingBox.getCenter(center);
  const size = new THREE.Vector3();
  boundingBox.getSize(size);
  
  // 바운딩 박스 대각선 길이 계산
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  
  // 필요한 거리 계산 (모든 모델이 보이도록)
  let distance = Math.abs(maxDim / Math.sin(fov / 2));
  
  // 안전 마진 추가
  distance *= 1.5;
  
  // 카메라 위치 설정
  const direction = new THREE.Vector3(1, 1, 1).normalize();
  camera.position.copy(center).add(direction.multiplyScalar(distance));
  camera.lookAt(center);
  
  // 카메라의 near와 far 평면 조정
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  
  // 컨트롤 대상 업데이트
  controls.target.copy(center);
  controls.update();
}

// 메시 추가 함수
function addMeshFromGeometry(geometry) {
  // 원래 위치 유지 (center 호출 제거)
  geometry.computeBoundingSphere();
  
  // 스케일 조정을 제거하여 원래 크기 유지
  // 필요시 전체 모델의 크기를 조정하는 것으로 대체

  geometry.deleteAttribute('uv');
  geometry = BufferGeometryUtils.mergeVertices(geometry);
  geometry.computeVertexNormals();
  geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
  geometry.attributes.normal.setUsage(THREE.DynamicDrawUsage);
  geometry.computeBoundsTree({ setBoundingBox: false });
  
  // 새 메시 생성 - 새 머티리얼 인스턴스 생성하고 matcap을 직접 설정
  const meshMaterial = new THREE.MeshMatcapMaterial({
    flatShading: false,
    side: THREE.DoubleSide,
    matcap: matcaps[params.matcap]
  });
  
  const newMesh = new THREE.Mesh(geometry, meshMaterial);
  meshes.push(newMesh);
  
  return newMesh;
}

// 모든 메시 표시 및 카메라 조정
function arrangeMeshes() {
  // 기존 메시 그룹이 있으면 제거
  if (meshGroup) {
    scene.remove(meshGroup);
  }
  
  // 새 그룹 생성
  meshGroup = new THREE.Group();
  scene.add(meshGroup);
  
  if (meshes.length === 0) return;
  
  // 모든 메시를 원래 위치 그대로 추가
  meshes.forEach(mesh => {
    meshGroup.add(mesh);
  });
  
  // 모든 모델이 보이도록 카메라 위치 자동 조정
  fitCameraToMeshes();
}

// 모든 메시 지우기
function clearAllMeshes() {
  if (meshGroup) {
    scene.remove(meshGroup);
  }
  
  // 각 메시의 지오메트리 해제
  meshes.forEach(mesh => {
    mesh.geometry.dispose();
  });
  
  meshes = [];
  meshGroup = null;
}

// STL 파일 처리
function processSTLFile(arrayBuffer, filename = '') {
  try {
    const geometry = stlLoader.parse(arrayBuffer);
    const positionAttr = geometry.getAttribute('position');
    
    if (!positionAttr) {
      console.error('BufferGeometry has no position attribute:', filename);
      return null;
    }
    
    const positions = positionAttr.array;
    const indices = [];
    for (let i = 0; i < positions.length / 3; i += 3) {
      indices.push(i, i + 1, i + 2);
    }
    
    let newGeometry = new THREE.BufferGeometry();
    newGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    newGeometry.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
    
    return addMeshFromGeometry(newGeometry);
  } catch (error) {
    console.error('Error processing STL file:', filename, error);
    return null;
  }
}

// ZIP 파일 처리
async function processZipFile(arrayBuffer) {
  try {
    const zip = await JSZip.loadAsync(arrayBuffer);
    let processedFiles = 0;
    
    // ZIP 내 파일 추출
    const promises = [];
    
    zip.forEach((relativePath, zipEntry) => {
      // STL 파일만 처리
      if (relativePath.toLowerCase().endsWith('.stl')) {
        const promise = zipEntry.async('arraybuffer').then(fileData => {
          const mesh = processSTLFile(fileData, relativePath);
          if (mesh) processedFiles++;
          return mesh;
        });
        promises.push(promise);
      }
    });
    
    await Promise.all(promises);
    
    if (processedFiles === 0) {
      console.warn('ZIP 파일에 STL 파일이 없습니다.');
    }
    
    arrangeMeshes();
  } catch (error) {
    console.error('ZIP 파일 처리 중 오류:', error);
  }
}

// 초기화 함수
function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);
  
  scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  
  // 추가 빛 설정
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
  directionalLight.position.set(1, 1, 1);
  scene.add(directionalLight);
  
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 50);
  camera.position.set(0, 0, 3);
  
  controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 5.0;
  controls.zoomSpeed = 1.2;
  controls.panSpeed = 0.8;
  controls.staticMoving = true;
  controls.dynamicDampingFactor = 0.3;
  
  // Matcap 텍스처 로드 - 비동기 로드로 변경하고 로드 완료 이벤트 처리
  const textureLoader = new THREE.TextureLoader();
  // 텍스처 로드 완료시 필요한 카운터
  let loadedTextures = 0;
  const totalTextures = 4;
  
  const onTextureLoaded = () => {
    loadedTextures++;
    if (loadedTextures === totalTextures) {
      console.log("모든 텍스처 로드 완료");
    }
  };
  
  textureLoader.load('textures/B67F6B_4B2E2A_6C3A34_F3DBC6-256px.png', (texture) => {
    matcaps['Clay'] = texture;
    updateMaterials();
    onTextureLoaded();
  }, undefined, (error) => console.error('텍스처 로드 오류:', error));
  
  textureLoader.load('textures/763C39_431510_210504_55241C-256px.png', (texture) => {
    matcaps['Red Wax'] = texture;
    updateMaterials();
    onTextureLoaded();
  }, undefined, (error) => console.error('텍스처 로드 오류:', error));
  
  textureLoader.load('textures/3B6E10_E3F2C3_88AC2E_99CE51-256px.png', (texture) => {
    matcaps['Shiny Green'] = texture;
    updateMaterials();
    onTextureLoaded();
  }, undefined, (error) => console.error('텍스처 로드 오류:', error));
  
  textureLoader.load('textures/7877EE_D87FC5_75D9C7_1C78C0-256px.png', (texture) => {
    matcaps['Normal'] = texture;
    updateMaterials();
    onTextureLoaded();
  }, undefined, (error) => console.error('텍스처 로드 오류:', error));
  
  // 기본 마테리얼 생성 (matcap은 텍스처 로드 완료 후 설정됨)
  material = new THREE.MeshMatcapMaterial({
    flatShading: false,
    side: THREE.DoubleSide
  });
  
  
  // UI 추가
  const uiContainer = document.createElement('div');
  uiContainer.style.position = 'absolute';
  uiContainer.style.top = '10px';
  uiContainer.style.left = '10px';
  uiContainer.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
  uiContainer.style.padding = '10px';
  uiContainer.style.borderRadius = '5px';
  uiContainer.style.color = 'white';
  document.body.appendChild(uiContainer);
  
  // 재질 선택 UI
  const matcapLabel = document.createElement('label');
  matcapLabel.textContent = '재질: ';
  uiContainer.appendChild(matcapLabel);
  
  const matcapSelect = document.createElement('select');
  for (const key in matcaps) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = key;
    matcapSelect.appendChild(option);
  }
  matcapSelect.value = params.matcap;
  matcapSelect.addEventListener('change', () => {
    params.matcap = matcapSelect.value;
    updateMaterials();
  });
  uiContainer.appendChild(matcapSelect);
  
  // 지우기 버튼
  const clearButton = document.createElement('button');
  clearButton.textContent = '모델 지우기';
  clearButton.style.marginLeft = '10px';
  clearButton.addEventListener('click', clearAllMeshes);
  uiContainer.appendChild(clearButton);
  
  // 안내 문구
  const infoText = document.createElement('div');
  infoText.textContent = 'STL 파일이나 ZIP 파일을 여기로 드래그 앤 드롭하세요';
  infoText.style.marginTop = '10px';
  uiContainer.appendChild(infoText);
    
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  
  window.addEventListener('dragover', e => {
    e.preventDefault();
  }, false);
  
  window.addEventListener('drop', async e => {
    e.preventDefault();
    
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    
    const files = e.dataTransfer.files;
    let hasValidFiles = false;
    
    // 파일이 1개이고 ZIP 파일이라면
    if (files.length === 1 && files[0].name.toLowerCase().endsWith('.zip')) {
      const reader = new FileReader();
      reader.onload = async (event) => {
        await processZipFile(event.target.result);
      };
      reader.readAsArrayBuffer(files[0]);
      hasValidFiles = true;
    } else {
      // 여러 파일 처리
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        // STL 파일만 처리
        if (file.name.toLowerCase().endsWith('.stl')) {
          const reader = new FileReader();
          reader.onload = (event) => {
            processSTLFile(event.target.result, file.name);
            arrangeMeshes();
          };
          reader.readAsArrayBuffer(file);
          hasValidFiles = true;
        }
      }
    }
    
    if (!hasValidFiles) {
      alert('STL 또는 ZIP 파일만 지원합니다.');
    }
  }, false);
  
  render();
}

function render() {
  requestAnimationFrame(render);
  controls.update();
  renderer.render(scene, camera);
}

// 모든 메시의 재질 업데이트
function updateMaterials() {
  // 선택된 matcap이 로드되었는지 확인
  if (!matcaps[params.matcap]) {
    return;
  }
  
  // 전역 material 업데이트
  material.matcap = matcaps[params.matcap];
  
  // 모든 메시 업데이트
  meshes.forEach(mesh => {
    if (mesh.material && mesh.material.isMeshMatcapMaterial) {
      mesh.material.matcap = matcaps[params.matcap];
      mesh.material.needsUpdate = true;
    }
  });
}

init();