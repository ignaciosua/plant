import * as THREE from "https://unpkg.com/three@0.160.1/build/three.module.js";
import { OrbitControls } from "https://unpkg.com/three@0.160.1/examples/jsm/controls/OrbitControls.js";
import { AmmoPhysicsEngine } from "./physics.js";

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const TAU = Math.PI * 2;
const CYLINDER_BASE_RADIUS = 1;
const CYLINDER_TOP_RADIUS = 0.78;
const CYLINDER_TAPER = CYLINDER_TOP_RADIUS / CYLINDER_BASE_RADIUS;
const LEAF_TINT_FRESH = new THREE.Color(0x3e9c4f);
const LEAF_TINT_YELLOW = new THREE.Color(0xd0b25d);
const LEAF_TINT_BROWN = new THREE.Color(0x6d4a2b);
const LEAF_EMISSIVE_FRESH = new THREE.Color(0x0f2716);
const LEAF_EMISSIVE_DRY = new THREE.Color(0x2f1e10);

function sampleGroundHeightAt(x, z) {
  const dist = Math.sqrt(x * x + z * z);
  const baseWaves =
    Math.sin(x * 0.42) * 0.12 +
    Math.cos(z * 0.36) * 0.08 +
    Math.sin((x + z) * 0.92) * 0.05;
  const mound = Math.max(0, 1 - dist / 12.5) * 0.3;
  const h = baseWaves * 0.42 + mound;
  return h - 0.28;
}

function sampleSoilHeightAt(x, z) {
  const radial = Math.sqrt(x * x + z * z);
  if (radial >= 0.88) {
    return -Infinity;
  }

  const bump = Math.sin(x * 18) * Math.cos(z * 16) * 0.008;
  if (radial <= 0.58) {
    const centerBlend = THREE.MathUtils.clamp(1 - radial / 0.58, 0, 1);
    return 0.316 + centerBlend * 0.044 + bump;
  }

  const sideBlend = THREE.MathUtils.clamp((radial - 0.58) / 0.3, 0, 1);
  return 0.29 * (1 - sideBlend) + 0.02 * sideBlend + bump * 0.5;
}

function sampleSurfaceHeightAt(x, z) {
  return Math.max(sampleGroundHeightAt(x, z), sampleSoilHeightAt(x, z));
}

const canvas = document.getElementById("sim");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.physicallyCorrectLights = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xaec8b2, 9, 26);

const camera = new THREE.PerspectiveCamera(
  43,
  window.innerWidth / window.innerHeight,
  0.1,
  80,
);
camera.position.set(3.2, 2.3, 4.1);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.45, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 1.7;
controls.maxDistance = 10.5;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minPolarAngle = Math.PI * 0.14;

const hemiLight = new THREE.HemisphereLight(0xd9f4ff, 0x64513c, 1.2);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight(0xfff2d6, 2.6);
keyLight.position.set(5.8, 8.4, 3.4);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = -6;
keyLight.shadow.camera.right = 6;
keyLight.shadow.camera.top = 6;
keyLight.shadow.camera.bottom = -6;
keyLight.shadow.camera.near = 0.1;
keyLight.shadow.camera.far = 24;
keyLight.shadow.bias = -0.0002;
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xc2ebff, 0.72);
rimLight.position.set(-5.5, 4.6, -3.4);
scene.add(rimLight);

const fillLight = new THREE.DirectionalLight(0xc8dcff, 0.46);
fillLight.position.set(-2.5, 3.4, 4.8);
scene.add(fillLight);

function createSkyDome() {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(50, 48, 24),
    new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x8ec4ff) },
        horizonColor: { value: new THREE.Color(0xf5f4db) },
        bottomColor: { value: new THREE.Color(0x8cb08c) },
        exponent: { value: 0.95 },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 bottomColor;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition).y * 0.5 + 0.5;
          float topMix = pow(clamp(h, 0.0, 1.0), exponent);
          float bottomMix = pow(1.0 - h, 1.5);
          vec3 sky = mix(horizonColor, topColor, topMix);
          vec3 color = mix(sky, bottomColor, bottomMix * 0.38);
          gl_FragColor = vec4(color, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  scene.add(sky);
}

function createGround() {
  const geometry = new THREE.PlaneGeometry(28, 28, 240, 240);
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const color = new THREE.Color();

  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const dist = Math.sqrt(x * x + y * y);
    const baseWaves =
      Math.sin(x * 0.42) * 0.12 +
      Math.cos(y * 0.36) * 0.08 +
      Math.sin((x + y) * 0.92) * 0.05;
    const mound = Math.max(0, 1 - dist / 12.5) * 0.3;
    const h = baseWaves * 0.42 + mound;
    pos.setZ(i, h - 0.28);

    const hue = 0.27 + (h * 0.02) + (Math.sin(x * 1.8 + y * 1.2) * 0.0035);
    const sat = 0.24 + Math.max(0, 0.06 - dist * 0.004);
    const light = 0.31 + h * 0.15 - dist * 0.0055;
    color.setHSL(hue, THREE.MathUtils.clamp(sat, 0.18, 0.36), THREE.MathUtils.clamp(light, 0.2, 0.44));

    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.rotateX(-Math.PI / 2);
  geometry.computeVertexNormals();

  const groundMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });

  const ground = new THREE.Mesh(geometry, groundMaterial);
  ground.receiveShadow = true;
  scene.add(ground);

  const soilGeometry = new THREE.CylinderGeometry(0.55, 0.86, 0.34, 52, 5, false);
  const soilPos = soilGeometry.attributes.position;
  for (let i = 0; i < soilPos.count; i += 1) {
    const vx = soilPos.getX(i);
    const vy = soilPos.getY(i);
    const vz = soilPos.getZ(i);
    const radial = Math.sqrt(vx * vx + vz * vz);
    const bump = Math.sin(vx * 18) * Math.cos(vz * 16) * 0.008;
    if (vy > 0.02) {
      soilPos.setY(i, vy + Math.max(0, 0.07 - radial * 0.08) + bump);
    } else {
      soilPos.setY(i, vy + bump * 0.7);
    }
  }
  soilGeometry.computeVertexNormals();

  const soil = new THREE.Mesh(
    soilGeometry,
    new THREE.MeshStandardMaterial({
      color: 0x5b4738,
      roughness: 1,
      metalness: 0,
    }),
  );
  soil.position.set(0, 0.12, 0);
  soil.castShadow = true;
  soil.receiveShadow = true;
  scene.add(soil);

  const pebbleGeometry = new THREE.IcosahedronGeometry(0.05, 0);
  const pebbleMaterial = new THREE.MeshStandardMaterial({
    color: 0x8e8f81,
    roughness: 0.95,
    metalness: 0,
  });
  const pebbles = new THREE.InstancedMesh(pebbleGeometry, pebbleMaterial, 26);
  const pebbleColliders = [];
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const posVec = new THREE.Vector3();

  for (let i = 0; i < 26; i += 1) {
    const angle = (i / 26) * TAU + Math.random() * 0.3;
    const radius = 0.55 + Math.random() * 0.55;
    posVec.set(Math.cos(angle) * radius, 0.05 + Math.random() * 0.02, Math.sin(angle) * radius);
    quat.setFromEuler(new THREE.Euler(Math.random(), Math.random(), Math.random()));
    const s = 0.55 + Math.random() * 0.85;
    scale.set(s, s * (0.6 + Math.random() * 0.5), s);
    matrix.compose(posVec, quat, scale);
    pebbles.setMatrixAt(i, matrix);

    const baseRadius = 0.05;
    pebbleColliders.push({
      type: "box",
      center: {
        x: posVec.x,
        y: posVec.y,
        z: posVec.z,
      },
      halfExtents: {
        x: baseRadius * scale.x,
        y: baseRadius * scale.y,
        z: baseRadius * scale.z,
      },
      quaternion: {
        x: quat.x,
        y: quat.y,
        z: quat.z,
        w: quat.w,
      },
      friction: 0.94,
      restitution: 0.02,
    });
  }
  pebbles.castShadow = true;
  pebbles.receiveShadow = true;
  scene.add(pebbles);

  return {
    pebbleColliders,
  };
}

function createAtmosphereParticles() {
  const count = 280;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * 12;
    positions[i * 3 + 1] = 0.4 + Math.random() * 5.2;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 12;
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0xfbf4de,
    size: 0.03,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  scene.add(points);
  return points;
}

createSkyDome();
const groundData = createGround();
const staticPebbleColliders =
  groundData && Array.isArray(groundData.pebbleColliders)
    ? groundData.pebbleColliders
    : [];
const atmosphereParticles = createAtmosphereParticles();

