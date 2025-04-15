import * as dat from 'three/examples/jsm/libs/lil-gui.module.min.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// STLLoader 임포트
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

// three-mesh-bvh
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh';

// Raycast / BufferGeometry 프로토타입 확장
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

// 전역 변수들
let scene, camera, renderer, controls;
let targetMesh = null;
let material = false;

// Sculpt 파라미터 (대칭 관련 항목은 제거하고, sculpting 플래그 추가)
const params = {
  matcap: 'Clay',
  flatShading: false,
};

// matcaps
const matcaps = {};

// ----------------------------------------------------------------
//    1) 지오메트리 중심 정렬 + 스케일 정규화 (바운딩 스피어 기반)
// ----------------------------------------------------------------
function centerAndScaleGeometry( geometry ) {

  // 1) center() : 모델의 중심을 (0,0,0) 근처로 이동
  geometry.center();

  // 2) 바운딩 스피어 계산 -> 반지름(radius)을 1로 맞춤
  geometry.computeBoundingSphere();
  if ( geometry.boundingSphere ) {
    const radius = geometry.boundingSphere.radius;
    const scaleFactor = 1 / radius; // 반지름이 1이 되도록 스케일
    geometry.scale( scaleFactor, scaleFactor, scaleFactor );
  }
}

function fitCameraToObject( camera, object, offset = 2 ) {

  // object의 World Matrix가 최신 상태임을 보장
  object.updateWorldMatrix( true, false );

  // 바운딩 박스를 구함
  const box = new THREE.Box3().setFromObject( object );
  const center = box.getCenter( new THREE.Vector3() );
  const size = box.getSize( new THREE.Vector3() );

  // 최대 치수를 구함
  const maxDim = Math.max( size.x, size.y, size.z );

  // 카메라 fov는 degree이므로 라디안으로 변환
  const fov = camera.fov * ( Math.PI / 180 );
  // 모델을 모두 담기 위한 Z 거리 (단순 근사)
  let cameraZ = maxDim / 2 / Math.tan( fov / 2 );
  cameraZ *= offset; // 여유 공간

  // 모델 중심 좌표와 cameraZ를 이용해 카메라 위치 지정
  camera.position.set( center.x, center.y, center.z + cameraZ );
  camera.lookAt( center );

  // OrbitControls가 있다면, target도 모델 중심에 맞춤
  if ( controls ) {
    controls.target.copy( center );
    controls.update();
  }
}

// ----------------------------------------------------------------
//    STL 지오메트리 세팅 함수 (STL 업로드 시 호출)
// ----------------------------------------------------------------
function setTargetMeshGeometry( geometry ) {

  // 기존 targetMesh 제거
  if ( targetMesh ) {
    targetMesh.geometry.dispose();
    targetMesh.material.dispose();
    scene.remove( targetMesh );
    targetMesh = null;
  }

  // (1) STL 지오메트리를 중심 정렬 및 스케일 정규화
  centerAndScaleGeometry( geometry );

  // (2) 남은 작업들
  geometry.deleteAttribute( 'uv' );
  geometry = BufferGeometryUtils.mergeVertices( geometry );
  geometry.computeVertexNormals();
  geometry.attributes.position.setUsage( THREE.DynamicDrawUsage );
  geometry.attributes.normal.setUsage( THREE.DynamicDrawUsage );
  geometry.computeBoundsTree( { setBoundingBox: false } );

  // (3) 새 mesh 생성
  targetMesh = new THREE.Mesh( geometry, material );
  targetMesh.frustumCulled = false;
  scene.add( targetMesh );

  // (5) 모델이 씬에 배치된 뒤 카메라와 컨트롤을 자동 조정
  fitCameraToObject( camera, targetMesh );
}

// ----------------------------------------------------------------
//                     STL 로더 & 드래그 앤 드롭
// ----------------------------------------------------------------
const stlLoader = new STLLoader();

