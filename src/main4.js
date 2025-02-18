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

function applyBlockout() {

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
