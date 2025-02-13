// sculpt.js
import * as THREE from 'three';
import {
	CONTAINED,
	INTERSECTED,
	NOT_INTERSECTED,
} from 'three-mesh-bvh';

/**
 * 지정된 메쉬에 스컬팅 스트로크를 수행합니다.
 * @param {Object} options - 옵션 객체
 * @param {THREE.Mesh} options.mesh - 스컬팅할 대상 메쉬
 * @param {THREE.Vector3} options.point - 월드 공간상의 스트로크 위치
 * @param {THREE.Object3D} options.brushObject - 브러시 오브젝트 (방향 업데이트용)
 * @param {Object} options.params - 스컬팅 파라미터 (size, intensity, brush 등)
 * @param {boolean} options.rightClick - 오른쪽 마우스 클릭 여부
 * @param {boolean} [options.brushOnly=false] - true이면 브러시 방향만 갱신
 * @param {Object} [options.accumulatedFields={}] - 누적 집합 (변경된 삼각형/정점/트리 노드)
 */
export function performStroke({
	mesh,
	point,
	brushObject,
	params,
	rightClick,
	brushOnly = false,
	accumulatedFields = {}
}) {
	if (!mesh) return;

	const {
		accumulatedTriangles = new Set(),
		accumulatedIndices = new Set(),
		accumulatedTraversedNodeIndices = new Set()
	} = accumulatedFields;

	const inverseMatrix = new THREE.Matrix4();
	inverseMatrix.copy(mesh.matrixWorld).invert();

	const sphere = new THREE.Sphere();
	sphere.center.copy(point).applyMatrix4(inverseMatrix);
	sphere.radius = params.size;

	const indices = new Set();
	const tempVec = new THREE.Vector3();
	const normal = new THREE.Vector3();
	const indexAttr = mesh.geometry.index;
	const posAttr = mesh.geometry.attributes.position;
	const normalAttr = mesh.geometry.attributes.normal;
	const triangles = new Set();
	const bvh = mesh.geometry.boundsTree;

	// 기준 노멀 (Z축)
	const normalZ = new THREE.Vector3( 0, 0, 1 );

	// BVH를 이용해 구체 내부에 포함된 삼각형/정점 찾기
	bvh?.shapecast({
		intersectsBounds: ( box, isLeaf, score, depth, nodeIndex ) => {
			accumulatedTraversedNodeIndices.add( nodeIndex );
			const intersects = sphere.intersectsBox( box );
			const { min, max } = box;
			if ( intersects ) {
				for ( let x = 0; x <= 1; x ++ ) {
					for ( let y = 0; y <= 1; y ++ ) {
						for ( let z = 0; z <= 1; z ++ ) {
							tempVec.set(
								x === 0 ? min.x : max.x,
								y === 0 ? min.y : max.y,
								z === 0 ? min.z : max.z
							);
							if ( !sphere.containsPoint( tempVec ) ) {
								return INTERSECTED;
							}
						}
					}
				}
				return CONTAINED;
			}
			return intersects ? INTERSECTED : NOT_INTERSECTED;
		},
		intersectsTriangle: ( tri, index, contained ) => {
			const triIndex = index;
			triangles.add( triIndex );
			accumulatedTriangles.add( triIndex );

			const i3 = 3 * index;
			const a = i3 + 0;
			const b = i3 + 1;
			const c = i3 + 2;
			const va = indexAttr.getX( a );
			const vb = indexAttr.getX( b );
			const vc = indexAttr.getX( c );
			if ( contained ) {
				indices.add( va );
				indices.add( vb );
				indices.add( vc );
				accumulatedIndices.add( va );
				accumulatedIndices.add( vb );
				accumulatedIndices.add( vc );
			} else {
				if ( sphere.containsPoint( tri.a ) ) {
					indices.add( va );
					accumulatedIndices.add( va );
				}
				if ( sphere.containsPoint( tri.b ) ) {
					indices.add( vb );
					accumulatedIndices.add( vb );
				}
				if ( sphere.containsPoint( tri.c ) ) {
					indices.add( vc );
					accumulatedIndices.add( vc );
				}
			}
			return false;
		}
	});

	// 평균 법선을 구하고 브러시 오브젝트 방향 갱신
	const localPoint = new THREE.Vector3();
	localPoint.copy( point ).applyMatrix4( inverseMatrix );

	const planePoint = new THREE.Vector3();
	let totalPoints = 0;
	indices.forEach( index => {
		tempVec.fromBufferAttribute( normalAttr, index );
		normal.add( tempVec );
		if ( !brushOnly ) {
			totalPoints ++;
			tempVec.fromBufferAttribute( posAttr, index );
			planePoint.add( tempVec );
		}
	});
	normal.normalize();
	brushObject.quaternion.setFromUnitVectors( normalZ, normal );

	if ( totalPoints ) {
		planePoint.multiplyScalar( 1 / totalPoints );
	}

	// 브러시 방향만 갱신할 경우 여기서 종료
	if ( brushOnly ) {
		return;
	}

	const targetHeight = params.intensity * 0.0001;
	const plane = new THREE.Plane();
	plane.setFromNormalAndCoplanarPoint( normal, planePoint );

	indices.forEach( index => {
		tempVec.fromBufferAttribute( posAttr, index );
		const dist = tempVec.distanceTo( localPoint );
		const negated = params.invert !== rightClick ? -1 : 1;
		let intensity = 1.0 - ( dist / params.size );
		if ( params.brush === 'clay' ) {
			intensity = Math.pow( intensity, 3 );
			const planeDist = plane.distanceToPoint( tempVec );
			const clampedIntensity = negated * Math.min( intensity * 4, 1.0 );
			tempVec.addScaledVector(
				normal,
				clampedIntensity * targetHeight - negated * planeDist * clampedIntensity * 0.3
			);
		} else if ( params.brush === 'normal' ) {
			intensity = Math.pow( intensity, 2 );
			tempVec.addScaledVector( normal, negated * intensity * targetHeight );
		} else if ( params.brush === 'flatten' ) {
			intensity = Math.pow( intensity, 2 );
			const planeDist = plane.distanceToPoint( tempVec );
			tempVec.addScaledVector(
				normal,
				-planeDist * intensity * params.intensity * 0.01 * 0.5
			);
		}
		posAttr.setXYZ( index, tempVec.x, tempVec.y, tempVec.z );
		normalAttr.setXYZ( index, 0, 0, 0 );
	});

	if ( indices.size ) {
		posAttr.needsUpdate = true;
	}
}