// 드래그 영역에 파일이 들어오면 기본 이벤트 취소
window.addEventListener( 'dragover', e => {
  e.preventDefault();
}, false );

// 드롭 이벤트 발생 시 STL 파일 로드
window.addEventListener( 'drop', e => {

  e.preventDefault();

  if ( e.dataTransfer.files && e.dataTransfer.files.length > 0 ) {

    const file = e.dataTransfer.files[ 0 ];
    const reader = new FileReader();

    reader.addEventListener( 'load', event => {

      // arrayBuffer 받아 STL 파싱
      const arrayBuffer = event.target.result;
      const geometry = stlLoader.parse( arrayBuffer );

      const positionAttr = geometry.getAttribute('position');
      if ( ! positionAttr ) {
        throw new Error('BufferGeometry has no position attribute.');
      }
      const positions = positionAttr.array; // Float32Array

      const indices = [];
      // positions.length는 (정점 수 * 3) 이므로, 실제 정점 개수 = positions.length / 3
      for ( let i = 0; i < positions.length / 3; i += 3 ) {
        indices.push( i, i + 1, i + 2 );
      }

      // 4) 새로운 BufferGeometry 생성
      let newGeometry = new THREE.BufferGeometry();

      // position 어트리뷰트 등록 (3개씩 -> x, y, z)
      newGeometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute( positions, 3 )
      );

      // 인덱스 설정
      newGeometry.setIndex(
        new THREE.Uint32BufferAttribute( indices, 1 )
      );

      // STL 지오메트리 세팅 (정규화 + scene에 추가 + 카메라 조정)
      setTargetMeshGeometry( newGeometry );

    }, false );

    // 바이너리 STL 읽기
    reader.readAsArrayBuffer( file );
  }
}, false );

