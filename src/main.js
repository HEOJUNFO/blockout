import Stats from 'three/examples/jsm/libs/stats.module.js';
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
  MeshBVHHelper,
} from 'three-mesh-bvh';

import { performStroke, updateNormals } from './sculpt.js';

// Raycast / BufferGeometry 프로토타입 확장
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

// 전역 변수들
let stats;
let scene, camera, renderer, controls;
let targetMesh = null;
let brush, bvhHelper;
let normalZ = new THREE.Vector3( 0, 0, 1 );
let brushActive = false;
let mouse = new THREE.Vector2(), lastMouse = new THREE.Vector2();
let mouseState = false, lastMouseState = false;
let lastCastPose = new THREE.Vector3();
let material, rightClick = false;
let undercutMesh = null; // undercut 시각화용 메쉬

// Sculpt 파라미터 (대칭 관련 항목은 제거하고, sculpting 플래그 추가)
const params = {
  matcap: 'Clay',
  size: 0.01,
  brush: 'clay',
  intensity: 10,
  maxSteps: 10,
  invert: false,
  flatShading: false,
  depth: 10,
  displayHelper: false,
  sculpting: false, // 스컬팅 기능 활성화 여부 (처음엔 false)
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

// ----------------------------------------------------------------
//    2) 모델 전체가 화면에 들어오도록 카메라와 컨트롤을 조정 (일종의 Bounds 기능)
// ----------------------------------------------------------------
function fitCameraToObject( camera, object, offset = 1.25 ) {

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

  // BVHHelper 제거
  if ( bvhHelper ) {
    scene.remove( bvhHelper );
    bvhHelper = null;
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

  // (4) BVH Helper (필요하면 다시 생성)
  bvhHelper = new MeshBVHHelper( targetMesh, params.depth );
  if ( params.displayHelper ) {
    scene.add( bvhHelper );
  }
  bvhHelper.update();

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

// ----------------------------------------------------------------
//        reset() : 현재 메쉬와 BVHHelper를 제거해 빈 상태로
// ----------------------------------------------------------------
function reset() {

  if ( targetMesh ) {
    targetMesh.geometry.dispose();
    targetMesh.material.dispose();
    scene.remove( targetMesh );
    targetMesh = null;
  }

  if ( bvhHelper ) {
    scene.remove( bvhHelper );
    bvhHelper = null;
  }
  
  // undercut 시각화 제거
  if ( undercutMesh ) {
    scene.remove( undercutMesh );
    undercutMesh.geometry.dispose();
    undercutMesh.material.dispose();
    undercutMesh = null;
  }
}

// ----------------------------------------------------------------
//    undercut 감지 및 빨간색 시각화 함수 (카메라 기준으로 보이지 않는 면만)
// ----------------------------------------------------------------
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

// ----------------------------------------------------------------
//                       초기화 함수
// ----------------------------------------------------------------
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

  // brush line geometry
  const brushSegments = [ new THREE.Vector3(), new THREE.Vector3( 0, 0, 1 ) ];
  for ( let i = 0; i < 50; i ++ ) {
    const nexti = i + 1;
    const x1 = Math.sin( 2 * Math.PI * i / 50 );
    const y1 = Math.cos( 2 * Math.PI * i / 50 );
    const x2 = Math.sin( 2 * Math.PI * nexti / 50 );
    const y2 = Math.cos( 2 * Math.PI * nexti / 50 );

    brushSegments.push(
      new THREE.Vector3( x1, y1, 0 ),
      new THREE.Vector3( x2, y2, 0 )
    );
  }

  brush = new THREE.LineSegments();
  brush.geometry.setFromPoints( brushSegments );
  brush.material.color.set( 0xfb8c00 );
  scene.add( brush );

  // camera
  camera = new THREE.PerspectiveCamera(
    75, window.innerWidth / window.innerHeight, 0.1, 50
  );
  camera.position.set( 0, 0, 3 );
  camera.far = 100;
  camera.updateProjectionMatrix();

  // stats
  stats = new Stats();
  document.body.appendChild( stats.dom );

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

  // 초기에는 빈 상태 (reset() 호출 X)

  // GUI
  const gui = new dat.GUI();
  gui.add( params, 'matcap', Object.keys( matcaps ) );

  const sculptFolder = gui.addFolder( 'Sculpting' );
  // sculpting 기능 체크박스 (초기 false)
  sculptFolder.add( params, 'sculpting' ).name('Sculpting');
  sculptFolder.add( params, 'brush', [ 'normal', 'clay', 'flatten' ] );
  sculptFolder.add( params, 'size', 0.025, 0.25, 0.005 );
  sculptFolder.add( params, 'intensity', 1, 100, 1 );
  sculptFolder.add( params, 'maxSteps', 1, 25, 1 );
  sculptFolder.add( params, 'invert' );
  sculptFolder.add( params, 'flatShading' ).onChange( value => {
    if ( targetMesh ) {
      targetMesh.material.flatShading = value;
      targetMesh.material.needsUpdate = true;
    }
  } );
  sculptFolder.open();

  const helperFolder = gui.addFolder( 'BVH Helper' );
  helperFolder.add( params, 'depth', 1, 20, 1 ).onChange( d => {
    if ( bvhHelper ) {
      bvhHelper.depth = parseFloat( d );
      bvhHelper.update();
    }
  } );
  helperFolder.add( params, 'displayHelper' ).onChange( display => {
    if ( ! bvhHelper ) return;
    if ( display ) {
      scene.add( bvhHelper );
      bvhHelper.update();
    } else {
      scene.remove( bvhHelper );
    }
  } );
  helperFolder.open();

  gui.add( { reset }, 'reset' );
  gui.add( { rebuildBVH: () => {
    if ( targetMesh ) {
      targetMesh.geometry.computeBoundsTree( { setBoundingBox: false } );
      if ( bvhHelper ) bvhHelper.update();
    }
  } }, 'rebuildBVH' );

  // undercut 감지 버튼 추가
  gui.add( { detectUndercuts }, 'detectUndercuts' ).name("Detect Undercuts");
  gui.open();

  // 이벤트 리스너
  window.addEventListener( 'resize', onWindowResize, false );
  function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize( window.innerWidth, window.innerHeight );
  }

  window.addEventListener( 'pointermove', e => {
    mouse.x = ( e.clientX / window.innerWidth ) * 2 - 1;
    mouse.y = - ( e.clientY / window.innerHeight ) * 2 + 1;
    brushActive = true;
  } );

  window.addEventListener( 'pointerdown', e => {
    mouse.x = ( e.clientX / window.innerWidth ) * 2 - 1;
    mouse.y = - ( e.clientY / window.innerHeight ) * 2 + 1;
    mouseState = Boolean( e.buttons & 3 );
    rightClick = Boolean( e.buttons & 2 );
    brushActive = true;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera( mouse, camera );
    raycaster.firstHitOnly = true;

    if ( targetMesh ) {
      const res = raycaster.intersectObject( targetMesh );
      controls.enabled = res.length === 0;
    }

  }, true );

  window.addEventListener( 'pointerup', e => {
    mouseState = Boolean( e.buttons & 3 );
    if ( e.pointerType === 'touch' ) {
      brushActive = false;
    }
  } );

  window.addEventListener( 'contextmenu', e => e.preventDefault() );

  // 휠 스크롤로 브러시 사이즈 조절
  window.addEventListener( 'wheel', e => {
    let delta = e.deltaY;
    if ( e.deltaMode === 1 ) {
      delta *= 40;
    }
    if ( e.deltaMode === 2 ) {
      delta *= 40;
    }
    params.size += delta * 0.0001;
    params.size = Math.max( Math.min( params.size, 0.25 ), 0.025 );
    gui.controllersRecursive().forEach( c => c.updateDisplay() );
  } );

  controls = new OrbitControls( camera, renderer.domElement );
  controls.minDistance = 1.5;

  controls.addEventListener( 'start', function () {
    this.active = true;
  } );

  controls.addEventListener( 'end', function () {
    this.active = false;
  } );

}

// ----------------------------------------------------------------
//                       렌더 루프
// ----------------------------------------------------------------
function render() {
  requestAnimationFrame(render);
  stats.begin();

  material.matcap = matcaps[params.matcap];

  // sculpting 플래그가 꺼져있거나 컨트롤/브러시 활성 상태가 아니라면 스컬팅 동작 중지
  if (!params.sculpting || controls.active || !brushActive || !targetMesh) {
    brush.visible = false;
    lastCastPose.setScalar(Infinity);
    controls.enabled = true;
  } else {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    raycaster.firstHitOnly = true;

    const hit = raycaster.intersectObject(targetMesh, true)[0];
    if (hit) {
      brush.visible = true;
      brush.scale.set(params.size, params.size, 0.1);
      brush.position.copy(hit.point);
      controls.enabled = false;

      if (lastCastPose.x === Infinity) {
        lastCastPose.copy(hit.point);
      }

      if (!(mouseState || lastMouseState)) {
        // 클릭하지 않은 경우: 브러시 위치(방향)만 갱신
        performStroke({
          mesh: targetMesh,
          point: hit.point,
          brushObject: brush,
          params: params,
          rightClick: rightClick,
          brushOnly: true
        });
        lastMouse.copy(mouse);
        lastCastPose.copy(hit.point);
      } else {
        // 마우스 이동과 raycast 위치 차이에 따라 여러 스텝으로 스트로크 적용
        const mdx = (mouse.x - lastMouse.x) * window.innerWidth * window.devicePixelRatio;
        const mdy = (mouse.y - lastMouse.y) * window.innerHeight * window.devicePixelRatio;
        let mdist = Math.sqrt(mdx * mdx + mdy * mdy);
        let castDist = hit.point.distanceTo(lastCastPose);

        const step = params.size * 0.15;
        const percent = Math.max(step / castDist, 1 / params.maxSteps);
        const mstep = mdist * percent;
        let stepCount = 0;

        const changedTriangles = new Set();
        const changedIndices = new Set();
        const traversedNodeIndices = new Set();
        const sets = {
          accumulatedTriangles: changedTriangles,
          accumulatedIndices: changedIndices,
          accumulatedTraversedNodeIndices: traversedNodeIndices
        };

        while (castDist > step && mdist > (params.size * 200) / hit.distance) {
          lastMouse.lerp(mouse, percent);
          lastCastPose.lerp(hit.point, percent);
          castDist -= step;
          mdist -= mstep;

          performStroke({
            mesh: targetMesh,
            point: lastCastPose,
            brushObject: brush,
            params: params,
            rightClick: rightClick,
            brushOnly: false,
            accumulatedFields: sets
          });

          stepCount++;
          if (stepCount > params.maxSteps) {
            break;
          }
        }

        if (stepCount > 0) {
          updateNormals({
            mesh: targetMesh,
            triangles: changedTriangles,
            indices: changedIndices
          });
          targetMesh.geometry.boundsTree?.refit(traversedNodeIndices);

          if (bvhHelper && bvhHelper.parent !== null) {
            bvhHelper.update();
          }
        } else {
          // 움직임이 너무 작으면 단순히 브러시 위치만 갱신
          performStroke({
            mesh: targetMesh,
            point: hit.point,
            brushObject: brush,
            params: params,
            rightClick: rightClick,
            brushOnly: true
          });
        }
      }
    } else {
      controls.enabled = true;
      brush.visible = false;
      lastMouse.copy(mouse);
      lastCastPose.setScalar(Infinity);
    }
  }

  lastMouseState = mouseState;
  renderer.render(scene, camera);
  stats.end();
}


// ----------------------------------------------------------------
//                      실행(초기화 + 루프)
// ----------------------------------------------------------------
init();
render();
