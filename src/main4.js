import Stats from 'three/examples/jsm/libs/stats.module.js';
import * as dat from 'three/examples/jsm/libs/lil-gui.module.min.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { SUBTRACTION, Brush, Evaluator } from 'three-bvh-csg';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

let stats, scene, camera, renderer, controls;
let targetMesh = null;
let blockoutMesh = null;
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
  if (!targetMesh) return;
  
  targetMesh.updateMatrixWorld(true);
  const geometry = targetMesh.geometry;
  const posAttr = geometry.attributes.position;
  const indexAttr = geometry.index;
  const cameraPos = camera.position;
  
  const undercutPositions = [];
  for (let i = 0; i < indexAttr.count; i += 3) {
    const aIndex = indexAttr.getX(i);
    const bIndex = indexAttr.getX(i + 1);
    const cIndex = indexAttr.getX(i + 2);
    
    const a = new THREE.Vector3().fromBufferAttribute(posAttr, aIndex).applyMatrix4(targetMesh.matrixWorld);
    const b = new THREE.Vector3().fromBufferAttribute(posAttr, bIndex).applyMatrix4(targetMesh.matrixWorld);
    const c = new THREE.Vector3().fromBufferAttribute(posAttr, cIndex).applyMatrix4(targetMesh.matrixWorld);
    
    const center = new THREE.Vector3().addVectors(a, b).add(c).divideScalar(3);
    const normal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
    const viewVec = new THREE.Vector3().subVectors(cameraPos, center).normalize();
    
    if (normal.dot(viewVec) <= 0.01) {
      undercutPositions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  }

  if (undercutPositions.length > 0) {
    const undercutGeometry = new THREE.BufferGeometry();
    undercutGeometry.setAttribute('position', new THREE.Float32BufferAttribute(undercutPositions, 3));
    const redMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide, transparent: true, opacity: 0.5 });
    const undercutMesh = new THREE.Mesh(undercutGeometry, redMaterial);
    scene.add(undercutMesh);
  }
}

// 블록아웃 기능 (언더컷 보강)
function applyBlockout() {
  if (!targetMesh) return;
  
  if (blockoutMesh) {
    scene.remove(blockoutMesh);
    blockoutMesh.geometry.dispose();
  }
  
  const offset = new THREE.Vector3(0, 0, -0.02); 
  const blockoutGeometry = targetMesh.geometry.clone();
  blockoutGeometry.translate(offset.x, offset.y, offset.z);
  
  const blockoutMeshNew = new THREE.Mesh(blockoutGeometry, new THREE.MeshBasicMaterial({ color: 0x808080, transparent: true, opacity: 0.6 }));
  
  const csgResult = CSG.union(targetMesh, blockoutMeshNew);
  blockoutMesh = new THREE.Mesh(csgResult.geometry, targetMesh.material);
  scene.add(blockoutMesh);
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
  
  gui.add(params, 'detectUndercuts').name('Detect Undercuts').onChange(detectUndercuts);
  gui.add(params, 'blockout').name('Apply Blockout').onChange(applyBlockout);
  
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
              // 주의: 두 번째 인자로 3을 넣어야 x,y,z로 묶임
              newGeometry.setAttribute(
                'position',
                new THREE.Float32BufferAttribute( positions, 3 )
              );
      
              // 인덱스 설정
              // 만약 정점 수가 매우 많을 경우, Uint32BufferAttribute( indices, 1 )가 필요할 수도 있음
              // (65,535개 초과인 경우)
              newGeometry.setIndex(
                new THREE.Uint32BufferAttribute( indices, 1 )
              );
      
            // STL 지오메트리 세팅 (정규화 + scene에 추가 + 카메라조정)
            setTargetMeshGeometry( newGeometry );
  
      }, false );
  
      // 바이너리 STL 읽기
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