function createDentalChartUI() {
  // Create dental chart container
  const dentalChartContainer = document.createElement('div');
  dentalChartContainer.id = 'dental-chart-container';
  document.body.appendChild(dentalChartContainer);

  // Add styles
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    #dental-chart-container {
      position: fixed;
      left: 20px;
      top: 50%;
      transform: translateY(-50%);
      width: 350px;
      background-color: white;
      border-radius: 10px;
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
      z-index: 1000;
      pointer-events: auto;
    }
    .jaw-label {
      text-align: center;
      margin: 20px 0 10px;
      font-size: 16px;
      font-weight: bold;
      color: #333;
    }
    .teeth-container {
      position: relative;
      height: 240px;
      margin: 0 auto;
      width: 100%;
    }
    .tooth {
      position: absolute;
      width: 30px;
      height: 45px;
      transition: transform 0.2s;
      display: flex;
      flex-direction: column;
      align-items: center;
      z-index: 10;
      cursor: pointer;
    }
    .tooth:hover {
      transform: scale(1.1);
    }
    .tooth.selected {
      border: 2px solid #FF5722;
      border-radius: 8px;
      background-color: rgba(255, 87, 34, 0.1);
    }
    .tooth-image {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .tooth-number {
      position: absolute;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      background-color: #4691E0;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: bold;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
      z-index: 20;
    }
    .selected-path {
      position: absolute;
      pointer-events: none;
      z-index: -1;
    }
    #model-selection-ui {
      position: fixed;
      top: 20px;
      right: 20px;
      background: white;
      border-radius: 10px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      padding: 15px;
      z-index: 1100;
      width: 300px;
      max-height: 70vh;
      overflow-y: auto;
    }
    .ui-header {
      display: flex;
      flex-direction: column;
      margin-bottom: 15px;
    }
    .ui-header h3 {
      margin: 0;
      font-size: 18px;
      color: #333;
      text-align: center;
    }
    .models-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 15px;
    }
    .model-item {
      display: flex;
      align-items: center;
      padding: 10px;
      border-radius: 8px;
      cursor: pointer;
      transition: background-color 0.2s;
      border: 1px solid #e0e0e0;
    }
    .model-item:hover {
      background-color: #f5f5f5;
    }
    .model-item.selected {
      background-color: #e3f2fd;
      border-color: #2196F3;
    }
    .model-preview {
      width: 40px;
      height: 40px;
      background-color: #f0f0f0;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 12px;
    }
    .model-icon {
      font-size: 24px;
    }
    .model-info {
      flex: 1;
    }
    .model-name {
      font-weight: bold;
      color: #333;
      margin-bottom: 4px;
    }
    .model-group {
      font-size: 12px;
      color: #666;
    }
    .ui-footer {
      display: flex;
      justify-content: flex-end;
    }
    #cancel-model-btn {
      padding: 8px 12px;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      font-weight: bold;
      background-color: #f5f5f5;
      color: #333;
      transition: background-color 0.2s;
    }
    #cancel-model-btn:hover {
      background-color: #e0e0e0;
    }
    #loading-message {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background-color: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 20px;
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      align-items: center;
      z-index: 2000;
    }
    .loading-spinner {
      width: 40px;
      height: 40px;
      border: 4px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top: 4px solid white;
      animation: spin 1s linear infinite;
      margin-bottom: 10px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(styleElement);

  // Create upper jaw section
  const upperJawLabel = document.createElement('div');
  upperJawLabel.className = 'jaw-label';
  upperJawLabel.textContent = '상악';
  dentalChartContainer.appendChild(upperJawLabel);

  const upperJawContainer = document.createElement('div');
  upperJawContainer.className = 'teeth-container';
  upperJawContainer.id = 'upper-jaw';
  dentalChartContainer.appendChild(upperJawContainer);

  // Create lower jaw section
  const lowerJawLabel = document.createElement('div');
  lowerJawLabel.className = 'jaw-label';
  lowerJawLabel.textContent = '하악';
  dentalChartContainer.appendChild(lowerJawLabel);

  const lowerJawContainer = document.createElement('div');
  lowerJawContainer.className = 'teeth-container';
  lowerJawContainer.id = 'lower-jaw';
  dentalChartContainer.appendChild(lowerJawContainer);

  // 정확한 치아 위치 데이터 (사용자가 정의한 위치)
  const teethPositions = {
    "11": {
      "x": 163.390625,
      "y": 30,
      "jawType": "upper"
    },
    "12": {
      "x": 137.4609375,
      "y": 53.59375,
      "jawType": "upper"
    },
    "13": {
      "x": 120.203125,
      "y": 73.8671875,
      "jawType": "upper"
    },
    "14": {
      "x": 109.7421875,
      "y": 101.8671875,
      "jawType": "upper"
    },
    "15": {
      "x": 101.0234375,
      "y": 125.6484375,
      "jawType": "upper"
    },
    "16": {
      "x": 92.2265625,
      "y": 155.578125,
      "jawType": "upper"
    },
    "17": {
      "x": 86.640625,
      "y": 188.890625,
      "jawType": "upper"
    },
    "21": {
      "x": 195.03125,
      "y": 32.921875,
      "jawType": "upper"
    },
    "22": {
      "x": 223.84375,
      "y": 50.1015625,
      "jawType": "upper"
    },
    "23": {
      "x": 240.015625,
      "y": 71.6875,
      "jawType": "upper"
    },
    "24": {
      "x": 252.4765625,
      "y": 101.90625,
      "jawType": "upper"
    },
    "25": {
      "x": 261.578125,
      "y": 129.3515625,
      "jawType": "upper"
    },
    "26": {
      "x": 265.7734375,
      "y": 160.765625,
      "jawType": "upper"
    },
    "27": {
      "x": 275.1015625,
      "y": 193.0234375,
      "jawType": "upper"
    },
    "31": {
      "x": 194.3046875,
      "y": 190,
      "jawType": "lower"
    },
    "32": {
      "x": 224.2734375,
      "y": 168.078125,
      "jawType": "lower"
    },
    "33": {
      "x": 244.9765625,
      "y": 135.4765625,
      "jawType": "lower"
    },
    "34": {
      "x": 262.703125,
      "y": 106,
      "jawType": "lower"
    },
    "35": {
      "x": 274.140625,
      "y": 75.453125,
      "jawType": "lower"
    },
    "36": {
      "x": 277.671875,
      "y": 45.515625,
      "jawType": "lower"
    },
    "37": {
      "x": 282.71875,
      "y": 13.09375,
      "jawType": "lower"
    },
    "41": {
      "x": 162.8203125,
      "y": 190,
      "jawType": "lower"
    },
    "42": {
      "x": 133.5,
      "y":168.875,
      "jawType": "lower"
    },
    "43": {
      "x": 119.5859375,
      "y": 135.0625,
      "jawType": "lower"
    },
    "44": {
      "x": 103.6484375,
      "y": 106.34375,
      "jawType": "lower"
    },
    "45": {
      "x": 90.7734375,
      "y": 75.3125,
      "jawType": "lower"
    },
    "46": {
      "x": 79.2421875,
      "y": 45.25,
      "jawType": "lower"
    },
    "47": {
      "x": 68.5390625,
      "y": 13.34375,
      "jawType": "lower"
    },
  }

  function createTooth(id, x, y, container, numberPosition) {
    const toothElement = document.createElement('div');
    toothElement.className = 'tooth';
    toothElement.setAttribute('data-id', id);
    toothElement.style.left = `${x - 15}px`;  // 너비(30px)의 절반만큼 왼쪽으로 이동
    toothElement.style.top = `${y - 22.5}px`;   // 높이(45px)의 절반만큼 위로 이동
    
    // 치아 클릭 이벤트 추가
    toothElement.addEventListener('click', () => {
      loadToothModel(id);
    });
    
    const imgElement = document.createElement('img');
    imgElement.className = 'tooth-image';
    imgElement.src = `/images/${id}.png`;
    imgElement.alt = `Tooth ${id}`;
    toothElement.appendChild(imgElement);
  
    const numberElement = document.createElement('div');
    numberElement.className = 'tooth-number';
    numberElement.textContent = id;
  
    // 치아 번호의 위치를 동적으로 결정
    // ID의 마지막 숫자 추출 (예: 18 -> 8, 21 -> 1)
    const lastDigit = id % 10;
    
    // 상악/하악 확인
    const isUpper = numberPosition === 'top';
    
    // 1, 2에 가까울수록 수직, 7, 8에 가까울수록 수평
    if (lastDigit <= 2) {
      // 전치부 (1, 2) - 수직 방향
      if (isUpper) {
        numberElement.style.top = '-9px';
        numberElement.style.left = '8px'; // 중앙에서 약간 이동
      } else {
        numberElement.style.bottom = '-9px';
        numberElement.style.left = '8px'; // 중앙에서 약간 이동
      }
    } else if (lastDigit >= 7) {
      // 구치부 (7, 8) - 수평 방향
      if (id < 30) { // 상악
        if (id < 20) { // 왼쪽
          numberElement.style.left = '-9px';
        } else { // 오른쪽
          numberElement.style.right = '-9px';
        }
      } else { // 하악
        if (id < 40) { // 오른쪽
          numberElement.style.right = '-9px';
        } else { // 왼쪽
          numberElement.style.left = '-9px';
        }
      }
      numberElement.style.top = '15px'; // 세로 방향으로 중앙에 위치
    } else {
      // 중간 치아 (3~6) - 점진적으로 변화하는 위치
      const ratio = (lastDigit - 2) / 5; // 0(3번 치아)에서 0.8(6번 치아)까지의 비율
      
      if (id < 30) { // 상악
        if (id < 20) { // 왼쪽
          numberElement.style.left = `${-9 * ratio}px`;
          numberElement.style.top = `${-9 * (1 - ratio)}px`;
        } else { // 오른쪽
          numberElement.style.right = `${-9 * ratio}px`;
          numberElement.style.top = `${-9 * (1 - ratio)}px`;
        }
      } else { // 하악
        if (id < 40) { // 오른쪽
          numberElement.style.right = `${-9 * ratio}px`;
          numberElement.style.bottom = `${-9 * (1 - ratio)}px`;
        } else { // 왼쪽
          numberElement.style.left = `${-9 * ratio}px`;
          numberElement.style.bottom = `${-9 * (1 - ratio)}px`;
        }
      }
    }
  
    toothElement.appendChild(numberElement);
    container.appendChild(toothElement);
  }
  
  // 치아 모델 로드 함수
  function loadToothModel(toothId) {
    // 현재 선택된 치아 하이라이트 처리
    highlightSelectedTooth(toothId);
    
    // 모든 가능한 모델 경로
    const modelPaths = ['AA', 'AK', 'ED', 'JM', 'JS', 'ND', 'VB', 'YL'];
    
    // 모델 로딩 시작 메시지
    showLoadingMessage(toothId);
    
    // 각 경로에서 모델 존재 여부 확인 및 로드
    const availableModels = [];
    let loadedCount = 0;
    
    modelPaths.forEach(path => {
      // STL 파일 경로 생성
      const stlPath = `/models/${path}/${path}_${toothId}.stl`;
      
      // 해당 경로에 파일이 존재하는지 확인
      checkFileExists(stlPath)
        .then(exists => {
          loadedCount++;
          
          if (exists) {
            availableModels.push({
              path: stlPath,
              name: `${path}_${toothId}`,
              group: path
            });
          }
          
          // 모든 경로 확인이 완료되면 모델 선택 UI 표시
          if (loadedCount === modelPaths.length) {
            hideLoadingMessage();
            if (availableModels.length > 0) {
              showModelSelectionUI(toothId, availableModels);
            } else {
              alert(`${toothId}번 치아에 사용 가능한 모델이 없습니다.`);
            }
          }
        })
        .catch(error => {
          console.error(`경로 확인 오류 (${stlPath}):`, error);
          loadedCount++;
          
          // 모든 경로 확인이 완료되면 모델 선택 UI 표시
          if (loadedCount === modelPaths.length) {
            hideLoadingMessage();
            if (availableModels.length > 0) {
              showModelSelectionUI(toothId, availableModels);
            } else {
              alert(`${toothId}번 치아에 사용 가능한 모델이 없습니다.`);
            }
          }
        });
    });
  }
  
  // 파일 존재 여부 확인 함수
  function checkFileExists(url) {
    return new Promise((resolve) => {
      // STLLoader를 사용하여 파일 로드 시도
      const loader = new STLLoader();
      
      loader.load(
        url,
        // 로드 성공 시 - 파일이 존재함
        () => {
          resolve(true);
        },
        // 진행 상황 - 무시
        () => {},
        // 에러 발생 시 - 파일이 존재하지 않음
        () => {
          resolve(false);
        }
      );
    });
  }
  
  // 로딩 메시지 표시
  function showLoadingMessage(toothId) {
    // 기존 메시지가 있으면 제거
    hideLoadingMessage();
    
    const loadingMessage = document.createElement('div');
    loadingMessage.id = 'loading-message';
    loadingMessage.innerHTML = `
      <div class="loading-spinner"></div>
      <p>${toothId}번 치아 모델을 검색 중입니다...</p>
    `;
    document.body.appendChild(loadingMessage);
  }
  
  // 로딩 메시지 숨기기
  function hideLoadingMessage() {
    const existingMessage = document.getElementById('loading-message');
    if (existingMessage) {
      existingMessage.remove();
    }
  }
  
  // 선택된 치아 하이라이트 처리
  function highlightSelectedTooth(toothId) {
    // 모든 치아 요소의 하이라이트 제거
    document.querySelectorAll('.tooth').forEach(tooth => {
      tooth.classList.remove('selected');
    });
    
    // 선택된 치아에 하이라이트 추가
    const selectedTooth = document.querySelector(`.tooth[data-id="${toothId}"]`);
    if (selectedTooth) {
      selectedTooth.classList.add('selected');
    }
  }
  
  // 모델 선택 UI 표시
  function showModelSelectionUI(toothId, availableModels) {
    // 기존 UI가 있으면 제거
    const existingUI = document.getElementById('model-selection-ui');
    if (existingUI) {
      existingUI.remove();
    }
    
    // 모델 목록 HTML 생성
    let modelsListHTML = '';
    availableModels.forEach((model, index) => {
      modelsListHTML += `
        <div class="model-item" data-path="${model.path}" data-index="${index}">
          <div class="model-preview" id="preview-${index}">
            <span class="model-icon">🦷</span>
          </div>
          <div class="model-info">
            <div class="model-name">${model.name}</div>
            <div class="model-group">그룹: ${model.group}</div>
          </div>
        </div>
      `;
    });
    
    // 새 UI 생성
    const selectionUI = document.createElement('div');
    selectionUI.id = 'model-selection-ui';
    selectionUI.innerHTML = `
      <div class="ui-header">
        <h3>${toothId}번 치아 모델 선택</h3>
      </div>
      <div class="models-list">
        ${modelsListHTML}
      </div>
      <div class="ui-footer">
        <button id="cancel-model-btn">취소</button>
      </div>
    `;
    
    document.body.appendChild(selectionUI);
    
    // 모델 항목 클릭 이벤트
    document.querySelectorAll('.model-item').forEach(item => {
      item.addEventListener('click', () => {
        // 기존 선택 해제
        document.querySelectorAll('.model-item').forEach(el => {
          el.classList.remove('selected');
        });
        
        // 새 선택 항목 하이라이트
        item.classList.add('selected');
        
        // 모델 로드 및 표시
        const modelPath = item.getAttribute('data-path');
        loadSTLModel(modelPath);
      });
    });
    
    // 취소 버튼 이벤트
    document.getElementById('cancel-model-btn').addEventListener('click', () => {
      selectionUI.remove();
    });
    
    // 첫 번째 모델을 자동으로 로드 (미리보기)
    if (availableModels.length > 0) {
      loadSTLModel(availableModels[0].path);
      document.querySelector('.model-item').classList.add('selected');
    }
  }
  
  // STL 모델 로드 및 표시 함수
  function loadSTLModel(modelPath) {
    const loader = new STLLoader();
    
    loader.load(
      modelPath,
      (geometry) => {
        // 로드 성공 시 처리
        const positionAttr = geometry.getAttribute('position');
        if (!positionAttr) {
          console.error('BufferGeometry has no position attribute.');
          return;
        }
        const positions = positionAttr.array;

        const indices = [];
        for (let i = 0; i < positions.length / 3; i += 3) {
          indices.push(i, i + 1, i + 2);
        }

        // 새로운 BufferGeometry 생성
        let newGeometry = new THREE.BufferGeometry();

        // position 어트리뷰트 등록
        newGeometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(positions, 3)
        );

        // 인덱스 설정
        newGeometry.setIndex(
          new THREE.Uint32BufferAttribute(indices, 1)
        );

        // 지오메트리 세팅 및 화면에 표시
        setTargetMeshGeometry(newGeometry);
      },
      // 로드 진행 상황
      (xhr) => {
        console.log((xhr.loaded / xhr.total * 100) + '% loaded');
      },
      // 로드 에러 시
      (error) => {
        console.error('STL 로드 오류:', error);
        alert(`모델을 로드할 수 없습니다: ${modelPath}`);
      }
    );
  }

  // 상악 치아 배치 (사용자가 정의한 위치로)
  for (let id = 11; id <= 18; id++) {
    if (teethPositions[id]) {
      createTooth(id, teethPositions[id].x, teethPositions[id].y, upperJawContainer, 'top');
    }
  }

  for (let id = 21; id <= 28; id++) {
    if (teethPositions[id]) {
      createTooth(id, teethPositions[id].x, teethPositions[id].y, upperJawContainer, 'top');
    }
  }

  // 하악 치아 배치 (사용자가 정의한 위치로)
  for (let id = 31; id <= 38; id++) {
    if (teethPositions[id]) {
      createTooth(id, teethPositions[id].x, teethPositions[id].y, lowerJawContainer, 'bottom');
    }
  }

  for (let id = 41; id <= 48; id++) {
    if (teethPositions[id]) {
      createTooth(id, teethPositions[id].x, teethPositions[id].y, lowerJawContainer, 'bottom');
    }
  }
}

