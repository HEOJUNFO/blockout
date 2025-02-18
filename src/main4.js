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
let blockoutMesh = null;

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
  

  // 두 Mesh를 합쳐서 targetMesh를 업데이트하는 함수
  function mergeTargetAndBlockout() {
    if (!targetMesh || !blockoutMesh) return;
  
    // targetMesh와 blockoutMesh의 geometry를 non-indexed 형태로 변환
    const geom1 = targetMesh.geometry.index !== null ? targetMesh.geometry.toNonIndexed() : targetMesh.geometry;
    const geom2 = blockoutMesh.geometry.index !== null ? blockoutMesh.geometry.toNonIndexed() : blockoutMesh.geometry;
  
    // 최신 mergeGeometries() 사용 (두 기하체의 속성이 호환되어야 함)
    const mergedGeometry = BufferGeometryUtils.mergeGeometries([geom1, geom2], false);
    if (!mergedGeometry) {
      console.error("Geometry 병합에 실패했습니다.");
      return;
    }
    
    mergedGeometry.computeVertexNormals();
  
    // 기존 Mesh 제거 및 메모리 해제
    scene.remove(targetMesh);
    scene.remove(blockoutMesh);
    targetMesh.geometry.dispose();
    blockoutMesh.geometry.dispose();
  
    // 병합된 geometry로 새로운 targetMesh 생성 및 추가
    targetMesh = new THREE.Mesh(mergedGeometry, material);
    scene.add(targetMesh);
  
    // blockoutMesh는 이제 필요 없으므로 null 처리
    blockoutMesh = null;
  }
  
 

  function applyBlockout() {
    if (!undercutMesh) return;
  
    const offsetDistance = 0.05; // 원하는 오프셋 거리 (필요에 따라 조절)
    // undercutMesh의 geometry 복사 (원본은 유지)
    const geometry = undercutMesh.geometry.clone();
    const posAttr = geometry.attributes.position;
    const normAttr = geometry.attributes.normal;
  
    // 카메라의 정면 방향 계산
    const cameraDir = new THREE.Vector3();
    camera.getWorldDirection(cameraDir).normalize();
  
    // 각 정점에 대해 오프셋 적용
    for (let i = 0; i < posAttr.count; i++) {
      // 정점의 법선 읽기
      const normal = new THREE.Vector3(
        normAttr.getX(i),
        normAttr.getY(i),
        normAttr.getZ(i)
      );
      // 카메라 방향과의 내적을 빼서, 카메라 방향에 수직인 성분만 남김
      const dot = normal.dot(cameraDir);
      const projected = normal.clone().sub(cameraDir.clone().multiplyScalar(dot));
      // 투영된 벡터의 길이가 0에 가깝다면 원래 법선을 사용
      if (projected.lengthSq() > 0.0001) {
        projected.normalize();
      } else {
        projected.copy(normal).normalize();
      }
      // 현재 정점 위치에 오프셋 추가
      const pos = new THREE.Vector3(
        posAttr.getX(i),
        posAttr.getY(i),
        posAttr.getZ(i)
      );
      pos.add(projected.multiplyScalar(offsetDistance));
      posAttr.setXYZ(i, pos.x, pos.y, pos.z);
    }
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
  
    // 기존에 blockoutMesh가 있다면 제거
    if (blockoutMesh) {
      scene.remove(blockoutMesh);
      blockoutMesh.geometry.dispose();
      blockoutMesh.material.dispose();
      blockoutMesh = null;
    }
  
    // blockout 시각화를 위한 Mesh 생성 (여기서는 초록색 반투명 재질 사용)
    const blockoutMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.5,
    });
    blockoutMesh = new THREE.Mesh(geometry, blockoutMaterial);
    scene.add(blockoutMesh);

    mergeTargetAndBlockout();
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
  gui.add( { applyBlockout }, 'applyBlockout' ).name("Apply Blockout");
  
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