class PhysicsDebugOverlay {
  constructor(sceneRef) {
    this.scene = sceneRef;
    this.enabled = false;
    this.group = new THREE.Group();
    this.group.name = "physics-debug";
    this.group.visible = false;
    this.scene.add(this.group);

    this.boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
    this.sphereGeometry = new THREE.SphereGeometry(1, 12, 10);
    this.leafGeometry = createLeafGeometry();

    this.staticBoxMaterial = new THREE.MeshBasicMaterial({
      color: 0xff5f5f,
      wireframe: true,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    this.staticCylinderMaterial = new THREE.MeshBasicMaterial({
      color: 0xff9c4f,
      wireframe: true,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
    });
    this.staticSurfaceMaterial = new THREE.MeshBasicMaterial({
      color: 0xff8b6f,
      wireframe: true,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    });
    this.plantMaterial = new THREE.MeshBasicMaterial({
      color: 0x4ec6ff,
      wireframe: true,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    this.dynamicLeafMaterial = new THREE.MeshBasicMaterial({
      color: 0x5ff285,
      wireframe: true,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    this.dynamicBoxMaterial = new THREE.MeshBasicMaterial({
      color: 0x93e272,
      wireframe: true,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });
    this.dynamicSphereMaterial = new THREE.MeshBasicMaterial({
      color: 0x6fe7a9,
      wireframe: true,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });

    this.staticGroup = null;
    this.staticColliderCount = -1;
    this.plantSphereLayer = null;
    this.plantCylinderLayer = null;
    this.dynamicLeafLayer = null;
    this.dynamicBoxLayer = null;
    this.dynamicSphereLayer = null;

    this.tmpMatrix = new THREE.Matrix4();
    this.tmpQuat = new THREE.Quaternion();
    this.tmpPos = new THREE.Vector3();
    this.tmpScale = new THREE.Vector3();
    this.tmpOffset = new THREE.Vector3();
  }

  setEnabled(nextEnabled) {
    this.enabled = Boolean(nextEnabled);
    this.group.visible = this.enabled;
    if (!this.enabled) {
      this._syncInstancedLayer("plantSphereLayer", [], this.sphereGeometry, this.plantMaterial);
      this._syncInstancedLayer("plantCylinderLayer", [], this.cylinderGeometry, this.plantMaterial, true);
      this._syncInstancedLayer("dynamicLeafLayer", [], this.leafGeometry, this.dynamicLeafMaterial, true);
      this._syncInstancedLayer("dynamicBoxLayer", [], this.boxGeometry, this.dynamicBoxMaterial, true);
      this._syncInstancedLayer("dynamicSphereLayer", [], this.sphereGeometry, this.dynamicSphereMaterial);
    }
  }

  _disposeInstanced(layer) {
    if (!layer) {
      return;
    }
    this.group.remove(layer.mesh);
    layer.mesh.dispose();
  }

  _rebuildStatic(staticColliders) {
    if (this.staticGroup) {
      this.group.remove(this.staticGroup);
      this.staticGroup.traverse((obj) => {
        if (obj.isInstancedMesh && typeof obj.dispose === "function") {
          obj.dispose();
        } else if (obj.isMesh && obj.geometry) {
          obj.geometry.dispose();
        }
      });
    }

    const staticGroup = new THREE.Group();
    staticGroup.name = "physics-static-colliders";

    const boxes = [];
    const cylinders = [];
    const heightfields = [];
    for (let i = 0; i < staticColliders.length; i += 1) {
      const collider = staticColliders[i];
      if (collider.type === "box") {
        boxes.push(collider);
      } else if (collider.type === "cylinder") {
        cylinders.push(collider);
      } else if (collider.type === "heightfield") {
        heightfields.push(collider);
      }
    }

    if (boxes.length > 0) {
      const mesh = new THREE.InstancedMesh(
        this.boxGeometry,
        this.staticBoxMaterial,
        boxes.length,
      );
      mesh.frustumCulled = false;
      for (let i = 0; i < boxes.length; i += 1) {
        const collider = boxes[i];
        this.tmpPos.set(
          collider.center.x,
          collider.center.y,
          collider.center.z,
        );
        if (collider.quaternion) {
          this.tmpQuat.set(
            collider.quaternion.x,
            collider.quaternion.y,
            collider.quaternion.z,
            collider.quaternion.w,
          );
        } else {
          this.tmpQuat.identity();
        }
        this.tmpScale.set(
          collider.halfExtents.x * 2,
          collider.halfExtents.y * 2,
          collider.halfExtents.z * 2,
        );
        this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
        mesh.setMatrixAt(i, this.tmpMatrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      staticGroup.add(mesh);
    }

    if (cylinders.length > 0) {
      const mesh = new THREE.InstancedMesh(
        this.cylinderGeometry,
        this.staticCylinderMaterial,
        cylinders.length,
      );
      mesh.frustumCulled = false;
      for (let i = 0; i < cylinders.length; i += 1) {
        const collider = cylinders[i];
        this.tmpPos.set(
          collider.center.x,
          collider.center.y,
          collider.center.z,
        );
        this.tmpScale.set(
          collider.radius * 2,
          collider.height,
          collider.radius * 2,
        );
        this.tmpMatrix.compose(this.tmpPos, this.tmpQuat.identity(), this.tmpScale);
        mesh.setMatrixAt(i, this.tmpMatrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      staticGroup.add(mesh);
    }

    for (let i = 0; i < heightfields.length; i += 1) {
      const collider = heightfields[i];
      const resolution = Math.max(2, Math.floor(collider.resolution || 2));
      const size = Math.max(0.1, Number(collider.size) || 14);
      const heights = collider.heights || [];
      const geometry = new THREE.PlaneGeometry(size, size, resolution, resolution);
      const positions = geometry.attributes.position;
      const expected = (resolution + 1) * (resolution + 1);
      for (let v = 0; v < positions.count; v += 1) {
        const h = v < expected ? Number(heights[v] || 0) : 0;
        positions.setZ(v, h);
      }
      geometry.rotateX(-Math.PI / 2);
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, this.staticSurfaceMaterial);
      mesh.frustumCulled = false;
      staticGroup.add(mesh);
    }

    this.group.add(staticGroup);
    this.staticGroup = staticGroup;
    this.staticColliderCount = staticColliders.length;
  }

  _syncInstancedLayer(layerKey, colliders, geometry, material, oriented = false) {
    const current = this[layerKey];
    if (colliders.length === 0) {
      if (current) {
        this._disposeInstanced(current);
        this[layerKey] = null;
      }
      return;
    }

    let mesh = current ? current.mesh : null;
    if (!mesh || mesh.count !== colliders.length) {
      if (current) {
        this._disposeInstanced(current);
      }
      mesh = new THREE.InstancedMesh(
        geometry,
        material,
        colliders.length,
      );
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this[layerKey] = { mesh };
    }

    for (let i = 0; i < colliders.length; i += 1) {
      const collider = colliders[i];
      this.tmpPos.set(collider.x, collider.y, collider.z);
      if (oriented) {
        if (collider.quaternion) {
          this.tmpQuat.set(
            collider.quaternion.x,
            collider.quaternion.y,
            collider.quaternion.z,
            collider.quaternion.w,
          );
        } else {
          this.tmpQuat.identity();
        }
        if (collider.scale) {
          this.tmpScale.set(collider.scale.x, collider.scale.y, collider.scale.z);
        } else {
          const d = collider.radius * 2;
          this.tmpScale.set(d, d, d);
        }

        if (collider.offset) {
          this.tmpOffset.set(collider.offset.x, collider.offset.y, collider.offset.z);
          this.tmpOffset.applyQuaternion(this.tmpQuat);
          this.tmpPos.add(this.tmpOffset);
        }
      } else {
        this.tmpQuat.identity();
        const d = collider.radius * 2;
        this.tmpScale.set(d, d, d);
      }
      this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      mesh.setMatrixAt(i, this.tmpMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  update(physicsEngine) {
    if (!this.enabled) {
      return;
    }
    if (!physicsEngine || !physicsEngine.ready) {
      this._syncInstancedLayer("plantSphereLayer", [], this.sphereGeometry, this.plantMaterial);
      this._syncInstancedLayer("plantCylinderLayer", [], this.cylinderGeometry, this.plantMaterial, true);
      this._syncInstancedLayer("dynamicLeafLayer", [], this.leafGeometry, this.dynamicLeafMaterial, true);
      this._syncInstancedLayer("dynamicBoxLayer", [], this.boxGeometry, this.dynamicBoxMaterial, true);
      this._syncInstancedLayer("dynamicSphereLayer", [], this.sphereGeometry, this.dynamicSphereMaterial);
      return;
    }

    const state = physicsEngine.getDebugState();
    if (!state) {
      return;
    }

    if (
      !this.staticGroup ||
      this.staticColliderCount !== state.static.length
    ) {
      this._rebuildStatic(state.static);
    }

    const plantSpheres = [];
    const plantCylinders = [];
    for (let i = 0; i < state.plant.length; i += 1) {
      const collider = state.plant[i];
      if (collider.type === "cylinder") {
        plantCylinders.push(collider);
      } else {
        plantSpheres.push(collider);
      }
    }

    const dynamicLeaves = [];
    const dynamicBoxes = [];
    const dynamicSpheres = [];
    for (let i = 0; i < state.dynamic.length; i += 1) {
      const collider = state.dynamic[i];
      if (collider.kind === "leaf") {
        dynamicLeaves.push(collider);
      } else if (collider.kind === "box") {
        dynamicBoxes.push(collider);
      } else {
        dynamicSpheres.push(collider);
      }
    }

    this._syncInstancedLayer("plantSphereLayer", plantSpheres, this.sphereGeometry, this.plantMaterial);
    this._syncInstancedLayer("plantCylinderLayer", plantCylinders, this.cylinderGeometry, this.plantMaterial, true);
    this._syncInstancedLayer("dynamicLeafLayer", dynamicLeaves, this.leafGeometry, this.dynamicLeafMaterial, true);
    this._syncInstancedLayer("dynamicBoxLayer", dynamicBoxes, this.boxGeometry, this.dynamicBoxMaterial, true);
    this._syncInstancedLayer("dynamicSphereLayer", dynamicSpheres, this.sphereGeometry, this.dynamicSphereMaterial);
  }

  dispose() {
    if (this.staticGroup) {
      this.group.remove(this.staticGroup);
      this.staticGroup.traverse((obj) => {
        if (obj.isInstancedMesh && typeof obj.dispose === "function") {
          obj.dispose();
        } else if (obj.isMesh && obj.geometry) {
          obj.geometry.dispose();
        }
      });
      this.staticGroup = null;
    }
    this._syncInstancedLayer("plantSphereLayer", [], this.sphereGeometry, this.plantMaterial);
    this._syncInstancedLayer("plantCylinderLayer", [], this.cylinderGeometry, this.plantMaterial, true);
    this._syncInstancedLayer("dynamicLeafLayer", [], this.leafGeometry, this.dynamicLeafMaterial, true);
    this._syncInstancedLayer("dynamicBoxLayer", [], this.boxGeometry, this.dynamicBoxMaterial, true);
    this._syncInstancedLayer("dynamicSphereLayer", [], this.sphereGeometry, this.dynamicSphereMaterial);
    this.boxGeometry.dispose();
    this.cylinderGeometry.dispose();
    this.sphereGeometry.dispose();
    this.leafGeometry.dispose();
    this.staticBoxMaterial.dispose();
    this.staticCylinderMaterial.dispose();
    this.staticSurfaceMaterial.dispose();
    this.plantMaterial.dispose();
    this.dynamicLeafMaterial.dispose();
    this.dynamicBoxMaterial.dispose();
    this.dynamicSphereMaterial.dispose();
    this.scene.remove(this.group);
  }
}

const physicsDebugOverlay = new PhysicsDebugOverlay(scene);

function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smooth01(value) {
  const v = THREE.MathUtils.clamp(value, 0, 1);
  return v * v * (3 - 2 * v);
}

function createLeafGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(0.19, 0.1, 0.3, 0.52, 0.08, 0.94);
  shape.bezierCurveTo(0.03, 1.02, -0.03, 1.02, -0.08, 0.94);
  shape.bezierCurveTo(-0.3, 0.52, -0.19, 0.1, 0, 0);

  const geometry = new THREE.ShapeGeometry(shape, 28);
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const color = new THREE.Color();
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const bend = Math.sin(y * Math.PI) * 0.06;
    const cup = -Math.abs(x) * 0.09;
    pos.setZ(i, bend + cup);

    const normY = THREE.MathUtils.clamp(y, 0, 1);
    const edgeShadow = Math.abs(x) * 0.55;
    color.setHSL(
      0.34 - normY * 0.015,
      0.52 + normY * 0.16,
      0.21 + normY * 0.2 - edgeShadow * 0.08,
    );
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

class PlantSimulator {
  constructor(sceneRef, settings) {
    this.scene = sceneRef;
    this.settings = settings;
    this.rng = seededRandom(settings.seed);
    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.segments = [];
    this.leaves = [];
    this.anchorLeafRegistry = new Map();
    this.anchorLeafCount = new Map();
    this.anchorLeafSectorCount = new Map();
    this.leafSpatialDensity = new Map();
    this.seedLeavesCreated = false;
    this.maxLeafBudget = 500;
    this.structureScale = 1 + Math.max(0, this.settings.maxDepth - 4) * 0.09;
    this.leafCellSize = 0.42 + this.structureScale * 0.17;
    this.maxLeavesPerCellBase = 4 + Math.round(this.settings.leafDensity * 1.7);
    this.segmentBudget = Math.round(760 + this.settings.maxDepth * 115);
    this.segmentCount = 0;
    this.lastUpdateTime = null;
    this.physics = settings.physics || null;

    this.segmentGeometry = new THREE.CylinderGeometry(
      CYLINDER_TOP_RADIUS,
      CYLINDER_BASE_RADIUS,
      1,
      18,
      1,
      false,
    );
    this.segmentGeometry.translate(0, 0.5, 0);

    const stemPos = this.segmentGeometry.attributes.position;
    const stemColors = new Float32Array(stemPos.count * 3);
    const stemColor = new THREE.Color();
    for (let i = 0; i < stemPos.count; i += 1) {
      const x = stemPos.getX(i);
      const y = stemPos.getY(i);
      const z = stemPos.getZ(i);
      const radial = Math.sqrt(x * x + z * z);
      const heightTone = THREE.MathUtils.clamp(y, 0, 1);
      stemColor.setHSL(
        0.28 + (this.rng() - 0.5) * 0.015,
        0.28 + this.rng() * 0.1,
        0.2 + heightTone * 0.15 - radial * 0.04 + this.rng() * 0.04,
      );
      stemColors[i * 3] = stemColor.r;
      stemColors[i * 3 + 1] = stemColor.g;
      stemColors[i * 3 + 2] = stemColor.b;
    }
    this.segmentGeometry.setAttribute("color", new THREE.BufferAttribute(stemColors, 3));

    this.leafGeometry = createLeafGeometry();

    this.stemMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.84,
      metalness: 0.02,
      clearcoat: 0.16,
      clearcoatRoughness: 0.78,
      vertexColors: true,
    });

    this.leafMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.61,
      metalness: 0.01,
      clearcoat: 0.08,
      clearcoatRoughness: 0.82,
      transmission: 0.06,
      thickness: 0.2,
      side: THREE.DoubleSide,
      emissive: 0x102214,
      emissiveIntensity: 0.06,
      vertexColors: false,
      opacity: 0.96,
      transparent: true,
    });

    const trunkLength = (2.8 + this.rng() * 1) * this.structureScale;
    const trunkRadius =
      (0.18 + this.rng() * 0.05) * (0.95 + this.structureScale * 0.2);
    const trunkDirection = UP.clone();

    this.buildBranch(
      new THREE.Vector3(0, 0.22, 0),
      trunkDirection,
      trunkLength,
      trunkRadius,
      0,
      0.015,
      0.9,
    );
  }

  buildBranch(origin, direction, length, radius, depth, birthStart, growthSpan, anchorSegment = null) {
    if (
      depth > this.settings.maxDepth ||
      this.segmentCount >= this.segmentBudget ||
      radius < 0.007 ||
      length < 0.12
    ) {
      // Rama rechazada: poner hoja directa en el punto de origen si depth > 0
      if (depth > 0) {
        const tipDir = direction.clone().addScaledVector(UP, 0.3).normalize();
        // Nace temprano para estar visible cuando la rama padre se forma
        const leafBirth = anchorSegment ? anchorSegment.birth + 0.02 : birthStart;
        this.createLeaf(
          origin.clone(), tipDir, depth, leafBirth,
          anchorSegment, origin, tipDir, 0, 0, 0, false, 1, true,
        );
      }
      return;
    }

    const segments = Math.max(
      5,
      Math.round(
        (9.6 + this.structureScale * 1.5 - depth * 0.58) +
          this.rng() * 3.8,
      ),
    );

    let currentPosition = origin.clone();
    let currentDirection = direction.clone().normalize();
    let spawnedChildren = 0;
    const branchTrace = [];
    const minChildren =
      depth === 0 ? 5 : depth === 1 ? 4 : depth === 2 ? 2 : depth === 3 ? 1 : 0;
    let previousSegment = null;
    
    let currentRadius = radius;

    for (let i = 0; i < segments; i += 1) {
      if (this.segmentCount >= this.segmentBudget) {
        break;
      }

      if (depth === 0) {
        // Curvatura suave del tronco principal: mantiene tendencia vertical
        // pero permite una desviación progresiva natural.
        const trunkBendAxis = new THREE.Vector3(this.rng() - 0.5, 0, this.rng() - 0.5);
        if (trunkBendAxis.lengthSq() > 0.0001) {
          trunkBendAxis.normalize();
          currentDirection.applyAxisAngle(
            trunkBendAxis,
            (this.rng() - 0.5) * 0.055,
          );
        }

        currentDirection.y += (this.rng() - 0.47) * 0.012;
        currentDirection.y = Math.max(currentDirection.y, 0.93);
        currentDirection.normalize();
      } else {
        const bendAxis = new THREE.Vector3(this.rng() - 0.5, 0, this.rng() - 0.5);
        if (bendAxis.lengthSq() > 0.0001) {
          bendAxis.normalize();
          currentDirection.applyAxisAngle(
            bendAxis,
            (this.rng() - 0.5) * (0.11 + depth * 0.045),
          );
        }

        currentDirection.y += (this.rng() - 0.48) * (0.05 + depth * 0.006);
        currentDirection.y = Math.max(currentDirection.y, -0.07 + depth * 0.035);
        currentDirection.normalize();
      }

      const segmentLength = (length / segments) * (0.92 + this.rng() * 0.18);
      const nextPosition = currentPosition
        .clone()
        .addScaledVector(currentDirection, segmentLength);
      
      // Mantener taper exacto entre segmentos para continuidad geométrica.
      if (currentRadius < 0.007) {
        break;
      }
      const segmentRadius = currentRadius;
      currentRadius = segmentRadius * CYLINDER_TAPER;
      const birth = birthStart + (i / segments) * growthSpan;
      const duration = 0.11 + depth * 0.03 + this.rng() * 0.035;

      const parentSegment = previousSegment || anchorSegment;
      const currentSegment = this.createSegment(
        currentPosition,
        currentDirection,
        segmentLength,
        segmentRadius,
        depth,
        birth,
        duration,
        parentSegment,
      );
      this.segmentCount += 1;

      // Garantiza un par de hojas juveniles en etapa temprana.
      if (depth === 0 && !this.seedLeavesCreated && i >= 1) {
        this.createLeafCluster(
          currentSegment,
          nextPosition,
          currentDirection,
          depth,
          0.035,
          2,
          true,
          0.95,
        );
        this.seedLeavesCreated = true;
      }

      branchTrace.push({
        position: nextPosition.clone(),
        direction: currentDirection.clone(),
        radius: segmentRadius,
        birth,
        segment: currentSegment,
      });
      previousSegment = currentSegment;

      const depthRatio = depth / Math.max(1, this.settings.maxDepth);
      const tipProgress = i / Math.max(1, segments - 1);
      // Distribución más uniforme: base 0.3 + ramp suave hacia la punta
      const tipWeight = 0.3 + 0.7 * Math.pow(
        smooth01((tipProgress - 0.1) / 0.9),
        0.7,
      );
      const outerDepthWeight = THREE.MathUtils.clamp(
        0.25 + depthRatio * 0.85,
        0,
        1,
      );
      const trunkPenalty = depth === 0 ? 0.08 : depth === 1 ? 0.6 : 1;
      const leafChance = THREE.MathUtils.clamp(
        this.settings.leafDensity *
          (0.35 + outerDepthWeight * 0.85) *
          tipWeight *
          trunkPenalty,
        0,
        0.995,
      );

      if (i > 0 && this.rng() < leafChance) {
        const clusterSize = Math.max(
          1,
          Math.round(
            1 + depthRatio * 2.6 + tipWeight * 2.4 + this.rng() * 1.6,
          ),
        );
        const clusterPriority = THREE.MathUtils.clamp(
          depthRatio * 0.55 + tipWeight * 0.78,
          0,
          1,
        );
        this.createLeafCluster(
          currentSegment,
          nextPosition,
          currentDirection,
          depth,
          birth,
          clusterSize,
          false,
          clusterPriority,
        );
      }

      const canBranch =
        depth < this.settings.maxDepth &&
        i > 0 &&
        i < segments - 1 &&
        this.segmentCount < this.segmentBudget - 5;
      if (canBranch) {
        const branchChance = THREE.MathUtils.clamp(
          this.settings.branching * (1.18 - depth * 0.05),
          0.12,
          0.995,
        );

        const burstByDepth = depth === 0 ? 2 : depth <= 2 ? 1 : 0;
        const burstByBranching = this.settings.branching > 0.74 ? 1 : 0;
        const branchAttempts = 1 + burstByDepth + burstByBranching;

        for (let attempt = 0; attempt < branchAttempts; attempt += 1) {
          if (this.segmentCount >= this.segmentBudget - 4) {
            break;
          }

          const attemptChance = branchChance * (attempt === 0 ? 1 : 0.68 / attempt);
          if (this.rng() < attemptChance) {
            this.spawnChildBranch(
              nextPosition,
              currentDirection,
              segmentRadius,
              length,
              depth,
              birth,
              growthSpan,
              currentSegment,
            );
            spawnedChildren += 1;

            // Evita estallidos extremos manteniendo aún alta ramificación.
            if (this.rng() > 0.56 + this.settings.branching * 0.18) {
              break;
            }
          }
        }
      }

      currentPosition = nextPosition;
    }

    while (
      spawnedChildren < minChildren &&
      branchTrace.length > 2 &&
      this.segmentCount < this.segmentBudget - 10
    ) {
      const t =
        0.32 +
        (spawnedChildren / Math.max(1, minChildren)) * 0.38 +
        this.rng() * 0.12;
      const idx = THREE.MathUtils.clamp(
        Math.floor(branchTrace.length * t),
        1,
        branchTrace.length - 2,
      );
      const fallback = branchTrace[idx];
      this.spawnChildBranch(
        fallback.position,
        fallback.direction,
        fallback.radius,
        length * (0.94 + this.rng() * 0.28),
        depth,
        fallback.birth,
        growthSpan * (0.74 + this.rng() * 0.22),
        fallback.segment || null,
      );
      spawnedChildren += 1;
    }

    const depthRatio = depth / Math.max(1, this.settings.maxDepth);
    // Todas las ramas (depth >= 1) obtienen hojas en su punta
    if (depth >= 1 && previousSegment) {
      // Hoja de punta nace cuando la rama empieza, con duración larga 
      // para que crezca junto con la rama completa
      const tipLeafBirth = birthStart + growthSpan * 0.15;
      const tipLeafDurationOverride = growthSpan * 0.7;

      // FORZAR hoja directa en la punta — sin filtros, sin cluster, sin límites
      const tipDir = currentDirection
        .clone()
        .addScaledVector(UP, 0.3)
        .normalize();
      this.createLeaf(
        currentPosition.clone(),
        tipDir,
        depth,
        tipLeafBirth,
        previousSegment,
        currentPosition,
        tipDir,
        0,
        0,
        0,
        false,
        1,
        true, // force = true, salta presupuesto
      );

      // Cluster adicional en la punta
      const tipDirection = currentDirection
        .clone()
        .addScaledVector(UP, 0.2 + this.rng() * 0.12)
        .normalize();
      const tipClusterSize = Math.round(2 + depthRatio * 3 + this.rng() * 2);
      this.createLeafCluster(
        previousSegment,
        currentPosition,
        tipDirection,
        depth,
        tipLeafBirth,
        tipClusterSize,
        false,
        1,
        true,
      );
    }
  }

  spawnChildBranch(start, direction, parentRadius, parentLength, depth, birth, growthSpan, anchorSegment = null) {
    const childDirection = direction.clone();
    const yaw = (this.rng() < 0.5 ? -1 : 1) * (0.65 + this.rng() * 1.15);
    childDirection.applyAxisAngle(UP, yaw);
    const pitchAxis = new THREE.Vector3().crossVectors(childDirection, UP);
    if (pitchAxis.lengthSq() > 0.0001) {
      pitchAxis.normalize();
      childDirection.applyAxisAngle(
        pitchAxis,
        -(0.28 + this.rng() * 0.62),
      );
    }
    childDirection.y += 0.02 + this.rng() * 0.2;
    childDirection.normalize();

    this.buildBranch(
      start.clone(),
      childDirection,
      parentLength * (0.48 + this.rng() * 0.34),
      parentRadius * (0.66 + this.rng() * 0.16),
      depth + 1,
      birth + 0.045,
      growthSpan * (0.56 + this.rng() * 0.26),
      anchorSegment,
    );
  }

  getLeafCellCoords(position) {
    const size = Math.max(0.08, this.leafCellSize);
    const x = Math.floor(position.x / size);
    const y = Math.floor(position.y / (size * 1.1));
    const z = Math.floor(position.z / size);
    return { x, y, z };
  }

  getLeafCellCount(x, y, z) {
    return this.leafSpatialDensity.get(`${x},${y},${z}`) || 0;
  }

  canPlaceLeafAt(position, depth, priority = 0.5) {
    const p = THREE.MathUtils.clamp(priority, 0, 1);
    const coords = this.getLeafCellCoords(position);
    const maxLeavesInCell = Math.max(
      4,
      Math.floor((this.maxLeavesPerCellBase + depth * 1.2) * (0.9 + p * 0.5)),
    );
    const ownCellCount = this.getLeafCellCount(coords.x, coords.y, coords.z);
    if (ownCellCount >= maxLeavesInCell) {
      return false;
    }

    let neighborhoodLoad = 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const distance = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          const weight = distance === 0 ? 1 : distance === 1 ? 0.3 : 0.12;
          neighborhoodLoad +=
            this.getLeafCellCount(coords.x + dx, coords.y + dy, coords.z + dz) *
            weight;
        }
      }
    }

    const neighborhoodLimit =
      (maxLeavesInCell * 4.0 + depth * 2.5) * (0.9 + p * 0.4);
    if (neighborhoodLoad >= neighborhoodLimit) {
      return false;
    }

    return true;
  }

  registerLeafAt(position) {
    const coords = this.getLeafCellCoords(position);
    const key = `${coords.x},${coords.y},${coords.z}`;
    const current = this.leafSpatialDensity.get(key) || 0;
    this.leafSpatialDensity.set(key, current + 1);
  }

  /**
   * When a new leaf is placed, check all existing leaves for proximity.
   * Any old leaf within the collision radius is forced to detach and fall.
   * Uses local (group-space) positions since matrixWorld may not be updated during construction.
   * Only collides leaves from DIFFERENT anchor segments (same-cluster overlap is expected).
   */
  triggerCollisionFalls(newPosition, newAnchorSegment) {
    const COLLISION_RADIUS = 0.06; // local-space distance threshold
    const COLLISION_RADIUS_SQ = COLLISION_RADIUS * COLLISION_RADIUS;

    for (let i = 0; i < this.leaves.length; i += 1) {
      const leaf = this.leaves[i];
      // Skip leaves already falling/detaching or on ground
      if (leaf.collisionForceDetach || leaf.isDetaching) continue;

      // Skip leaves on the SAME anchor segment (they're part of the same cluster)
      if (newAnchorSegment && leaf.anchorSegment === newAnchorSegment) continue;

      // Use local position (pivot.position) — both are in the same group-local space.
      // matrixWorld is NOT valid during construction (stale identity matrix).
      const distSq = leaf.pivot.position.distanceToSquared(newPosition);

      if (distSq < COLLISION_RADIUS_SQ && distSq > 0.00001) {
        leaf.collisionForceDetach = true;
        leaf.isDetaching = true;
      }
    }
  }

  /**
   * Runtime collision check: called each frame to detect overlapping visible leaves.
   * When two visible (non-hidden, non-falling) leaves from different anchors overlap,
   * the older one is forced to fall.
   */
  checkRuntimeCollisions() {
    const COLLISION_RADIUS = 0.06;
    const COLLISION_RADIUS_SQ = COLLISION_RADIUS * COLLISION_RADIUS;

    for (let i = 0; i < this.leaves.length; i += 1) {
      const a = this.leaves[i];
      if (a.collisionForceDetach || a.isDetaching) continue;
      if (a.mesh.scale.x < 0.01) continue;

      for (let j = i + 1; j < this.leaves.length; j += 1) {
        const b = this.leaves[j];
        if (b.collisionForceDetach || b.isDetaching) continue;
        if (b.mesh.scale.x < 0.01) continue;

        if (a.anchorSegment && a.anchorSegment === b.anchorSegment) continue;

        const distSq = a.pivot.position.distanceToSquared(b.pivot.position);
        if (distSq < COLLISION_RADIUS_SQ && distSq > 0.00001) {
          a.collisionForceDetach = true;
          a.isDetaching = true;
          break;
        }
      }
    }
  }

  /**
   * For remaining visible leaves that are near neighbors (but not close enough
   * to trigger full collision pruning), compute a shrink factor so they don't
   * visually overlap. The closer two leaves are, the more both get shrunk.
   */
  computeCollisionShrink() {
    const SHRINK_RADIUS = 0.12;  // proximity range where shrinking kicks in
    const SHRINK_RADIUS_SQ = SHRINK_RADIUS * SHRINK_RADIUS;
    const MIN_SHRINK = 0.38;     // smallest allowed scale factor

    // Reset all shrink factors
    for (let i = 0; i < this.leaves.length; i += 1) {
      this.leaves[i]._collisionShrink = 1;
    }

    for (let i = 0; i < this.leaves.length; i += 1) {
      const a = this.leaves[i];
      if (a.collisionForceDetach || a.isDetaching) continue;
      if (a.mesh.scale.x < 0.01) continue;

      for (let j = i + 1; j < this.leaves.length; j += 1) {
        const b = this.leaves[j];
        if (b.collisionForceDetach || b.isDetaching) continue;
        if (b.mesh.scale.x < 0.01) continue;

        const distSq = a.pivot.position.distanceToSquared(b.pivot.position);
        if (distSq < SHRINK_RADIUS_SQ && distSq > 0.00001) {
          const dist = Math.sqrt(distSq);
          // 0 at center → 1 at edge of radius
          const proximity = 1 - dist / SHRINK_RADIUS;
          // Scale down proportionally: closer = smaller
          const shrink = THREE.MathUtils.lerp(1, MIN_SHRINK, proximity);
          a._collisionShrink = Math.min(a._collisionShrink, shrink);
          b._collisionShrink = Math.min(b._collisionShrink, shrink);
        }
      }
    }
  }

  createLeafCluster(
    anchorSegment,
    anchorPosition,
    direction,
    depth,
    birth,
    count,
    forceEarlyActive = false,
    clusterPriority = 0.5,
    guaranteeTip = false,
  ) {
    const priority = guaranteeTip
      ? 1
      : THREE.MathUtils.clamp(clusterPriority, 0, 1);
    let globalAvailableLeaves = this.maxLeafBudget - this.leaves.length;
    if (globalAvailableLeaves <= 0 && !guaranteeTip) {
      return;
    }

    // Reserva presupuesto para puntas: evita que el interior se coma todas las hojas.
    if (!forceEarlyActive && !guaranteeTip && priority < 0.4) {
      const reservedForTips = Math.floor(this.maxLeafBudget * 0.2);
      const maxNonTipUsage = this.maxLeafBudget - reservedForTips;
      const usedByNonTip = this.leaves.length;
      const remainingNonTip = maxNonTipUsage - usedByNonTip;
      if (remainingNonTip <= 0) {
        return;
      }
      globalAvailableLeaves = Math.min(globalAvailableLeaves, remainingNonTip);
    }

    const leafCount = Math.max(1, count);
    const anchorDirection = direction.clone().normalize();
    const baseAngle = this.rng() * TAU;
    const minAngularSeparation = 0.48;
    const sectorCount = 8;

    const helperAxis =
      Math.abs(anchorDirection.y) > 0.88
        ? new THREE.Vector3(1, 0, 0)
        : UP.clone();
    const tangentA = new THREE.Vector3()
      .crossVectors(anchorDirection, helperAxis)
      .normalize();
    const tangentB = new THREE.Vector3()
      .crossVectors(anchorDirection, tangentA)
      .normalize();

    let inverseAnchorBase = null;
    let registry = null;
    let currentAnchorLeafCount = 0;
    let maxLeavesAtAnchor = Infinity;
    let maxLeavesPerSector = Infinity;
    let sectorCounts = null;
    if (anchorSegment) {
      inverseAnchorBase = anchorSegment.baseQuaternion.clone().invert();
      if (!this.anchorLeafRegistry.has(anchorSegment)) {
        this.anchorLeafRegistry.set(anchorSegment, []);
      }
      registry = this.anchorLeafRegistry.get(anchorSegment);

      if (!this.anchorLeafCount.has(anchorSegment)) {
        this.anchorLeafCount.set(anchorSegment, 0);
      }
      if (!this.anchorLeafSectorCount.has(anchorSegment)) {
        this.anchorLeafSectorCount.set(anchorSegment, new Uint16Array(sectorCount));
      }

      currentAnchorLeafCount = this.anchorLeafCount.get(anchorSegment) || 0;
      sectorCounts = this.anchorLeafSectorCount.get(anchorSegment);

      const radiusNorm = THREE.MathUtils.clamp(
        (anchorSegment.finalRadius || 0.02) / 0.05,
        0.45,
        2.5,
      );
      const depthBonus = depth >= 2 ? depth * 2.1 : depth * 1.3;
      const densityBonus = THREE.MathUtils.clamp(
        (this.settings.leafDensity - 0.55) * 4.6,
        0,
        5.8,
      );
      const baseMaxLeavesAtAnchor =
        8 + radiusNorm * 5.2 + depthBonus + densityBonus;
      const priorityScale = THREE.MathUtils.lerp(0.58, 1.55, priority);
      maxLeavesAtAnchor = Math.max(
        2,
        Math.floor(baseMaxLeavesAtAnchor * priorityScale),
      );
      const hardAnchorCap = guaranteeTip
        ? 3
        : priority >= 0.95
          ? 7
          : priority >= 0.75
            ? 6
            : priority >= 0.4
              ? 5
              : 4;
      maxLeavesAtAnchor = Math.min(
        maxLeavesAtAnchor,
        hardAnchorCap + (depth >= this.settings.maxDepth - 1 ? 2 : 0),
      );
      if (guaranteeTip) {
        maxLeavesAtAnchor = Math.max(
          maxLeavesAtAnchor,
          currentAnchorLeafCount + 1,
        );
      }
      maxLeavesPerSector = Math.max(
        1,
        Math.ceil(maxLeavesAtAnchor / sectorCount) +
          (depth >= 2 ? 1 : 0) +
          (priority > 0.75 ? 1 : 0),
      );
      const hardPerSector = guaranteeTip ? 3 : priority >= 0.7 ? 3 : 2;
      maxLeavesPerSector = Math.min(maxLeavesPerSector, hardPerSector);

      const availableSlots = maxLeavesAtAnchor - currentAnchorLeafCount;
      if (availableSlots <= 0) {
        return;
      }
    }

    const leavesByAnchor = anchorSegment
      ? Math.min(leafCount, Math.max(0, maxLeavesAtAnchor - currentAnchorLeafCount))
      : leafCount;
    const leavesToCreate = Math.min(leavesByAnchor, globalAvailableLeaves);
    if (leavesToCreate <= 0) {
      return;
    }

    for (let i = 0; i < leavesToCreate; i += 1) {
      const seedAngle = baseAngle + (i / leavesToCreate) * TAU;
      let bestSurfaceDirection = tangentA.clone();
      let bestLocalSurface = tangentA.clone();
      let bestScore = -Infinity;
      let bestMinAngle = -Infinity;
      let bestSector = -1;

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const attemptOffset =
          attempt === 0
            ? 0
            : (attempt * 1.618 * 0.55) + (this.rng() - 0.5) * 0.35;
        const candidateAngle = seedAngle + attemptOffset;
        const candidateSurface = tangentA
          .clone()
          .multiplyScalar(Math.cos(candidateAngle))
          .addScaledVector(tangentB, Math.sin(candidateAngle))
          .normalize();

        const candidateLocal = inverseAnchorBase
          ? candidateSurface.clone().applyQuaternion(inverseAnchorBase).normalize()
          : candidateSurface.clone();

        let minAngle = Math.PI;
        if (registry && registry.length > 0) {
          for (let r = 0; r < registry.length; r += 1) {
            const dot = THREE.MathUtils.clamp(
              candidateLocal.dot(registry[r]),
              -1,
              1,
            );
            const angle = Math.acos(dot);
            if (angle < minAngle) {
              minAngle = angle;
            }
          }
        }

        let score = minAngle;
        let candidateSector = -1;
        if (sectorCounts) {
          const sectorAngle = Math.atan2(candidateLocal.z, candidateLocal.x);
          candidateSector =
            Math.floor(((sectorAngle + Math.PI) / TAU) * sectorCount) % sectorCount;
          const sectorLoad = sectorCounts[candidateSector] / maxLeavesPerSector;
          score -= sectorLoad * (0.95 - priority * 0.6);
          if (sectorCounts[candidateSector] >= maxLeavesPerSector) {
            score -= 1.6 - priority * 0.8;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestMinAngle = minAngle;
          bestSurfaceDirection = candidateSurface;
          bestLocalSurface = candidateLocal;
          bestSector = candidateSector;
        }

        if (minAngle >= minAngularSeparation && (!sectorCounts || score > -0.15)) {
          break;
        }
      }

      if (
        sectorCounts &&
        bestSector >= 0 &&
        sectorCounts[bestSector] >= maxLeavesPerSector &&
        !guaranteeTip
      ) {
        continue;
      }

      const crowding = THREE.MathUtils.clamp(
        (minAngularSeparation - bestMinAngle) / minAngularSeparation,
        0,
        1,
      );

      const radialBias = 0.84 + this.rng() * 0.34;
      const axialBias = 0.1 + this.rng() * 0.26;
      const leafDirection = bestSurfaceDirection
        .clone()
        .multiplyScalar(radialBias)
        .addScaledVector(anchorDirection, axialBias)
        .normalize();

      const anchorRadius = anchorSegment
        ? Math.max(0.002, anchorSegment.finalRadius * CYLINDER_TAPER * 0.96)
        : 0.02;
      const radialLift = 0.002 + this.rng() * 0.008 + crowding * 0.018;
      const axialOffset =
        (this.rng() - 0.5) * (0.018 + crowding * 0.026) +
        (i - (leafCount - 1) * 0.5) * 0.004;
      const leafPos = anchorPosition
        .clone()
        .addScaledVector(bestSurfaceDirection, anchorRadius + radialLift)
        .addScaledVector(anchorDirection, axialOffset);

      if (!guaranteeTip && !this.canPlaceLeafAt(leafPos, depth, priority)) {
        continue;
      }

      const created = this.createLeaf(
        leafPos,
        leafDirection,
        depth,
        birth + this.rng() * 0.04,
        anchorSegment,
        anchorPosition,
        bestSurfaceDirection,
        axialOffset,
        radialLift,
        crowding,
        forceEarlyActive,
        priority,
        guaranteeTip,
      );
      if (!created) {
        if (guaranteeTip) continue; // seguir intentando si es hoja garantizada
        return;
      }
      this.registerLeafAt(leafPos);

      if (registry) {
        registry.push(bestLocalSurface);
        const nextCount = (this.anchorLeafCount.get(anchorSegment) || 0) + 1;
        this.anchorLeafCount.set(anchorSegment, nextCount);
        if (sectorCounts && bestSector >= 0) {
          sectorCounts[bestSector] += 1;
        }
      }
    }
  }

  createSegment(start, direction, length, radius, depth, birth, duration, parentSegment = null) {
    const pivot = new THREE.Group();
    pivot.position.copy(start);
    
    // Para cilindros verticales (paralelos al eje Y), no aplicar rotación
    // para mantener alineación axial perfecta
    const directionNormalized = direction.clone().normalize();
    const dotProduct = directionNormalized.dot(UP);
    
    if (Math.abs(dotProduct) > 0.9999) {
      // Dirección es paralela a UP, mantener rotación neutral o invertir si apunta hacia abajo
      if (dotProduct < 0) {
        pivot.quaternion.setFromAxisAngle(AXIS_X, Math.PI);
      }
      // Si apunta hacia arriba, quaternion se queda en identidad (sin rotación)
    } else {
      pivot.quaternion.setFromUnitVectors(UP, directionNormalized);
    }

    const mesh = new THREE.Mesh(this.segmentGeometry, this.stemMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.scale.set(radius * 0.43, 0.0001, radius * 0.43);
    pivot.add(mesh);

    this.group.add(pivot);
    const baseQuaternion = pivot.quaternion.clone();
    const localQuaternion = parentSegment
      ? parentSegment.baseQuaternion.clone().invert().multiply(baseQuaternion.clone())
      : null;
    const swayAmplitudeBase = (0.004 + depth * 0.0035) * (0.8 + this.rng() * 0.6);
    const swayAmplitude = parentSegment
      ? parentSegment.swayAmplitude * (0.86 + this.rng() * 0.16)
      : swayAmplitudeBase;
    const swayPhase = parentSegment
      ? parentSegment.swayPhase + (this.rng() - 0.5) * 0.38
      : this.rng() * TAU;
    const isMainTrunk = depth === 0;

    const segment = {
      pivot,
      mesh,
      baseQuaternion,
      localQuaternion,
      start: start.clone(),
      birth,
      duration,
      finalRadius: radius * 0.43,
      finalLength: length,
      baseOffset: 0,
      depth,
      parentSegment,
      tipPosition: start.clone(),
      currentBaseRadius: 0,
      currentTopRadius: 0,
      swayAmplitude: isMainTrunk ? 0 : swayAmplitude,
      swayPhase: isMainTrunk ? 0 : swayPhase,
    };
    this.segments.push(segment);
    return segment;
  }

  createLeaf(
    position,
    direction,
    depth,
    birth,
    anchorSegment = null,
    anchorPosition = null,
    anchorSurfaceDirection = null,
    anchorAxialOffset = 0,
    anchorRadialLift = 0,
    crowding = 0,
    forceEarlyActive = false,
    tipPriority = 0.5,
    force = false,
  ) {
    if (!force && this.leaves.length >= this.maxLeafBudget) {
      return false;
    }

    const pivot = new THREE.Group();
    pivot.position.copy(position);
    pivot.quaternion.setFromUnitVectors(UP, direction);
    pivot.rotateY((this.rng() - 0.5) * TAU);

    const leafMaterial = this.leafMaterial.clone();
    const colorVariance = 0.9 + this.rng() * 0.22;
    leafMaterial.color.copy(LEAF_TINT_FRESH).multiplyScalar(colorVariance);
    leafMaterial.emissive.copy(LEAF_EMISSIVE_FRESH);
    const mesh = new THREE.Mesh(this.leafGeometry, leafMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.scale.set(0.0001, 0.0001, 0.0001);
    pivot.add(mesh);

    const lengthScale = 0.28 + this.rng() * 0.26;
    const widthScale = lengthScale * (0.56 + this.rng() * 0.45);
    const thicknessScale = lengthScale * (0.82 + this.rng() * 0.32);
    let localQuaternion = null;
    let anchorSurfaceLocal = null;
    let fallDirectionLocal = new THREE.Vector3(
      (this.rng() - 0.5) * 0.45,
      -1,
      (this.rng() - 0.5) * 0.45,
    ).normalize();

    if (anchorSegment && anchorPosition) {
      const inverseAnchorBase = anchorSegment.baseQuaternion.clone().invert();
      localQuaternion = inverseAnchorBase
        .clone()
        .multiply(pivot.quaternion.clone());
      if (anchorSurfaceDirection) {
        anchorSurfaceLocal = anchorSurfaceDirection
          .clone()
          .applyQuaternion(inverseAnchorBase)
          .normalize();
      } else {
        const fallbackSurface = position
          .clone()
          .sub(anchorPosition)
          .projectOnPlane(direction.clone().normalize());
        if (fallbackSurface.lengthSq() > 1e-8) {
          anchorSurfaceLocal = fallbackSurface
            .applyQuaternion(inverseAnchorBase)
            .normalize();
        }
      }

      const localSide = anchorSurfaceLocal
        ? anchorSurfaceLocal.clone()
        : new THREE.Vector3((this.rng() - 0.5), 0, (this.rng() - 0.5)).normalize();
      fallDirectionLocal = localSide
        .multiplyScalar(0.7 + this.rng() * 0.35)
        .add(
          new THREE.Vector3(
            (this.rng() - 0.5) * 0.2,
            -1,
            (this.rng() - 0.5) * 0.2,
          ),
        )
        .normalize();
    }

    const lifeGrowDuration = 1.4 + this.rng() * 1.2;
    const lifeMatureDuration = 6.5 + this.rng() * 7.2;
    const lifeSenescenceDuration = 2.2 + this.rng() * 2;
    const lifeFallDuration = 2.8 + this.rng() * 2.4;
    const lifeDormancyDuration = 2.3 + this.rng() * 3.4;
    const lifeCycleDuration =
      lifeGrowDuration +
      lifeMatureDuration +
      lifeSenescenceDuration +
      lifeFallDuration +
      lifeDormancyDuration;
    const lifeActiveWindow = lifeGrowDuration + lifeMatureDuration;
    const lifeOffset = forceEarlyActive
      ? this.rng() * Math.max(0.0001, lifeGrowDuration * 0.55)
      : this.rng() * lifeActiveWindow;

    this.group.add(pivot);
    this.leaves.push({
      pivot,
      mesh,
      baseQuaternion: pivot.quaternion.clone(),
      localQuaternion,
      anchorSegment,
      anchorSurfaceLocal,
      anchorAxialOffset,
      anchorRadialLift,
      birth,
      duration: 0.2 + this.rng() * 0.12,
      finalScale: new THREE.Vector3(widthScale, lengthScale, thicknessScale),
      depth,
      swayAmplitude: 0.1 + this.rng() * 0.18,
      swayPhase: this.rng() * TAU,
      bendBase: 0.08 + this.rng() * 0.12,
      bendAvoid: crowding * (0.22 + this.rng() * 0.26),
      colorVariance,
      tipPriority: THREE.MathUtils.clamp(tipPriority, 0, 1),
      fallPriority: this.rng(),
      isSeedLeaf: forceEarlyActive,
      isDetaching: false,
      collisionForceDetach: false,
      timeHold: 0,
      fallDirectionLocal,
      fallDistance: 0.08 + this.rng() * 0.2,
      fallDrift: 0.08 + this.rng() * 0.18,
      fallRoll: (this.rng() < 0.5 ? -1 : 1) * (0.35 + this.rng() * 0.9),
      fallFlutterAmplitude: 0.015 + this.rng() * 0.032,
      fallFlutterFrequency: 3.6 + this.rng() * 3,
      fallWindDrift: 0.03 + this.rng() * 0.08,
      groundFaceUp: this.rng() < 0.56,
      groundYaw: this.rng() * TAU,
      groundTiltX: (this.rng() - 0.5) * 0.16,
      groundTiltZ: (this.rng() - 0.5) * 0.14,
      lifeGrowDuration,
      lifeMatureDuration,
      lifeSenescenceDuration,
      lifeFallDuration,
      lifeDormancyDuration,
      lifeCycleDuration,
      lifeOffset,
      groundRestHeight: 0.008 + this.rng() * 0.014,
      groundSinkDepth: 0.02 + this.rng() * 0.036,
      collisionRadius: Math.max(
        0.017,
        (widthScale * 0.085) + (lengthScale * 0.11),
      ),
      physicsHandle: null,
      physicsLockedScale: null,
    });

    // Check if this new leaf collides with any existing old leaf and trigger their fall
    this.triggerCollisionFalls(position, anchorSegment);

    return true;
  }

  releaseLeafPhysics(leaf) {
    if (!leaf.physicsHandle || !this.physics || !this.physics.ready) {
      leaf.physicsHandle = null;
      leaf.physicsLockedScale = null;
      return;
    }

    this.physics.removeLeafBody(leaf.physicsHandle);
    leaf.physicsHandle = null;
    leaf.physicsLockedScale = null;
  }

  spawnLeafPhysicsBody(
    leaf,
    leafBaseQuaternion,
    leafFallWorld,
    windStrength,
    elapsedSeconds,
    groupWorldQuaternion,
  ) {
    if (
      !this.physics ||
      !this.physics.ready ||
      leaf.physicsHandle
    ) {
      return;
    }

    const startWorld = leaf.pivot.position.clone();
    this.group.localToWorld(startWorld);

    const worldQuaternion = groupWorldQuaternion
      .clone()
      .multiply(leafBaseQuaternion)
      .multiply(leaf.mesh.quaternion)
      .normalize();

    const windVector = new THREE.Vector3(
      Math.sin(elapsedSeconds * 0.43 + leaf.swayPhase),
      0,
      Math.cos(elapsedSeconds * 0.37 + leaf.swayPhase * 0.68),
    ).normalize();

    const initialVelocity = leafFallWorld
      .clone()
      .multiplyScalar(0.35 + leaf.fallDrift * 1.2)
      .addScaledVector(windVector, leaf.fallWindDrift * windStrength * 1.2);
    // Reducir velocidad vertical inicial para caída más lenta y realista
    initialVelocity.y -= 0.08 + leaf.fallDistance * 0.12;

    // Rotación más suave y realista como hojas que caen
    const initialAngularVelocity = new THREE.Vector3(
      (this.rng() - 0.5) * 1.2,
      (leaf.fallRoll || 0) * 1.4,
      (this.rng() - 0.5) * 1.2,
    );

    const areaHint = Math.max(
      0.02,
      (leaf.finalScale.x || 0.1) * (leaf.finalScale.y || 0.1),
    );
    const mass = THREE.MathUtils.clamp(
      0.0024 + areaHint * 0.0065,
      0.0024,
      0.0078,
    );

    const lockedScale = {
      x: Math.max(0.0002, leaf.mesh.scale.x),
      y: Math.max(0.0002, leaf.mesh.scale.y),
      z: Math.max(0.0002, leaf.mesh.scale.z),
    };

    const handle = this.physics.createLeafBody({
      position: startWorld,
      quaternion: worldQuaternion,
      radius: leaf.collisionRadius,
      mass,
      initialVelocity,
      initialAngularVelocity,
      leafGeometry: this.leafGeometry,
      leafScale: lockedScale,
      windPhase: leaf.swayPhase,
    });
    leaf.physicsHandle = handle;
    leaf.physicsLockedScale = handle
      ? new THREE.Vector3(lockedScale.x, lockedScale.y, lockedScale.z)
      : null;
  }

  computeLeafLifecycle(leaf, age, elapsedSeconds) {
    let lifeScale = 1;
    let senescence = 0;
    let fall = 0;
    let groundDecay = 0;
    let hidden = false;
    let stage = "mature";

    if (leaf.isSeedLeaf) {
      const a = THREE.MathUtils.clamp(age, 0, 1);
      if (a < 0.1) {
        stage = "grow";
        lifeScale = smooth01(a / 0.1);
      } else if (a < 0.42) {
        stage = "mature";
        lifeScale = 1;
      } else if (a < 0.5) {
        stage = "senescence";
        const t = (a - 0.42) / 0.08;
        senescence = THREE.MathUtils.clamp(t, 0, 1);
        lifeScale = 1 - senescence * 0.14;
      } else if (a < 0.68) {
        stage = "fall";
        const t = (a - 0.5) / 0.18;
        senescence = 1;
        fall = THREE.MathUtils.clamp(t, 0, 1);
        lifeScale = 1 - fall * 0.12;
      } else if (a < 0.92) {
        stage = "ground";
        const t = (a - 0.68) / 0.24;
        senescence = 1;
        fall = 1;
        groundDecay = THREE.MathUtils.clamp(t, 0, 1);
        const vanish = smooth01((groundDecay - 0.88) / 0.12);
        lifeScale = Math.max(0, 1 - vanish * 0.12);
      } else {
        stage = "hidden";
        hidden = true;
        lifeScale = 0;
      }
    } else {
      const lifeTime =
        Math.max(0, elapsedSeconds - (leaf.timeHold || 0)) + leaf.lifeOffset;
      const phase = lifeTime % leaf.lifeCycleDuration;
      const growEnd = leaf.lifeGrowDuration;
      const matureEnd = growEnd + leaf.lifeMatureDuration;
      const senescenceEnd = matureEnd + leaf.lifeSenescenceDuration;
      const fallEnd = senescenceEnd + leaf.lifeFallDuration;
      const groundDuration = leaf.lifeDormancyDuration * 0.62;
      const hiddenEnd = fallEnd + leaf.lifeDormancyDuration;

      if (phase < growEnd) {
        stage = "grow";
        lifeScale = smooth01(phase / leaf.lifeGrowDuration);
      } else if (phase < matureEnd) {
        stage = "mature";
        lifeScale = 1;
      } else if (phase < senescenceEnd) {
        stage = "senescence";
        const t = (phase - matureEnd) / leaf.lifeSenescenceDuration;
        senescence = THREE.MathUtils.clamp(t, 0, 1);
        fall = smooth01((senescence - 0.46) / 0.54);
        lifeScale = 1 - senescence * 0.14 - fall * 0.08;
      } else if (phase < fallEnd) {
        stage = "fall";
        const t = (phase - senescenceEnd) / leaf.lifeFallDuration;
        senescence = 1;
        fall = THREE.MathUtils.clamp(t, 0, 1);
        lifeScale = 1 - fall * 0.12;
      } else if (phase < fallEnd + groundDuration) {
        stage = "ground";
        const t = (phase - fallEnd) / Math.max(0.0001, groundDuration);
        senescence = 1;
        fall = 1;
        groundDecay = THREE.MathUtils.clamp(t, 0, 1);
        const vanish = smooth01((groundDecay - 0.88) / 0.12);
        lifeScale = Math.max(0, 1 - vanish * 0.12);
      } else if (phase < hiddenEnd) {
        stage = "hidden";
        hidden = true;
        lifeScale = 0;
      } else {
        stage = "hidden";
        hidden = true;
        lifeScale = 0;
      }

      const tipPriority = leaf.tipPriority ?? 0.5;
      if (tipPriority >= 0.92) {
        // Hoja terminal persistente: evita puntas vacías.
        stage = hidden ? "mature" : stage;
        hidden = false;
        groundDecay = 0;
        fall = Math.min(fall, 0.08);
        senescence *= 0.35;
        lifeScale = Math.max(lifeScale, 0.72 + smooth01(age) * 0.28);
      } else {
        // Hojas internas: conforme crece la planta, se desprenden gradualmente.
        const interiorFactor = THREE.MathUtils.clamp((0.74 - tipPriority) / 0.74, 0, 1);
        if (interiorFactor > 0.04) {
          const shedStart = THREE.MathUtils.lerp(0.84, 0.42, interiorFactor);
          if (age > shedStart) {
            const shedProgress = THREE.MathUtils.clamp(
              (age - shedStart) / Math.max(0.08, 1 - shedStart),
              0,
              1,
            );
            senescence = Math.max(senescence, shedProgress);
            const forcedFall = smooth01((shedProgress - 0.2) / 0.52);
            fall = Math.max(fall, forcedFall);
            lifeScale = Math.min(
              lifeScale,
              Math.max(0, 1 - shedProgress * (0.72 + interiorFactor * 0.24)),
            );

            if (shedProgress > 0.62) {
              stage = "ground";
              fall = 1;
              groundDecay = Math.max(
                groundDecay,
                smooth01((shedProgress - 0.62) / 0.38),
              );
            }
            if (shedProgress > 0.985) {
              stage = "hidden";
              hidden = true;
              groundDecay = 1;
              lifeScale = 0;
            }
          }
        }
      }
    }

    // If this leaf was displaced by a collision with a newer leaf, force it into fall.
    // Wait until the leaf has actually emerged (become visible) before triggering the fall,
    // so the user can see it grow in briefly and THEN fall off.
    if (leaf.collisionForceDetach) {
      const emergence = smooth01((age - leaf.birth) / Math.max(leaf.duration, 0.01));

      if (emergence < 0.35) {
        // Leaf hasn't emerged yet — let the normal lifecycle handle the grow-in animation.
        // Don't override anything so it appears to grow normally first.
      } else {
        // Leaf is visible — start the collision fall timer
        if (leaf._collisionStartTime === undefined) leaf._collisionStartTime = elapsedSeconds;
        const ct = Math.max(0, elapsedSeconds - leaf._collisionStartTime);
        if (ct < 1.2) {
          // Rapid senescence + fall
          stage = "fall";
          senescence = Math.max(senescence, ct / 0.4);
          fall = Math.max(fall, smooth01(ct / 1.2));
          lifeScale = Math.min(lifeScale, 1 - fall * 0.15);
        } else if (ct < 3.0) {
          stage = "ground";
          senescence = 1;
          fall = 1;
          groundDecay = smooth01((ct - 1.2) / 1.8);
          lifeScale = Math.max(0, 1 - groundDecay * 0.3);
        } else {
          stage = "hidden";
          hidden = true;
          lifeScale = 0;
          groundDecay = 1;
        }
      }
    }

    return {
      lifeScale,
      senescence,
      fall,
      groundDecay,
      hidden,
      stage,
    };
  }

  update(elapsedSeconds, age, windStrength) {
    const swayQuatA = new THREE.Quaternion();
    const swayQuatB = new THREE.Quaternion();
    const swayQuatC = new THREE.Quaternion();
    const tipWorld = new THREE.Vector3();
    const dynamicTargetQuat = new THREE.Quaternion();
    const leafAnchorSurfaceWorld = new THREE.Vector3();
    const leafAxisWorld = new THREE.Vector3();
    const leafBaseQuaternion = new THREE.Quaternion();
    const leafFallWorld = new THREE.Vector3();
    const leafStartLocal = new THREE.Vector3();
    const leafStartWorld = new THREE.Vector3();
    const leafWorld = new THREE.Vector3();
    const leafFlightWorld = new THREE.Vector3();
    const leafWindWorld = new THREE.Vector3();
    const leafGroundWorld = new THREE.Vector3();
    const leafGroundLocal = new THREE.Vector3();
    const leafLateral = new THREE.Vector3();
    const leafTint = new THREE.Color();
    const leafEmissiveTint = new THREE.Color();
    const leafOrientationQuat = new THREE.Quaternion();
    const leafGroundQuat = new THREE.Quaternion();
    const physicsPositionWorld = new THREE.Vector3();
    const physicsVelocityWorld = new THREE.Vector3();
    const physicsQuaternionWorld = new THREE.Quaternion();
    const groupWorldQuaternion = new THREE.Quaternion();
    const inverseGroupWorldQuaternion = new THREE.Quaternion();
    const segmentColliderLocal = new THREE.Vector3();
    const segmentColliderWorld = new THREE.Vector3();
    const segmentColliderWorldQuaternion = new THREE.Quaternion();
    const plantColliders = [];
    const deltaSeconds =
      this.lastUpdateTime === null
        ? 0
        : THREE.MathUtils.clamp(elapsedSeconds - this.lastUpdateTime, 0, 0.12);
    this.lastUpdateTime = elapsedSeconds;

    this.group.rotation.y = Math.sin(elapsedSeconds * 0.4) * 0.028 * windStrength;
    this.group.position.x = Math.sin(elapsedSeconds * 0.35) * 0.013 * windStrength;

    for (let i = 0; i < this.segments.length; i += 1) {
      const segment = this.segments[i];
      const growth = smooth01((age - segment.birth) / segment.duration);
      const ownRadialGrowth = 0.06 + growth * 0.94;
      const plantMaturity = smooth01(age);
      const globalThickening = 0.05 + Math.pow(plantMaturity, 1.2) * 0.95;
      let radialGrowth = ownRadialGrowth;

      // Forzar continuidad de radios durante el crecimiento:
      // la base del hijo siempre toma el radio superior actual del padre.
      if (segment.parentSegment) {
        radialGrowth =
          segment.parentSegment.currentTopRadius /
          Math.max(segment.finalRadius, 1e-8);
      } else {
        // El primer segmento (base) engrosa con la planta completa.
        // Esto evita que inicie con su ancho final cuando la planta es pequeña.
        radialGrowth = Math.min(ownRadialGrowth, globalThickening);
      }

      const grownLength = Math.max(0.0001, segment.finalLength * growth);

      if (segment.parentSegment) {
        segment.pivot.position.copy(segment.parentSegment.tipPosition);
      } else {
        segment.pivot.position.copy(segment.start);
      }

      segment.mesh.scale.set(
        segment.finalRadius * radialGrowth,
        grownLength,
        segment.finalRadius * radialGrowth,
      );
      segment.currentLength = grownLength;
      segment.mesh.position.y = grownLength * segment.baseOffset;

      // Orientación por continuidad padre->hijo.
      // El tronco puede curvarse porque ya no se fuerza quaternion identidad.
      if (segment.parentSegment) {
        const alignProgress = smooth01((growth - 0.08) / 0.92);
        dynamicTargetQuat
          .copy(segment.parentSegment.pivot.quaternion)
          .multiply(segment.localQuaternion);
        segment.pivot.quaternion
          .copy(segment.parentSegment.pivot.quaternion)
          .slerp(dynamicTargetQuat, alignProgress);
      } else {
        segment.pivot.quaternion.copy(segment.baseQuaternion);
      }

      // Solo aplicar sway (movimiento por viento) a ramas, no al tronco principal
      if (segment.depth !== 0) {
        const swayAmount =
          Math.sin(elapsedSeconds * 0.92 + segment.swayPhase) *
          segment.swayAmplitude *
          windStrength *
          (0.45 + segment.depth * 0.2) *
          growth;

        swayQuatA.setFromAxisAngle(AXIS_Z, swayAmount);
        swayQuatB.setFromAxisAngle(AXIS_X, swayAmount * 0.55);
        segment.pivot.quaternion.multiply(swayQuatA).multiply(swayQuatB);
      }

      segment.currentBaseRadius = segment.finalRadius * radialGrowth;
      segment.currentTopRadius = segment.currentBaseRadius * CYLINDER_TAPER;

      tipWorld
        .set(0, segment.mesh.position.y + grownLength, 0)
        .applyQuaternion(segment.pivot.quaternion)
        .add(segment.pivot.position);
      segment.tipPosition.copy(tipWorld);
    }

    this.group.updateMatrixWorld();
    this.group.getWorldQuaternion(groupWorldQuaternion);
    inverseGroupWorldQuaternion.copy(groupWorldQuaternion).invert();

    if (this.physics && this.physics.ready) {
      plantColliders.length = 0;
      for (let i = 0; i < this.segments.length; i += 1) {
        const segment = this.segments[i];
        if (segment.depth > 1) {
          continue;
        }

        const segmentLength = segment.currentLength || 0;
        if (segmentLength < 0.02) {
          continue;
        }

        const colliderRadius =
          Math.max(segment.currentTopRadius, segment.currentBaseRadius) *
          (segment.depth === 0 ? 1.04 : 1.02);
        if (colliderRadius < 0.01) {
          continue;
        }
        const colliderHeight = Math.max(0.02, segmentLength * 0.98);

        segmentColliderLocal
          .set(0, segment.mesh.position.y + segmentLength * 0.5, 0)
          .applyQuaternion(segment.pivot.quaternion)
          .add(segment.pivot.position);
        segmentColliderWorld
          .copy(segmentColliderLocal)
          .applyMatrix4(this.group.matrixWorld);
        segmentColliderWorldQuaternion
          .copy(groupWorldQuaternion)
          .multiply(segment.pivot.quaternion)
          .normalize();

        plantColliders.push({
          id: `seg-${i}`,
          type: "cylinder",
          x: segmentColliderWorld.x,
          y: segmentColliderWorld.y,
          z: segmentColliderWorld.z,
          radius: colliderRadius,
          height: colliderHeight,
          quaternion: {
            x: segmentColliderWorldQuaternion.x,
            y: segmentColliderWorldQuaternion.y,
            z: segmentColliderWorldQuaternion.z,
            w: segmentColliderWorldQuaternion.w,
          },
        });
      }

      this.physics.syncPlantColliders(plantColliders);
      this.physics.applyLeafAerodynamics(elapsedSeconds, windStrength);
      if (deltaSeconds > 0) {
        this.physics.step(deltaSeconds);
      }
    }

    // Runtime collision: detect overlapping visible leaves each frame
    // Throttle to every ~30 frames for performance
    if (!this._collisionFrame) this._collisionFrame = 0;
    this._collisionFrame += 1;
    if (this._collisionFrame % 30 === 0 || this._collisionFrame === 1) {
      this.checkRuntimeCollisions();
      this.computeCollisionShrink();
    }

    const lifecycleStates = new Array(this.leaves.length);
    for (let i = 0; i < this.leaves.length; i += 1) {
      lifecycleStates[i] = this.computeLeafLifecycle(
        this.leaves[i],
        age,
        elapsedSeconds,
      );
    }

    const hardConcurrentFallCap = THREE.MathUtils.clamp(
      Math.round(this.settings.maxConcurrentLeafFall ?? 12),
      0,
      15,
    );
    const flowNoise =
      Math.sin(elapsedSeconds * 0.18 + this.settings.seed * 0.017) * 0.5 + 0.5;
    let preferredConcurrentFalling = 0;
    if (hardConcurrentFallCap > 0) {
      const preferredMin = Math.min(2, hardConcurrentFallCap);
      preferredConcurrentFalling = Math.round(
        THREE.MathUtils.lerp(preferredMin, hardConcurrentFallCap, flowNoise),
      );
    }
    if (hardConcurrentFallCap > 0 && windStrength > 0.82) {
      const gustNoise =
        Math.sin(elapsedSeconds * 0.33 + this.settings.seed * 0.031) * 0.5 + 0.5;
      if (gustNoise > 0.7) {
        preferredConcurrentFalling += Math.max(
          1,
          Math.round(hardConcurrentFallCap * 0.14),
        );
      }
    }
    preferredConcurrentFalling = THREE.MathUtils.clamp(
      preferredConcurrentFalling,
      0,
      hardConcurrentFallCap,
    );

    const activeDetachingIndices = [];
    const pendingStartIndices = [];
    for (let i = 0; i < this.leaves.length; i += 1) {
      const leaf = this.leaves[i];
      const state = lifecycleStates[i];
      const wantsFall = state.fall > 0 && state.groundDecay <= 0 && !state.hidden;

      // Collision-forced leaves always detach, bypass throttle
      if (leaf.collisionForceDetach) {
        leaf.isDetaching = true;
        if (wantsFall) activeDetachingIndices.push(i);
        continue;
      }

      if (leaf.isSeedLeaf) {
        if (wantsFall || state.groundDecay > 0) {
          leaf.isDetaching = true;
        } else if (state.hidden || state.fall <= 0) {
          leaf.isDetaching = false;
        }

        if (leaf.isDetaching && wantsFall) {
          activeDetachingIndices.push(i);
        }
        continue;
      }

      if (!wantsFall) {
        if (state.groundDecay > 0 || state.hidden) {
          leaf.isDetaching = false;
        }
        continue;
      }

      if (leaf.isDetaching) {
        activeDetachingIndices.push(i);
      } else {
        pendingStartIndices.push(i);
      }
    }

    if (activeDetachingIndices.length > hardConcurrentFallCap) {
      activeDetachingIndices.sort(
        (a, b) => {
          const scoreA =
            lifecycleStates[a].fall * 1.2 +
            lifecycleStates[a].senescence * 0.35 +
            this.leaves[a].fallPriority * 0.08 +
            (this.leaves[a].isSeedLeaf ? 3 : 0);
          const scoreB =
            lifecycleStates[b].fall * 1.2 +
            lifecycleStates[b].senescence * 0.35 +
            this.leaves[b].fallPriority * 0.08 +
            (this.leaves[b].isSeedLeaf ? 3 : 0);
          return scoreB - scoreA;
        },
      );
      for (let i = hardConcurrentFallCap; i < activeDetachingIndices.length; i += 1) {
        const index = activeDetachingIndices[i];
        this.leaves[index].isDetaching = false;
        pendingStartIndices.push(index);
      }
      activeDetachingIndices.length = hardConcurrentFallCap;
    }

    const openHardSlots = Math.max(
      0,
      hardConcurrentFallCap - activeDetachingIndices.length,
    );
    const openPreferredSlots = Math.max(
      0,
      preferredConcurrentFalling - activeDetachingIndices.length,
    );
    const startBudget = Math.min(openHardSlots, openPreferredSlots);

    pendingStartIndices.sort((a, b) => {
      const scoreA =
        lifecycleStates[a].fall * 1.2 +
        lifecycleStates[a].senescence * 0.35 +
        this.leaves[a].fallPriority * 0.08 +
        (this.leaves[a].isSeedLeaf ? 3 : 0);
      const scoreB =
        lifecycleStates[b].fall * 1.2 +
        lifecycleStates[b].senescence * 0.35 +
        this.leaves[b].fallPriority * 0.08 +
        (this.leaves[b].isSeedLeaf ? 3 : 0);
      return scoreB - scoreA;
    });

    for (let i = 0; i < pendingStartIndices.length; i += 1) {
      const index = pendingStartIndices[i];
      const leaf = this.leaves[index];
      if (i < startBudget) {
        leaf.isDetaching = true;
      } else {
        leaf.isDetaching = false;
        leaf.timeHold += deltaSeconds;
        const state = lifecycleStates[index];
        state.fall = 0;
        state.groundDecay = 0;
        state.hidden = false;
        state.stage = "senescence";
        state.lifeScale = Math.max(state.lifeScale, 1 - state.senescence * 0.14);
      }
    }

    for (let i = 0; i < this.leaves.length; i += 1) {
      const leaf = this.leaves[i];
      const emergence = smooth01((age - leaf.birth) / leaf.duration);
      const state = lifecycleStates[i];
      let lifeScale = state.lifeScale;
      let senescence = state.senescence;
      let fall = state.fall;
      let groundDecay = state.groundDecay;
      let hidden = state.hidden;
      let visualSenescence = senescence;

      if (
        !leaf.isSeedLeaf &&
        !leaf.isDetaching &&
        (fall > 0 || groundDecay > 0 || hidden)
      ) {
        fall = 0;
        groundDecay = 0;
        hidden = false;
        lifeScale = Math.max(lifeScale, 1 - senescence * 0.08);
      } else if (
        !leaf.isSeedLeaf &&
        (groundDecay > 0 || hidden || fall <= 0) &&
        leaf.isDetaching
      ) {
        leaf.isDetaching = false;
      }

      if (!leaf.isSeedLeaf && !leaf.isDetaching && groundDecay <= 0 && !hidden) {
        visualSenescence *= 0.14;
      }

      const growth = emergence * lifeScale;

      if (leaf.anchorSegment && leaf.anchorSurfaceLocal && leaf.localQuaternion) {
        leafAnchorSurfaceWorld
          .copy(leaf.anchorSurfaceLocal)
          .applyQuaternion(leaf.anchorSegment.pivot.quaternion)
          .normalize();
        leafAxisWorld
          .copy(UP)
          .applyQuaternion(leaf.anchorSegment.pivot.quaternion)
          .normalize();
        const attachRadius = Math.max(
          0.0005,
          leaf.anchorSegment.currentTopRadius * 0.98 +
            (leaf.anchorRadialLift || 0) * growth,
        );
        leaf.pivot.position
          .copy(leaf.anchorSegment.tipPosition)
          .addScaledVector(leafAnchorSurfaceWorld, attachRadius)
          .addScaledVector(leafAxisWorld, leaf.anchorAxialOffset || 0);
        leafBaseQuaternion
          .copy(leaf.anchorSegment.pivot.quaternion)
          .multiply(leaf.localQuaternion);
      } else {
        leafBaseQuaternion.copy(leaf.baseQuaternion);
      }

      const detached = Math.max(fall, groundDecay);
      let usedPhysicsTransform = false;
      let physicsBodyState = null;

      if (detached > 0) {
        if (leaf.anchorSegment) {
          leafFallWorld
            .copy(leaf.fallDirectionLocal)
            .applyQuaternion(leaf.anchorSegment.pivot.quaternion)
            .normalize();
        } else {
          leafFallWorld.copy(leaf.fallDirectionLocal).normalize();
        }
      } else if (leaf.physicsHandle) {
        this.releaseLeafPhysics(leaf);
      }

      if (
        detached > 0 &&
        this.physics &&
        this.physics.ready &&
        leaf.isDetaching &&
        !hidden
      ) {
        if (!leaf.physicsHandle && fall > 0.02) {
          this.spawnLeafPhysicsBody(
            leaf,
            leafBaseQuaternion,
            leafFallWorld,
            windStrength,
            elapsedSeconds,
            groupWorldQuaternion,
          );
        }

        if (leaf.physicsHandle) {
          physicsBodyState = this.physics.readBodyState(
            leaf.physicsHandle,
            physicsPositionWorld,
            physicsQuaternionWorld,
            physicsVelocityWorld,
          );

          if (physicsBodyState) {
            leafGroundLocal.copy(physicsPositionWorld);
            this.group.worldToLocal(leafGroundLocal);
            leaf.pivot.position.copy(leafGroundLocal);
            leaf.pivot.quaternion
              .copy(inverseGroupWorldQuaternion)
              .multiply(physicsQuaternionWorld);
            usedPhysicsTransform = true;

            if (physicsBodyState.onGround) {
              fall = Math.max(fall, 0.96);
            }
          } else {
            this.releaseLeafPhysics(leaf);
          }
        }
      } else if (leaf.physicsHandle) {
        this.releaseLeafPhysics(leaf);
      }

      if (detached > 0 && !usedPhysicsTransform) {
        leafStartLocal.copy(leaf.pivot.position);
        leafStartWorld.copy(leafStartLocal).applyMatrix4(this.group.matrixWorld);
        leafLateral.copy(leafFallWorld);
        leafLateral.y = 0;
        if (leafLateral.lengthSq() < 1e-6) {
          leafLateral.set(1, 0, 0);
        } else {
          leafLateral.normalize();
        }

        const fallBlend = smooth01(fall);
        const lateralBlend = Math.pow(fallBlend, 0.9);
        const verticalBlend = Math.pow(fallBlend, 2.05);
        const driftDistance = leaf.fallDrift + leaf.fallDistance * 0.58;
        const driftByFall = driftDistance * lateralBlend;

        leafWindWorld
          .set(
            Math.sin(elapsedSeconds * 0.43 + leaf.swayPhase),
            0,
            Math.cos(elapsedSeconds * 0.37 + leaf.swayPhase * 0.68),
          )
          .normalize();
        const windSlide =
          leaf.fallWindDrift * windStrength * THREE.MathUtils.clamp(lateralBlend, 0, 1);

        leafWorld
          .copy(leafStartWorld)
          .addScaledVector(leafLateral, driftByFall)
          .addScaledVector(leafWindWorld, windSlide);
        const groundY =
          sampleSurfaceHeightAt(leafWorld.x, leafWorld.z) + leaf.groundRestHeight;

        const flutter =
          Math.sin(
            elapsedSeconds * leaf.fallFlutterFrequency + leaf.swayPhase * 3.4,
          ) *
          leaf.fallFlutterAmplitude *
          (1 - verticalBlend) *
          (1 - verticalBlend);

        leafFlightWorld.copy(leafWorld);
        leafFlightWorld.y =
          leafStartWorld.y + (groundY - leafStartWorld.y) * verticalBlend + flutter;
        if (leafFlightWorld.y < groundY) {
          leafFlightWorld.y = groundY;
        }

        leafGroundWorld.set(leafWorld.x, groundY, leafWorld.z);
        if (groundDecay > 0) {
          const sink = leaf.groundSinkDepth * smooth01(groundDecay);
          leafGroundWorld.y -= sink;
        }

        leafGroundLocal.copy(leafGroundWorld);
        this.group.worldToLocal(leafGroundLocal);

        if (groundDecay > 0) {
          leaf.pivot.position.copy(leafGroundLocal);
        } else {
          leafGroundLocal.copy(leafFlightWorld);
          this.group.worldToLocal(leafGroundLocal);
          leaf.pivot.position.copy(leafGroundLocal);
        }
      }

      const detachingFall = leaf.isDetaching ? fall : 0;
      const yellowMix = THREE.MathUtils.clamp(
        visualSenescence * 0.2 + detachingFall * 0.92 + groundDecay * 0.7,
        0,
        1,
      );
      const brownMix = smooth01((groundDecay - 0.12) / 0.72);
      const fadeMix = hidden
        ? 1
        : smooth01((groundDecay - 0.86) / 0.14) * brownMix;
      const scaleFade = hidden ? 0 : 1 - fadeMix * 0.92;
      const renderedGrowth = growth * scaleFade;

      leafTint
        .copy(LEAF_TINT_FRESH)
        .multiplyScalar(leaf.colorVariance || 1)
        .lerp(LEAF_TINT_YELLOW, yellowMix)
        .lerp(LEAF_TINT_BROWN, brownMix);
      leafEmissiveTint.copy(LEAF_EMISSIVE_FRESH).lerp(LEAF_EMISSIVE_DRY, brownMix);
      leaf.mesh.material.color.copy(leafTint);
      leaf.mesh.material.emissive.copy(leafEmissiveTint);
      leaf.mesh.material.opacity = THREE.MathUtils.clamp(0.96 * (1 - fadeMix), 0, 0.96);

      // Apply collision shrink factor for leaves still near neighbors
      const collisionShrink = leaf._collisionShrink ?? 1;
      let scaleX = Math.max(0.0001, leaf.finalScale.x * renderedGrowth * collisionShrink);
      let scaleY = Math.max(0.0001, leaf.finalScale.y * renderedGrowth * collisionShrink);
      let scaleZ = Math.max(0.0001, leaf.finalScale.z * renderedGrowth * collisionShrink);
      if (usedPhysicsTransform && leaf.physicsLockedScale) {
        scaleX = Math.max(0.0001, leaf.physicsLockedScale.x * scaleFade);
        scaleY = Math.max(0.0001, leaf.physicsLockedScale.y * scaleFade);
        scaleZ = Math.max(0.0001, leaf.physicsLockedScale.z * scaleFade);
      }
      leaf.mesh.scale.set(scaleX, scaleY, scaleZ);
      const bendX = -(
        (leaf.bendBase || 0) +
        (leaf.bendAvoid || 0) * growth +
        senescence * 0.85 +
        fall * 1.1 +
        groundDecay * 1.25
      );
      const bendZ = (leaf.fallRoll || 0) * (fall + groundDecay * 0.45);
      const groundFlatten = smooth01((groundDecay - 0.22) / 0.78);
      const restingX = leaf.groundFaceUp ? 0.03 : -0.03;
      if (usedPhysicsTransform) {
        leaf.mesh.rotation.set(0, 0, 0);
      } else {
        leaf.mesh.rotation.x = THREE.MathUtils.lerp(bendX, restingX, groundFlatten);
        leaf.mesh.rotation.z = THREE.MathUtils.lerp(bendZ, 0, groundFlatten);
      }

      const attachment = usedPhysicsTransform ? 0 : 1 - detached;
      const swayGrowth = growth * Math.max(0, attachment);

      const leafSway =
        Math.sin(elapsedSeconds * 2.6 + leaf.swayPhase) *
        leaf.swayAmplitude *
        windStrength *
        (0.18 + leaf.depth * 0.08) *
        swayGrowth;

      const leafTwist =
        Math.sin(elapsedSeconds * 3.1 + leaf.swayPhase * 1.34) *
        leaf.swayAmplitude *
        0.35 *
        windStrength *
        swayGrowth;

      swayQuatA.setFromAxisAngle(AXIS_Z, leafSway);
      swayQuatB.setFromAxisAngle(AXIS_X, leafSway * 0.45);
      swayQuatC.setFromAxisAngle(UP, leafTwist);
      if (usedPhysicsTransform) {
        leafOrientationQuat.copy(leaf.pivot.quaternion);
      } else {
        leafOrientationQuat.copy(leafBaseQuaternion);

        if (detached > 0) {
          const tumbleMix = Math.max(0, 1 - groundDecay * 1.25);
          swayQuatA.setFromAxisAngle(
            leafFallWorld,
            (leaf.fallRoll || 0) * fall * 0.62 * tumbleMix,
          );
          swayQuatB.setFromAxisAngle(AXIS_X, -0.42 * fall * tumbleMix);
          leafOrientationQuat.multiply(swayQuatA).multiply(swayQuatB);

          leafGroundQuat.setFromUnitVectors(AXIS_Z, leaf.groundFaceUp ? UP : DOWN);
          swayQuatA.setFromAxisAngle(UP, leaf.groundYaw);
          swayQuatB.setFromAxisAngle(AXIS_X, leaf.groundTiltX || 0);
          swayQuatC.setFromAxisAngle(AXIS_Z, leaf.groundTiltZ || 0);
          leafGroundQuat.multiply(swayQuatA).multiply(swayQuatB).multiply(swayQuatC);

          const settle =
            smooth01((fall - 0.8) / 0.2) + smooth01(groundDecay) * 0.95;
          leafOrientationQuat.slerp(leafGroundQuat, THREE.MathUtils.clamp(settle, 0, 1));
        }
      }

      swayQuatA.setFromAxisAngle(AXIS_Z, leafSway);
      swayQuatB.setFromAxisAngle(AXIS_X, leafSway * 0.45);
      swayQuatC.setFromAxisAngle(UP, leafTwist);
      leaf.pivot.quaternion
        .copy(leafOrientationQuat)
        .multiply(swayQuatA)
        .multiply(swayQuatB)
        .multiply(swayQuatC);
    }

  }

  dispose() {
    this.scene.remove(this.group);
    if (this.physics && this.physics.ready) {
      this.physics.clearPlantColliders();
    }
    this.segmentGeometry.dispose();
    this.leafGeometry.dispose();
    this.stemMaterial.dispose();
    for (let i = 0; i < this.leaves.length; i += 1) {
      this.releaseLeafPhysics(this.leaves[i]);
      this.leaves[i].mesh.material.dispose();
    }
    this.leafMaterial.dispose();
  }
}

const ui = {
  growth: document.getElementById("growth"),
  growthValue: document.getElementById("growthValue"),
  autoGrow: document.getElementById("autoGrow"),
  growthSpeed: document.getElementById("growthSpeed"),
  growthSpeedValue: document.getElementById("growthSpeedValue"),
  wind: document.getElementById("wind"),
  windValue: document.getElementById("windValue"),
  fallingLeaves: document.getElementById("fallingLeaves"),
  fallingLeavesValue: document.getElementById("fallingLeavesValue"),
  physics: document.getElementById("physics"),
  physicsDebug: document.getElementById("physicsDebug"),
  physicsStatus: document.getElementById("physicsStatus"),
  branching: document.getElementById("branching"),
  branchingValue: document.getElementById("branchingValue"),
  leafDensity: document.getElementById("leafDensity"),
  leafDensityValue: document.getElementById("leafDensityValue"),
  depth: document.getElementById("depth"),
  depthValue: document.getElementById("depthValue"),
  seed: document.getElementById("seed"),
  regenerate: document.getElementById("regenerate"),
  randomize: document.getElementById("randomize"),
};

const state = {
  age: 0,
  autoGrow: true,
  growthSpeed: Number(ui.growthSpeed.value),
  windStrength: Number(ui.wind.value),
  maxConcurrentLeafFall: Number(ui.fallingLeaves.value),
  physicsEnabled: Boolean(ui.physics.checked),
  showPhysicsColliders: Boolean(ui.physicsDebug.checked),
  branching: Number(ui.branching.value),
  leafDensity: Number(ui.leafDensity.value),
  maxDepth: Number(ui.depth.value),
  seed: Number(ui.seed.value),
};

let plant = null;
let physicsEngine = null;
const physicsState = {
  loading: false,
  ready: false,
  error: null,
};

function refreshPhysicsStatus() {
  if (!ui.physicsStatus) {
    return;
  }

  if (physicsState.error) {
    ui.physicsStatus.textContent = "Ammo.js: unavailable (fallback analytic)";
    ui.physicsStatus.dataset.state = "fallback";
    return;
  }

  if (physicsState.loading) {
    ui.physicsStatus.textContent = "Ammo.js: loading...";
    ui.physicsStatus.dataset.state = "loading";
    return;
  }

  if (physicsState.ready && state.physicsEnabled) {
    ui.physicsStatus.textContent = "Ammo.js: active";
    ui.physicsStatus.dataset.state = "ready";
    return;
  }

  if (physicsState.ready && !state.physicsEnabled) {
    ui.physicsStatus.textContent = "Ammo.js: loaded (off)";
    ui.physicsStatus.dataset.state = "off";
    return;
  }

  ui.physicsStatus.textContent = "Ammo.js: not initialized";
  ui.physicsStatus.dataset.state = "off";
}

async function initializePhysics() {
  physicsState.loading = true;
  physicsState.error = null;
  refreshPhysicsStatus();

  try {
    const engine = new AmmoPhysicsEngine({
      sampleHeightAt: sampleSurfaceHeightAt,
      extraStaticColliders: staticPebbleColliders,
    });
    await engine.init();
    physicsEngine = engine;
    physicsState.loading = false;
    physicsState.ready = true;
    refreshPhysicsStatus();

    if (state.physicsEnabled) {
      rebuildPlant();
    }
  } catch (error) {
    physicsState.loading = false;
    physicsState.ready = false;
    physicsState.error = error;
    state.physicsEnabled = false;
    ui.physics.checked = false;
    ui.physics.disabled = true;
    refreshPhysicsStatus();
    console.warn("Ammo.js failed to initialize, using analytic fallback.", error);
  }
}

function syncOutputs() {
  ui.growthValue.textContent = Number(state.age).toFixed(3);
  ui.growthSpeedValue.textContent = state.growthSpeed.toFixed(2);
  ui.windValue.textContent = state.windStrength.toFixed(2);
  ui.fallingLeavesValue.textContent = String(state.maxConcurrentLeafFall);
  ui.branchingValue.textContent = state.branching.toFixed(2);
  ui.leafDensityValue.textContent = state.leafDensity.toFixed(2);
  ui.depthValue.textContent = String(state.maxDepth);
}

function rebuildPlant() {
  if (plant) {
    plant.dispose();
  }

  const activePhysics =
    state.physicsEnabled && physicsEngine && physicsState.ready
      ? physicsEngine
      : null;

  plant = new PlantSimulator(scene, {
    seed: state.seed,
    branching: state.branching,
    leafDensity: state.leafDensity,
    maxDepth: state.maxDepth,
    maxConcurrentLeafFall: state.maxConcurrentLeafFall,
    physics: activePhysics,
  });
}

function randomSeed() {
  state.seed = Math.floor(Math.random() * 900000) + 1;
  ui.seed.value = String(state.seed);
}

ui.growth.addEventListener("input", () => {
  state.age = Number(ui.growth.value);
  state.autoGrow = false;
  ui.autoGrow.checked = false;
  syncOutputs();
});

ui.autoGrow.addEventListener("change", () => {
  state.autoGrow = ui.autoGrow.checked;
});

ui.growthSpeed.addEventListener("input", () => {
  state.growthSpeed = Number(ui.growthSpeed.value);
  syncOutputs();
});

ui.wind.addEventListener("input", () => {
  state.windStrength = Number(ui.wind.value);
  syncOutputs();
});

ui.fallingLeaves.addEventListener("input", () => {
  state.maxConcurrentLeafFall = Math.max(
    0,
    Math.min(15, Math.round(Number(ui.fallingLeaves.value))),
  );
  if (plant) {
    plant.settings.maxConcurrentLeafFall = state.maxConcurrentLeafFall;
  }
  syncOutputs();
});

ui.physics.addEventListener("change", () => {
  state.physicsEnabled = ui.physics.checked;
  refreshPhysicsStatus();
  rebuildPlant();
});

ui.physicsDebug.addEventListener("change", () => {
  state.showPhysicsColliders = ui.physicsDebug.checked;
  physicsDebugOverlay.setEnabled(state.showPhysicsColliders);
});

ui.branching.addEventListener("input", () => {
  state.branching = Number(ui.branching.value);
  syncOutputs();
});

ui.leafDensity.addEventListener("input", () => {
  state.leafDensity = Number(ui.leafDensity.value);
  syncOutputs();
});

ui.depth.addEventListener("input", () => {
  state.maxDepth = Number(ui.depth.value);
  syncOutputs();
});

ui.seed.addEventListener("change", () => {
  const value = Number(ui.seed.value);
  if (!Number.isFinite(value) || value < 1) {
    state.seed = 1;
  } else {
    state.seed = Math.floor(value);
  }
  ui.seed.value = String(state.seed);
});

ui.regenerate.addEventListener("click", () => {
  state.age = 0;
  ui.growth.value = "0";
  syncOutputs();
  rebuildPlant();
});

ui.randomize.addEventListener("click", () => {
  randomSeed();
  state.age = 0;
  ui.growth.value = "0";
  syncOutputs();
  rebuildPlant();
});

const structuralControls = [ui.branching, ui.leafDensity, ui.depth, ui.seed];
for (let i = 0; i < structuralControls.length; i += 1) {
  structuralControls[i].addEventListener("change", () => {
    rebuildPlant();
  });
}

syncOutputs();
refreshPhysicsStatus();
physicsDebugOverlay.setEnabled(state.showPhysicsColliders);
rebuildPlant();
initializePhysics();

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const elapsed = clock.elapsedTime;

  if (state.autoGrow) {
    state.age = Math.min(1, state.age + dt * state.growthSpeed);
    ui.growth.value = state.age.toFixed(3);
    if (state.age >= 1) {
      state.autoGrow = false;
      ui.autoGrow.checked = false;
    }
    ui.growthValue.textContent = state.age.toFixed(3);
  }

  if (plant) {
    plant.update(elapsed, state.age, state.windStrength);
  }

  if (atmosphereParticles) {
    atmosphereParticles.rotation.y = elapsed * 0.02;
    atmosphereParticles.position.y = Math.sin(elapsed * 0.15) * 0.04;
  }

  physicsDebugOverlay.update(physicsEngine);

  controls.update();
  renderer.render(scene, camera);
}

animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

window.addEventListener("beforeunload", () => {
  physicsDebugOverlay.dispose();
  if (plant) {
    plant.dispose();
    plant = null;
  }
  if (physicsEngine) {
    physicsEngine.dispose();
    physicsEngine = null;
  }
});