function init() {

  const bgColor = 0x060609;

  // renderer
  renderer = new THREE.WebGLRenderer( { antialias: true } );
  renderer.setPixelRatio( window.devicePixelRatio );
  renderer.setSize( window.innerWidth, window.innerHeight );
  renderer.setClearColor( bgColor, 1 );
  renderer.outputEncoding = THREE.sRGBEncoding;
  document.body.appendChild( renderer.domElement );
  renderer.domElement.style.touchAction = 'none';

  // scene
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog( 0x263238 / 2, 20, 60 );

  // light
  const light = new THREE.DirectionalLight( 0xffffff, 0.5 );
  light.position.set( 1, 1, 1 );
  scene.add( light );
  scene.add( new THREE.AmbientLight( 0xffffff, 0.4 ) );

  // camera
  camera = new THREE.PerspectiveCamera(
    75, window.innerWidth / window.innerHeight, 0.1, 50
  );
  camera.position.set( 0, 0, 3 );
  camera.far = 100;
  camera.updateProjectionMatrix();

  // OrbitControls 초기화 및 설정
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; // 부드러운 움직임
  controls.dampingFactor = 0.05;
  controls.screenSpacePanning = false;
  controls.minDistance = 1;
  controls.maxDistance = 10;
  controls.maxPolarAngle = Math.PI; // 전체 회전 가능
  controls.update();

  // matcaps
  matcaps[ 'Clay' ] = new THREE.TextureLoader().load( 'textures/B67F6B_4B2E2A_6C3A34_F3DBC6-256px.png' );
  matcaps[ 'Red Wax' ] = new THREE.TextureLoader().load( 'textures/763C39_431510_210504_55241C-256px.png' );
  matcaps[ 'Shiny Green' ] = new THREE.TextureLoader().load( 'textures/3B6E10_E3F2C3_88AC2E_99CE51-256px.png' );
  matcaps[ 'Normal' ] = new THREE.TextureLoader().load( 'textures/7877EE_D87FC5_75D9C7_1C78C0-256px.png' );

  material = new THREE.MeshMatcapMaterial( {
    flatShading: params.flatShading,
    side: THREE.DoubleSide,
  } );

  for ( const key in matcaps ) {
    matcaps[ key ].encoding = THREE.sRGBEncoding;
  }

  // GUI
  const gui = new dat.GUI();
  gui.add( params, 'matcap', Object.keys( matcaps ) );
  gui.open();

  // 이벤트 리스너
  window.addEventListener( 'resize', onWindowResize, false );
  function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize( window.innerWidth, window.innerHeight );
  }

  // 치아 차트 UI 추가
  createDentalChartUI();
}

function render() {
  requestAnimationFrame(render);

  // OrbitControls 업데이트 (다음 프레임에 적용되도록)
  if (controls) {
    controls.update();
  }

  material.matcap = matcaps[params.matcap];
  renderer.render(scene, camera);
}

init();
render();