/**
 * 수정된 삼각형에 기반하여 메쉬의 노멀을 업데이트합니다.
 * @param {Object} options - 옵션 객체
 * @param {THREE.Mesh} options.mesh - 대상 메쉬
 * @param {Set<number>} options.triangles - 수정된 삼각형 인덱스 집합
 * @param {Set<number>} options.indices - 업데이트할 정점 인덱스 집합
 */
export function updateNormals({ mesh, triangles, indices }) {
	if (!mesh) return;

	const tempVec = new THREE.Vector3();
	const tempVec2 = new THREE.Vector3();
	const indexAttr = mesh.geometry.index;
	const posAttr = mesh.geometry.attributes.position;
	const normalAttr = mesh.geometry.attributes.normal;
	const triangle = new THREE.Triangle();

	triangles.forEach( tri => {
		const tri3 = tri * 3;
		const i0 = tri3 + 0;
		const i1 = tri3 + 1;
		const i2 = tri3 + 2;

		const v0 = indexAttr.getX( i0 );
		const v1 = indexAttr.getX( i1 );
		const v2 = indexAttr.getX( i2 );

		triangle.a.fromBufferAttribute( posAttr, v0 );
		triangle.b.fromBufferAttribute( posAttr, v1 );
		triangle.c.fromBufferAttribute( posAttr, v2 );
		triangle.getNormal( tempVec2 );

		if ( indices.has( v0 ) ) {
			tempVec.fromBufferAttribute( normalAttr, v0 );
			tempVec.add( tempVec2 );
			normalAttr.setXYZ( v0, tempVec.x, tempVec.y, tempVec.z );
		}
		if ( indices.has( v1 ) ) {
			tempVec.fromBufferAttribute( normalAttr, v1 );
			tempVec.add( tempVec2 );
			normalAttr.setXYZ( v1, tempVec.x, tempVec.y, tempVec.z );
		}
		if ( indices.has( v2 ) ) {
			tempVec.fromBufferAttribute( normalAttr, v2 );
			tempVec.add( tempVec2 );
			normalAttr.setXYZ( v2, tempVec.x, tempVec.y, tempVec.z );
		}
	});

	// 정규화하여 노멀 업데이트
	indices.forEach( index => {
		tempVec.fromBufferAttribute( normalAttr, index );
		tempVec.normalize();
		normalAttr.setXYZ( index, tempVec.x, tempVec.y, tempVec.z );
	});

	normalAttr.needsUpdate = true;
}
