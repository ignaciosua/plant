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

function fract(value) {
  return value - Math.floor(value);
}

function noiseHash2(x, y, seed = 0) {
  return fract(Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123);
}

function noise2(x, y, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const n00 = noiseHash2(ix, iy, seed);
  const n10 = noiseHash2(ix + 1, iy, seed);
  const n01 = noiseHash2(ix, iy + 1, seed);
  const n11 = noiseHash2(ix + 1, iy + 1, seed);
  const nx0 = THREE.MathUtils.lerp(n00, n10, ux);
  const nx1 = THREE.MathUtils.lerp(n01, n11, ux);
  return THREE.MathUtils.lerp(nx0, nx1, uy);
}

function fbm2(x, y, seed = 0, octaves = 4) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let sum = 0;
  for (let i = 0; i < octaves; i += 1) {
    value += noise2(x * frequency, y * frequency, seed + i * 19.37) * amplitude;
    sum += amplitude;
    frequency *= 2;
    amplitude *= 0.5;
  }
  return sum > 0 ? value / sum : 0;
}

function clampByte(value) {
  return Math.round(THREE.MathUtils.clamp(value, 0, 255));
}

function createProceduralTexture(
  rendererRef,
  size,
  {
    repeatX = 1,
    repeatY = 1,
    anisotropy = 8,
    colorSpace = null,
  } = {},
  sampler,
) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const image = context.createImageData(size, size);
  const data = image.data;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const index = (y * size + x) * 4;
      const pixel = sampler(u, v, x, y);
      data[index] = clampByte(pixel.r);
      data[index + 1] = clampByte(pixel.g);
      data[index + 2] = clampByte(pixel.b);
      data[index + 3] = clampByte(
        Number.isFinite(pixel.a) ? pixel.a : 255,
      );
    }
  }

  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  const maxAnisotropy =
    rendererRef &&
    rendererRef.capabilities &&
    typeof rendererRef.capabilities.getMaxAnisotropy === "function"
      ? rendererRef.capabilities.getMaxAnisotropy()
      : 1;
  texture.anisotropy = Math.max(1, Math.min(maxAnisotropy, anisotropy));
  if (colorSpace) {
    texture.colorSpace = colorSpace;
  }
  texture.needsUpdate = true;
  return texture;
}

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
renderer.toneMappingExposure = 1.2;

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

const hemiLight = new THREE.HemisphereLight(0xd9f4ff, 0x64513c, 1.34);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight(0xfff2d6, 2.85);
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

const rimLight = new THREE.DirectionalLight(0xc2ebff, 0.86);
rimLight.position.set(-5.5, 4.6, -3.4);
scene.add(rimLight);

const fillLight = new THREE.DirectionalLight(0xc8dcff, 0.62);
fillLight.position.set(-2.5, 3.4, 4.8);
scene.add(fillLight);

function createVisualTextures(rendererRef) {
  const groundMap = createProceduralTexture(
    rendererRef,
    512,
    {
      repeatX: 8,
      repeatY: 8,
      anisotropy: 12,
      colorSpace: THREE.SRGBColorSpace,
    },
    (u, v) => {
      const broad = fbm2(u * 4.2, v * 4.2, 7, 4);
      const detail = fbm2(u * 26, v * 26, 13, 3);
      const moss = smooth01((broad - 0.56) / 0.28);
      const base = 86 + broad * 40;
      const r = base - 14 + detail * 14 + moss * 10;
      const g = base + 17 + detail * 16 + moss * 28;
      const b = base - 10 + detail * 12 - moss * 4;
      return { r, g, b, a: 255 };
    },
  );

  const groundRoughnessMap = createProceduralTexture(
    rendererRef,
    256,
    {
      repeatX: 8,
      repeatY: 8,
      anisotropy: 8,
    },
    (u, v) => {
      const roughNoise = fbm2(u * 22, v * 22, 29, 3);
      const rough = 190 + roughNoise * 55;
      return { r: rough, g: rough, b: rough, a: 255 };
    },
  );

  const soilMap = createProceduralTexture(
    rendererRef,
    384,
    {
      repeatX: 3,
      repeatY: 2,
      anisotropy: 10,
      colorSpace: THREE.SRGBColorSpace,
    },
    (u, v) => {
      const broad = fbm2(u * 6.4, v * 5.1, 41, 4);
      const grit = fbm2(u * 34, v * 28, 53, 3);
      const base = 62 + broad * 52;
      const r = base + 18 + grit * 18;
      const g = base + 5 + grit * 10;
      const b = base - 8 + grit * 8;
      return { r, g, b, a: 255 };
    },
  );

  const pebbleMap = createProceduralTexture(
    rendererRef,
    256,
    {
      repeatX: 2,
      repeatY: 2,
      anisotropy: 6,
      colorSpace: THREE.SRGBColorSpace,
    },
    (u, v) => {
      const n = fbm2(u * 12, v * 12, 67, 4);
      const p = fbm2(u * 44, v * 44, 73, 2);
      const base = 118 + n * 52;
      const r = base + p * 8;
      const g = base + p * 6;
      const b = base - 6 + p * 5;
      return { r, g, b, a: 255 };
    },
  );

  const barkMap = createProceduralTexture(
    rendererRef,
    512,
    {
      repeatX: 2.3,
      repeatY: 5.8,
      anisotropy: 10,
      colorSpace: THREE.SRGBColorSpace,
    },
    (u, v) => {
      const waviness = fbm2(v * 4.5, u * 2.2, 89, 3) * 0.08;
      const stripe = Math.abs(Math.sin((u + waviness) * 62));
      const grain = fbm2(u * 42, v * 12, 97, 4);
      const base = 82 + grain * 68 - stripe * 14;
      const r = base + 27;
      const g = base + 18;
      const b = base + 7;
      return { r, g, b, a: 255 };
    },
  );

  const leafMap = createProceduralTexture(
    rendererRef,
    512,
    {
      repeatX: 1,
      repeatY: 1,
      anisotropy: 8,
      colorSpace: THREE.SRGBColorSpace,
    },
    (u, v) => {
      const center = 1 - Math.min(1, Math.abs(u - 0.5) * 2);
      const veinMain = Math.exp(-Math.pow((u - 0.5) * 18, 2));
      const sideVeins = Math.max(0, Math.sin(v * 38 + (u - 0.5) * 32));
      const mottling = fbm2(u * 20, v * 26, 113, 3);
      const base = 178 + v * 44 + mottling * 24;
      const r = base + 4 + veinMain * 16;
      const g = base + 18 + veinMain * 26 + sideVeins * center * 8;
      const b = base - 24 + veinMain * 10;
      return { r, g, b, a: 255 };
    },
  );

  const textures = [
    groundMap,
    groundRoughnessMap,
    soilMap,
    pebbleMap,
    barkMap,
    leafMap,
  ];

  return {
    groundMap,
    groundRoughnessMap,
    soilMap,
    pebbleMap,
    barkMap,
    leafMap,
    dispose() {
      for (let i = 0; i < textures.length; i += 1) {
        textures[i].dispose();
      }
    },
  };
}

function createGroundContactShadow(sceneRef) {
  const shadowTexture = createProceduralTexture(
    renderer,
    256,
    {
      repeatX: 1,
      repeatY: 1,
      anisotropy: 2,
      colorSpace: THREE.SRGBColorSpace,
    },
    (u, v) => {
      const dx = u - 0.5;
      const dy = v - 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const alpha = THREE.MathUtils.clamp(1 - dist * 2.05, 0, 1);
      const soft = Math.pow(alpha, 1.85) * 200;
      return { r: 28, g: 32, b: 22, a: soft };
    },
  );
  shadowTexture.wrapS = THREE.ClampToEdgeWrapping;
  shadowTexture.wrapT = THREE.ClampToEdgeWrapping;

  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: shadowTexture,
    transparent: true,
    depthWrite: false,
    opacity: 0.34,
  });
  const shadowMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2.2, 2.2),
    shadowMaterial,
  );
  shadowMesh.rotation.x = -Math.PI / 2;
  shadowMesh.position.set(0, sampleSurfaceHeightAt(0, 0) + 0.012, 0);
  shadowMesh.renderOrder = 2;
  sceneRef.add(shadowMesh);

  return {
    mesh: shadowMesh,
    material: shadowMaterial,
    texture: shadowTexture,
  };
}

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

const visualTextures = createVisualTextures(renderer);

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
    color: 0xffffff,
    map: visualTextures.groundMap,
    roughnessMap: visualTextures.groundRoughnessMap,
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });

  const ground = new THREE.Mesh(geometry, groundMaterial);
  ground.receiveShadow = true;
  scene.add(ground);

  const soilGeometry = new THREE.CylinderGeometry(0.55, 0.86, 0.34, 52, 5, false);
  const soilPos = soilGeometry.attributes.position;
  let soilMaxRadius = 0;
  for (let i = 0; i < soilPos.count; i += 1) {
    const vx = soilPos.getX(i);
    const vy = soilPos.getY(i);
    const vz = soilPos.getZ(i);
    const radial = Math.sqrt(vx * vx + vz * vz);
    if (radial > soilMaxRadius) {
      soilMaxRadius = radial;
    }
    const bump = Math.sin(vx * 18) * Math.cos(vz * 16) * 0.008;
    if (vy > 0.02) {
      soilPos.setY(i, vy + Math.max(0, 0.07 - radial * 0.08) + bump);
    } else {
      soilPos.setY(i, vy + bump * 0.7);
    }
  }
  soilGeometry.computeVertexNormals();
  soilGeometry.computeBoundingBox();
  const soilBounds = soilGeometry.boundingBox;
  const soilHalfHeight =
    soilBounds ? Math.max(0.001, (soilBounds.max.y - soilBounds.min.y) * 0.5) : 0.2;
  const soilCenterYOffset = soilBounds ? (soilBounds.max.y + soilBounds.min.y) * 0.5 : 0;
  const soilBaseY = 0.12;

  const soil = new THREE.Mesh(
    soilGeometry,
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: visualTextures.soilMap,
      roughness: 1,
      metalness: 0,
    }),
  );
  soil.position.set(0, soilBaseY, 0);
  soil.castShadow = true;
  soil.receiveShadow = true;
  scene.add(soil);

  const pebbleGeometry = new THREE.IcosahedronGeometry(0.05, 0);
  pebbleGeometry.computeBoundingBox();
  const pebbleBounds = pebbleGeometry.boundingBox;
  const pebbleHalfBase = new THREE.Vector3(
    pebbleBounds
      ? Math.max(0.001, (pebbleBounds.max.x - pebbleBounds.min.x) * 0.5)
      : 0.05,
    pebbleBounds
      ? Math.max(0.001, (pebbleBounds.max.y - pebbleBounds.min.y) * 0.5)
      : 0.05,
    pebbleBounds
      ? Math.max(0.001, (pebbleBounds.max.z - pebbleBounds.min.z) * 0.5)
      : 0.05,
  );
  const pebbleMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: visualTextures.pebbleMap,
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

    pebbleColliders.push({
      type: "box",
      center: {
        x: posVec.x,
        y: posVec.y,
        z: posVec.z,
      },
      halfExtents: {
        x: pebbleHalfBase.x * scale.x,
        y: pebbleHalfBase.y * scale.y,
        z: pebbleHalfBase.z * scale.z,
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
    extraColliders: [
      {
        type: "cylinder",
        center: { x: 0, y: soilBaseY + soilCenterYOffset, z: 0 },
        radius: Math.max(0.01, soilMaxRadius),
        height: Math.max(0.01, soilHalfHeight * 2),
        friction: 1.02,
        restitution: 0.02,
      },
      ...pebbleColliders,
    ],
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
const groundContactShadow = createGroundContactShadow(scene);
const staticExtraColliders =
  groundData && Array.isArray(groundData.extraColliders)
    ? groundData.extraColliders
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

const _closestSegTmpA = new THREE.Vector3();
const _closestSegTmpB = new THREE.Vector3();
const _closestSegTmpR = new THREE.Vector3();

function closestPointsOnSegments(a0, a1, b0, b1, outA, outB) {
  const d1 = _closestSegTmpA.copy(a1).sub(a0);
  const d2 = _closestSegTmpB.copy(b1).sub(b0);
  const r = _closestSegTmpR.copy(a0).sub(b0);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  const EPS = 1e-10;

  let s = 0;
  let t = 0;

  if (a <= EPS && e <= EPS) {
    outA.copy(a0);
    outB.copy(b0);
    return;
  }

  if (a <= EPS) {
    s = 0;
    t = THREE.MathUtils.clamp(f / e, 0, 1);
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      t = 0;
      s = THREE.MathUtils.clamp(-c / a, 0, 1);
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      if (Math.abs(denom) > EPS) {
        s = THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1);
      } else {
        s = 0;
      }

      const tnom = b * s + f;
      if (tnom < 0) {
        t = 0;
        s = THREE.MathUtils.clamp(-c / a, 0, 1);
      } else if (tnom > e) {
        t = 1;
        s = THREE.MathUtils.clamp((b - c) / a, 0, 1);
      } else {
        t = tnom / e;
      }
    }
  }

  outA.copy(a0).addScaledVector(d1, s);
  outB.copy(b0).addScaledVector(d2, t);
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
    this.settings.branchLeafSpread = THREE.MathUtils.clamp(
      Number.isFinite(this.settings.branchLeafSpread)
        ? this.settings.branchLeafSpread
        : 0.45,
      0,
      1,
    );
    this.settings.branchSag = THREE.MathUtils.clamp(
      Number.isFinite(this.settings.branchSag) ? this.settings.branchSag : 0.28,
      0,
      1,
    );
    this.settings.branchCollision = THREE.MathUtils.clamp(
      Number.isFinite(this.settings.branchCollision) ? this.settings.branchCollision : 0.72,
      0,
      1,
    );
    this.settings.showJointCaps = this.settings.showJointCaps !== false;
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
    this._lifecycleStartTime = null;
    this._lastPlantColliderSyncTime = null;
    this._plantColliderSyncInterval = 1 / 30;
    this._maxAttachedLeafColliders = 160;
    this.physics = settings.physics || null;
    this._leafCollisionWorldA = new THREE.Vector3();
    this._leafCollisionWorldB = new THREE.Vector3();
    this._leafCollisionLocal = new THREE.Vector3();
    this._leafCollisionInvQuat = new THREE.Quaternion();

    this.segmentGeometry = new THREE.CylinderGeometry(
      CYLINDER_TOP_RADIUS,
      CYLINDER_BASE_RADIUS,
      1,
      22,
      1,
      false,
    );
    this.segmentGeometry.translate(0, 0.5, 0);
    this.segmentJointGeometry = new THREE.SphereGeometry(1, 18, 14);

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
        0.26 + (this.rng() - 0.5) * 0.012,
        0.2 + this.rng() * 0.08,
        0.31 + heightTone * 0.19 - radial * 0.018 + this.rng() * 0.05,
      );
      stemColors[i * 3] = stemColor.r;
      stemColors[i * 3 + 1] = stemColor.g;
      stemColors[i * 3 + 2] = stemColor.b;
    }
    this.segmentGeometry.setAttribute("color", new THREE.BufferAttribute(stemColors, 3));
    const jointPos = this.segmentJointGeometry.attributes.position;
    const jointColors = new Float32Array(jointPos.count * 3);
    const jointColor = new THREE.Color();
    for (let i = 0; i < jointPos.count; i += 1) {
      const x = jointPos.getX(i);
      const y = jointPos.getY(i);
      const z = jointPos.getZ(i);
      const radial = Math.sqrt(x * x + z * z);
      const heightTone = THREE.MathUtils.clamp((y + 1) * 0.5, 0, 1);
      jointColor.setHSL(
        0.265,
        0.22,
        0.285 + heightTone * 0.105 - radial * 0.04,
      );
      jointColor.multiplyScalar(0.9);
      jointColors[i * 3] = jointColor.r;
      jointColors[i * 3 + 1] = jointColor.g;
      jointColors[i * 3 + 2] = jointColor.b;
    }
    this.segmentJointGeometry.setAttribute("color", new THREE.BufferAttribute(jointColors, 3));

    this.leafGeometry = createLeafGeometry();

    this.stemMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: visualTextures.barkMap,
      roughness: 0.72,
      metalness: 0.02,
      clearcoat: 0.16,
      clearcoatRoughness: 0.65,
      emissive: 0x24170f,
      emissiveIntensity: 0.045,
      vertexColors: true,
    });
    this.stemJointMaterial = this.stemMaterial.clone();
    this.stemJointMaterial.clearcoat = 0.06;
    this.stemJointMaterial.clearcoatRoughness = 0.88;
    this.stemJointMaterial.emissiveIntensity = 0.03;

    this.leafMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: visualTextures.leafMap,
      roughness: 0.56,
      metalness: 0.01,
      clearcoat: 0.11,
      clearcoatRoughness: 0.75,
      transmission: 0.08,
      thickness: 0.24,
      side: THREE.DoubleSide,
      emissive: 0x102214,
      emissiveIntensity: 0.07,
      vertexColors: true,
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
    this.refreshSegmentLoadFactors();
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
      const branchLeafSpread = THREE.MathUtils.clamp(
        this.settings.branchLeafSpread,
        0,
        1,
      );
      const tipRamp = Math.pow(
        smooth01((tipProgress - 0.08) / 0.92),
        THREE.MathUtils.lerp(1.35, 0.62, branchLeafSpread),
      );
      const tipBaseWeight = THREE.MathUtils.lerp(0.2, 0.62, branchLeafSpread);
      const tipWeight = THREE.MathUtils.clamp(
        tipBaseWeight + (1 - tipBaseWeight) * tipRamp,
        0.08,
        1,
      );
      const depthWeightBase = THREE.MathUtils.clamp(
        0.25 + depthRatio * 0.85,
        0,
        1,
      );
      const depthWeightSpread = THREE.MathUtils.clamp(
        0.45 + depthRatio * 0.55,
        0,
        1,
      );
      const depthWeight = THREE.MathUtils.lerp(
        depthWeightBase,
        depthWeightSpread,
        branchLeafSpread,
      );
      const trunkPenalty = depth === 0
        ? THREE.MathUtils.lerp(0.08, 0.16, branchLeafSpread)
        : depth === 1
          ? THREE.MathUtils.lerp(0.6, 0.95, branchLeafSpread)
          : 1;
      const midBranchBias =
        smooth01((tipProgress - 0.18) / 0.46) *
        (1 - smooth01((tipProgress - 0.7) / 0.3));
      const interiorBoost = 1 + branchLeafSpread * midBranchBias * 0.38;
      const leafChance = THREE.MathUtils.clamp(
        this.settings.leafDensity *
          (0.32 + depthWeight * 0.9) *
          tipWeight *
          trunkPenalty *
          interiorBoost,
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
      // Hacer que la hoja de punta nazca cerca del final de la rama evita
      // "pops" cuando aparecen ramas largas en etapas tardías.
      const tipLeafBirth = birthStart + growthSpan * (0.72 + this.rng() * 0.12);
      const tipLeafEmergenceDuration = Math.max(
        0.62,
        growthSpan * (0.62 + this.rng() * 0.24),
      );

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
        tipLeafEmergenceDuration,
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
        tipLeafEmergenceDuration,
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

  lockLeafGrowthOnCollision(leaf) {
    if (!leaf || leaf.isDetaching || leaf.collisionForceDetach) {
      return;
    }
    const currentGrowth = THREE.MathUtils.clamp(
      Number.isFinite(leaf.currentGrowth) ? leaf.currentGrowth : 0,
      0,
      1,
    );
    const freezeAt = Math.max(0.2, currentGrowth);
    leaf.collisionGrowthLimit = Math.min(
      Number.isFinite(leaf.collisionGrowthLimit) ? leaf.collisionGrowthLimit : 1,
      freezeAt,
    );
  }

  _applyLeafCollisionNudge(leaf, worldNudge, scale = 1) {
    if (
      !leaf ||
      !leaf.anchorSegment ||
      !leaf.anchorCollisionOffsetLocal ||
      leaf.isDetaching
    ) {
      return;
    }

    const nudgeScale = THREE.MathUtils.clamp(scale, 0, 0.9);
    if (nudgeScale <= 1e-5 || worldNudge.lengthSq() <= 1e-12) {
      return;
    }

    this._leafCollisionInvQuat.copy(leaf.anchorSegment.pivot.quaternion).invert();
    this._leafCollisionLocal
      .copy(worldNudge)
      .applyQuaternion(this._leafCollisionInvQuat);

    leaf.anchorCollisionOffsetLocal.addScaledVector(
      this._leafCollisionLocal,
      nudgeScale,
    );

    const maxOffset = THREE.MathUtils.clamp(
      0.006 + (leaf.finalScale?.y || 0.22) * 0.045,
      0.009,
      0.028,
    );
    const offsetLen = leaf.anchorCollisionOffsetLocal.length();
    if (offsetLen > maxOffset) {
      leaf.anchorCollisionOffsetLocal.multiplyScalar(maxOffset / offsetLen);
    }

    leaf.anchorAxialOffset = THREE.MathUtils.clamp(
      leaf.anchorAxialOffset || 0,
      -0.03,
      0.03,
    );
  }

  resolveLeafCollisionShape(a, b, distSq, collisionRadius, sameAnchor = false) {
    if (!a || !b || a.isDetaching || b.isDetaching) {
      return;
    }
    if (!a.anchorSegment || !b.anchorSegment) {
      return;
    }

    this._leafCollisionWorldA.copy(b.pivot.position).sub(a.pivot.position);
    let dist = Math.sqrt(Math.max(distSq, 1e-12));
    if (dist < 1e-5) {
      const fallbackA = a.anchorSurfaceLocal
        ? this._leafCollisionWorldB
            .copy(a.anchorSurfaceLocal)
            .applyQuaternion(a.anchorSegment.pivot.quaternion)
        : this._leafCollisionWorldB.set(1, 0, 0);
      const fallbackB = b.anchorSurfaceLocal
        ? this._leafCollisionWorldA
            .copy(b.anchorSurfaceLocal)
            .applyQuaternion(b.anchorSegment.pivot.quaternion)
        : this._leafCollisionWorldA.set(-1, 0, 0);
      this._leafCollisionWorldA.copy(fallbackB).sub(fallbackA);
      if (this._leafCollisionWorldA.lengthSq() < 1e-8) {
        this._leafCollisionWorldA.set(1, 0, 0);
      }
      this._leafCollisionWorldA.normalize();
      dist = 0;
    } else {
      this._leafCollisionWorldA.multiplyScalar(1 / dist);
    }

    const overlap = collisionRadius - dist;
    if (overlap <= 0) {
      return;
    }

    const aPriority = Number.isFinite(a.tipPriority) ? a.tipPriority : 0.5;
    const bPriority = Number.isFinite(b.tipPriority) ? b.tipPriority : 0.5;
    const moveA = THREE.MathUtils.clamp(
      0.5 + (bPriority - aPriority) * 0.34,
      0.18,
      0.82,
    );
    const moveB = 1 - moveA;
    const sameAnchorScale = sameAnchor ? 0.56 : 1;
    const pushMagnitude = overlap * 0.2 * sameAnchorScale;

    this._leafCollisionWorldB
      .copy(this._leafCollisionWorldA)
      .multiplyScalar(-pushMagnitude * moveA);
    this._applyLeafCollisionNudge(a, this._leafCollisionWorldB, 1);

    this._leafCollisionWorldB
      .copy(this._leafCollisionWorldA)
      .multiplyScalar(pushMagnitude * moveB);
    this._applyLeafCollisionNudge(b, this._leafCollisionWorldB, 1);
  }

  /**
   * When a new leaf is placed, freeze growth for nearby leaves so they stop
   * expanding into each other.
   */
  triggerCollisionFalls(newPosition, newAnchorSegment) {
    const COLLISION_RADIUS = 0.06; // local-space distance threshold
    const COLLISION_RADIUS_SQ = COLLISION_RADIUS * COLLISION_RADIUS;

    for (let i = 0; i < this.leaves.length; i += 1) {
      const leaf = this.leaves[i];
      if (leaf.isDetaching) continue;
      if (newAnchorSegment && leaf.anchorSegment === newAnchorSegment) continue;
      const distSq = leaf.pivot.position.distanceToSquared(newPosition);
      if (distSq < COLLISION_RADIUS_SQ && distSq > 0.00001) {
        this.lockLeafGrowthOnCollision(leaf);
      }
    }
  }

  /**
   * Runtime collision check:
   * - overlap normal: congela crecimiento para evitar interpenetración.
   * - overlap fuerte entre hojas ya maduras: fuerza caída de la menos prioritaria.
   */
  checkRuntimeCollisions() {
    const COLLISION_RADIUS = 0.06;
    const COLLISION_RADIUS_SQ = COLLISION_RADIUS * COLLISION_RADIUS;
    const HARD_OVERLAP_RADIUS = 0.045;
    const HARD_OVERLAP_RADIUS_SQ = HARD_OVERLAP_RADIUS * HARD_OVERLAP_RADIUS;
    const invCellSize = 1 / (COLLISION_RADIUS * 1.35);
    const buckets = new Map();
    const activeIndices = [];
    const neighborOffsets = [];

    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          neighborOffsets.push([dx, dy, dz]);
        }
      }
    }

    for (let i = 0; i < this.leaves.length; i += 1) {
      const leaf = this.leaves[i];
      if (leaf.isDetaching) continue;
      if (leaf.mesh.scale.x < 0.01) continue;
      const cx = Math.floor(leaf.pivot.position.x * invCellSize);
      const cy = Math.floor(leaf.pivot.position.y * invCellSize);
      const cz = Math.floor(leaf.pivot.position.z * invCellSize);
      leaf._collisionCellX = cx;
      leaf._collisionCellY = cy;
      leaf._collisionCellZ = cz;
      const key = `${cx}|${cy}|${cz}`;
      if (!buckets.has(key)) {
        buckets.set(key, []);
      }
      buckets.get(key).push(i);
      activeIndices.push(i);
    }

    for (let n = 0; n < activeIndices.length; n += 1) {
      const i = activeIndices[n];
      const a = this.leaves[i];
      const ax = a._collisionCellX;
      const ay = a._collisionCellY;
      const az = a._collisionCellZ;

      for (let k = 0; k < neighborOffsets.length; k += 1) {
        const offset = neighborOffsets[k];
        const key = `${ax + offset[0]}|${ay + offset[1]}|${az + offset[2]}`;
        const bucket = buckets.get(key);
        if (!bucket) {
          continue;
        }

        for (let bIndex = 0; bIndex < bucket.length; bIndex += 1) {
          const j = bucket[bIndex];
          if (j <= i) {
            continue;
          }
          const b = this.leaves[j];
          if (!b || b.isDetaching || b.mesh.scale.x < 0.01) {
            continue;
          }
          const sameAnchor = a.anchorSegment && a.anchorSegment === b.anchorSegment;

          const distSq = a.pivot.position.distanceToSquared(b.pivot.position);
          if (distSq >= COLLISION_RADIUS_SQ || distSq <= 0.00001) {
            continue;
          }

          this.lockLeafGrowthOnCollision(a);
          this.lockLeafGrowthOnCollision(b);
          this.resolveLeafCollisionShape(
            a,
            b,
            distSq,
            COLLISION_RADIUS,
            Boolean(sameAnchor),
          );

          const aGrowth = THREE.MathUtils.clamp(
            Number.isFinite(a.currentGrowth) ? a.currentGrowth : 0,
            0,
            1,
          );
          const bGrowth = THREE.MathUtils.clamp(
            Number.isFinite(b.currentGrowth) ? b.currentGrowth : 0,
            0,
            1,
          );
          if (
            !sameAnchor &&
            distSq < HARD_OVERLAP_RADIUS_SQ &&
            aGrowth > 0.82 &&
            bGrowth > 0.82
          ) {
            const aPriority = Number.isFinite(a.tipPriority) ? a.tipPriority : 0.5;
            const bPriority = Number.isFinite(b.tipPriority) ? b.tipPriority : 0.5;
            let drop = null;
            if (Math.abs(aPriority - bPriority) > 0.03) {
              drop = aPriority < bPriority ? a : b;
            } else {
              drop = (a.birth || 0) <= (b.birth || 0) ? a : b;
            }
            if (drop && !drop.isDetaching && !drop.collisionForceDetach) {
              drop.collisionForceDetach = true;
              drop.isDetaching = true;
            }
          }
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
    emergenceDurationOverride = null,
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
        emergenceDurationOverride,
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

  refreshSegmentLoadFactors() {
    for (let i = 0; i < this.segments.length; i += 1) {
      const segment = this.segments[i];
      segment.subtreeLoad =
        (segment.directLeafLoad || 0) * 0.85 +
        segment.finalLength * (0.3 + segment.finalRadius * 4.2);
    }

    for (let i = this.segments.length - 1; i >= 0; i -= 1) {
      const segment = this.segments[i];
      if (segment.children && segment.children.length > 0) {
        for (let c = 0; c < segment.children.length; c += 1) {
          const child = segment.children[c];
          segment.subtreeLoad += (child.subtreeLoad || 0) * 0.84;
        }
      }
      const depthWeight = 1 + Math.max(0, segment.depth - 1) * 0.14;
      segment.bendLoadFactor = THREE.MathUtils.clamp(
        (segment.subtreeLoad || 0) * 0.13 * depthWeight,
        0.08,
        3.6,
      );
    }
  }

  isSegmentAncestor(candidateAncestor, segment) {
    if (!candidateAncestor || !segment) {
      return false;
    }
    let current = segment.parentSegment || null;
    while (current) {
      if (current === candidateAncestor) {
        return true;
      }
      current = current.parentSegment || null;
    }
    return false;
  }

  areSegmentsRelated(a, b) {
    if (!a || !b) {
      return false;
    }
    if (a === b) {
      return true;
    }
    return this.isSegmentAncestor(a, b) || this.isSegmentAncestor(b, a);
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

    let jointCap = null;
    if (parentSegment) {
      jointCap = new THREE.Mesh(this.segmentJointGeometry, this.stemJointMaterial);
      jointCap.castShadow = false;
      jointCap.receiveShadow = true;
      jointCap.scale.set(0.0001, 0.0001, 0.0001);
      jointCap.visible = false;
      pivot.add(jointCap);
    }

    const tipCap = new THREE.Mesh(this.segmentJointGeometry, this.stemMaterial);
    tipCap.castShadow = false;
    tipCap.receiveShadow = true;
    tipCap.scale.set(0.0001, 0.0001, 0.0001);
    tipCap.visible = false;
    pivot.add(tipCap);

    this.group.add(pivot);
    const baseQuaternion = pivot.quaternion.clone();
    const localQuaternion = parentSegment
      ? parentSegment.baseQuaternion.clone().invert().multiply(baseQuaternion.clone())
      : null;
    const gravityAxisWorld = new THREE.Vector3().crossVectors(directionNormalized, DOWN);
    if (gravityAxisWorld.lengthSq() < 1e-6) {
      gravityAxisWorld.set(this.rng() < 0.5 ? -1 : 1, 0, 0);
    }
    gravityAxisWorld.normalize();
    const inverseBaseQuaternion = baseQuaternion.clone().invert();
    const gravityAxisLocal = gravityAxisWorld
      .clone()
      .applyQuaternion(inverseBaseQuaternion)
      .normalize();
    const swayAmplitudeBase = (0.008 + depth * 0.0052) * (0.85 + this.rng() * 0.6);
    const parentSwayAmplitude = parentSegment ? parentSegment.swayAmplitude || 0 : 0;
    const inheritedSway = parentSwayAmplitude * (0.9 + this.rng() * 0.22);
    const swayAmplitude = parentSegment
      ? Math.max(swayAmplitudeBase * 0.68, inheritedSway)
      : swayAmplitudeBase;
    const swayPhase = parentSegment
      ? parentSegment.swayPhase + (this.rng() - 0.5) * 0.38
      : this.rng() * TAU;
    const isMainTrunk = depth === 0;

    const segment = {
      pivot,
      mesh,
      jointCap,
      tipCap,
      baseQuaternion,
      localQuaternion,
      jointBlendFactor: parentSegment && localQuaternion
        ? smooth01(
            (2 * Math.acos(THREE.MathUtils.clamp(Math.abs(localQuaternion.w), 0, 1)) - 0.06) /
              0.38,
          )
        : 0,
      start: start.clone(),
      birth,
      duration,
      finalRadius: radius * 0.43,
      finalLength: length,
      baseOffset: 0,
      depth,
      parentSegment,
      tipPosition: start.clone(),
      currentGrowth: 0,
      currentLength: 0,
      renderLength: 0,
      baseOverlap: 0,
      currentBaseRadius: 0,
      currentTopRadius: 0,
      swayAmplitude: isMainTrunk ? 0 : swayAmplitude,
      swayPhase: isMainTrunk ? 0 : swayPhase,
      gravityAxisLocal,
      gravityFlex: isMainTrunk ? 0 : (0.14 + this.rng() * 0.14),
      maxGravityBend: isMainTrunk ? 0 : (0.08 + this.rng() * 0.1),
      groundAvoidanceBend: isMainTrunk ? 0 : (0.03 + this.rng() * 0.03),
      children: [],
      directLeafLoad: 0,
      bendLoadFactor: 0.08,
      collisionCorrectionQuat: new THREE.Quaternion(),
      collisionCorrectionLimit: isMainTrunk
        ? 0
        : THREE.MathUtils.clamp(0.26 + depth * 0.08 + this.rng() * 0.12, 0.26, 0.95),
    };
    if (parentSegment) {
      parentSegment.children.push(segment);
    }
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
    emergenceDurationOverride = null,
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

    const depthNorm = THREE.MathUtils.clamp(
      depth / Math.max(1, this.settings.maxDepth),
      0,
      1,
    );
    const centerLeafBoost = THREE.MathUtils.lerp(1.34, 0.9, depthNorm);
    const lengthScale = THREE.MathUtils.clamp(
      (0.28 + this.rng() * 0.26) * centerLeafBoost,
      0.24,
      0.78,
    );
    const widthScale = lengthScale * (0.56 + this.rng() * 0.45);
    const thicknessScale = lengthScale * (0.82 + this.rng() * 0.32);
    const tipGuard = smooth01(
      (THREE.MathUtils.clamp(tipPriority, 0, 1) - 0.72) / 0.28,
    );
    const ramificationPruneBias = THREE.MathUtils.clamp(
      (1 - depthNorm) * (1 - tipGuard) * (0.82 + this.rng() * 0.26),
      0,
      1,
    );
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

    const lifeGrowDuration = 1.85 + this.rng() * 1.2;
    const lifeMatureDuration = 4.1 + this.rng() * 4.2;
    const lifeSenescenceDuration = 1.7 + this.rng() * 1.5;
    const lifeFallDuration = 2 + this.rng() * 1.8;
    const lifeDormancyDuration = 1.7 + this.rng() * 2.2;
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

    const emergenceDuration = Number.isFinite(emergenceDurationOverride) &&
      emergenceDurationOverride > 0
      ? emergenceDurationOverride
      : 0.62 + this.rng() * 0.45 + Math.min(0.28, depth * 0.05);

    if (anchorSegment) {
      const leafLoadContribution = THREE.MathUtils.clamp(
        (lengthScale * widthScale) * 3.2,
        0.12,
        1.25,
      );
      anchorSegment.directLeafLoad =
        (anchorSegment.directLeafLoad || 0) + leafLoadContribution;
    }

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
      duration: emergenceDuration,
      finalScale: new THREE.Vector3(widthScale, lengthScale, thicknessScale),
      depth,
      swayAmplitude: 0.1 + this.rng() * 0.18,
      swayPhase: this.rng() * TAU,
      bendBase: 0.08 + this.rng() * 0.12,
      bendAvoid: crowding * (0.22 + this.rng() * 0.26),
      colorVariance,
      tipPriority: THREE.MathUtils.clamp(tipPriority, 0, 1),
      ramificationPruneBias,
      collisionGrowthLimit: 1,
      currentGrowth: 0,
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
      anchorCollisionOffsetLocal: new THREE.Vector3(),
      physicsHandle: null,
      physicsLockedScale: null,
    });

    // Freeze growth immediately if this leaf spawns overlapping neighbors.
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
      const phase = Math.min(
        lifeTime,
        leaf.lifeCycleDuration - 0.0001,
      );
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
        // Hoja terminal persistente: evita puntas vacías, pero en lugar de
        // reaparecer de golpe vuelve a brotar con una fase de crecimiento.
        hidden = false;
        groundDecay = 0;
        if (phase >= fallEnd) {
          const regrowT = THREE.MathUtils.clamp(
            (phase - fallEnd) / Math.max(0.0001, hiddenEnd - fallEnd),
            0,
            1,
          );
          stage = "grow";
          senescence *= 0.2;
          fall = Math.min(fall, 0.16 * (1 - regrowT));
          lifeScale = smooth01(regrowT);
        } else {
          fall = Math.min(fall, 0.05);
          senescence *= 0.32;
          lifeScale = Math.max(lifeScale, 0.14 + smooth01(age) * 0.18);
        }
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

        // Poda estructural: al aumentar ramificaciones, hojas grandes del centro
        // envejecen y caen antes para abrir espacio a brotes nuevos.
        const pruneBias = THREE.MathUtils.clamp(
          leaf.ramificationPruneBias || 0,
          0,
          1,
        );
        if (pruneBias > 0.08) {
          const structuralStart = THREE.MathUtils.lerp(0.64, 0.28, pruneBias);
          if (age > structuralStart) {
            const structuralDuration = Math.max(0.1, 0.74 - pruneBias * 0.36);
            const structuralProgress = THREE.MathUtils.clamp(
              (age - structuralStart) / structuralDuration,
              0,
              1,
            );
            const structuralFall = smooth01((structuralProgress - 0.18) / 0.52) * pruneBias;
            senescence = Math.max(
              senescence,
              structuralProgress * (0.65 + pruneBias * 0.35),
            );
            fall = Math.max(fall, structuralFall);
            lifeScale = Math.min(
              lifeScale,
              Math.max(0, 1 - structuralProgress * (0.5 + pruneBias * 0.42)),
            );

            if (structuralProgress > 0.72) {
              stage = "ground";
              fall = 1;
              groundDecay = Math.max(
                groundDecay,
                smooth01((structuralProgress - 0.72) / 0.28),
              );
            }
            if (structuralProgress > 0.995) {
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
    const segmentDirectionWorld = new THREE.Vector3();
    const segmentDesiredDirection = new THREE.Vector3();
    const segmentLimitedDirection = new THREE.Vector3();
    const segmentCollisionPush = new THREE.Vector3();
    const segmentCollisionClosest = new THREE.Vector3();
    const segmentCollisionClosestOther = new THREE.Vector3();
    const segmentCollisionDelta = new THREE.Vector3();
    const segmentCollisionFallback = new THREE.Vector3();
    const segmentCurrentDir = new THREE.Vector3();
    const segmentOtherDir = new THREE.Vector3();
    const segmentCorrectionQuat = new THREE.Quaternion();
    const segmentPreCorrectionQuat = new THREE.Quaternion();
    const segmentLocalCorrectionQuat = new THREE.Quaternion();
    const segmentPersistentBlendQuat = new THREE.Quaternion();
    const identityQuat = new THREE.Quaternion(0, 0, 0, 1);
    const leafBranchClosest = new THREE.Vector3();
    const leafBranchDelta = new THREE.Vector3();
    const plantColliders = [];
    const evaluatedBranchColliders = [];
    const deltaSeconds =
      this.lastUpdateTime === null
        ? 0
        : THREE.MathUtils.clamp(elapsedSeconds - this.lastUpdateTime, 0, 0.12);
    this.lastUpdateTime = elapsedSeconds;
    if (this._lifecycleStartTime === null || elapsedSeconds < this._lifecycleStartTime) {
      this._lifecycleStartTime = elapsedSeconds;
    }
    const lifecycleElapsedSeconds = Math.max(0, elapsedSeconds - this._lifecycleStartTime);

    // Mantener tronco estable: sin rotación/traslación global por viento.
    // El aleteo se aplica solo en ramas finales más adelante.
    this.group.rotation.y = 0;
    this.group.position.x = 0;
    const structuralCorrectionWeight = smooth01((0.985 - age) / 0.32);
    const structuralCorrectionsEnabled = structuralCorrectionWeight > 0.0005;

    for (let i = 0; i < this.segments.length; i += 1) {
      this.segments[i].runtimeLeafLoad = 0;
      this.segments[i].runtimeDirectLeafLoad = 0;
    }
    for (let i = 0; i < this.leaves.length; i += 1) {
      const leaf = this.leaves[i];
      if (!leaf.anchorSegment || leaf.isDetaching) {
        continue;
      }
      const growthWeight = THREE.MathUtils.clamp(leaf.currentGrowth || 0, 0, 1);
      if (growthWeight <= 1e-4) {
        continue;
      }
      const scaleX = leaf.finalScale?.x || 0.2;
      const scaleY = leaf.finalScale?.y || 0.25;
      const leafLoad = growthWeight * THREE.MathUtils.clamp(scaleX * scaleY * 2.9, 0.04, 1.2);
      leaf.anchorSegment.runtimeLeafLoad += leafLoad;
      leaf.anchorSegment.runtimeDirectLeafLoad += leafLoad;
    }
    for (let i = this.segments.length - 1; i >= 0; i -= 1) {
      const segment = this.segments[i];
      let propagated = segment.runtimeLeafLoad || 0;
      if (segment.children && segment.children.length > 0) {
        for (let c = 0; c < segment.children.length; c += 1) {
          propagated += (segment.children[c].runtimeLeafLoad || 0) * 0.82;
        }
      }
      segment.runtimeLeafLoad = propagated;
    }

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
      segment.currentGrowth = growth;
      const currentBaseRadius = segment.finalRadius * radialGrowth;
      const isTrunkSegment = segment.depth === 0;
      const overlapBlend = isTrunkSegment
        ? 0
        : THREE.MathUtils.clamp(segment.jointBlendFactor || 0, 0, 1);
      const overlapBase = Math.min(
        grownLength * 0.11,
        Math.max(0.0012, currentBaseRadius * 0.32),
      );
      const connectionOverlap =
        segment.parentSegment && overlapBlend > 0.12
          ? overlapBase * overlapBlend
          : 0;
      const renderedLength = grownLength + connectionOverlap;

      if (segment.parentSegment) {
        segment.pivot.position.copy(segment.parentSegment.tipPosition);
      } else {
        segment.pivot.position.copy(segment.start);
      }

      segment.mesh.scale.set(currentBaseRadius, renderedLength, currentBaseRadius);
      segment.currentLength = grownLength;
      segment.renderLength = renderedLength;
      segment.baseOverlap = connectionOverlap;
      segment.mesh.position.y = grownLength * segment.baseOffset - connectionOverlap;
      if (segment.jointCap) {
        const jointScale = Math.max(
          0.0001,
          currentBaseRadius * THREE.MathUtils.lerp(1.015, 1.055, overlapBlend),
        );
        segment.jointCap.scale.set(jointScale, jointScale, jointScale);
        segment.jointCap.position.set(0, 0, 0);
        segment.jointCap.visible =
          Boolean(this.settings.showJointCaps) &&
          !isTrunkSegment &&
          growth > 0.04 &&
          overlapBlend > 0.2;
      }

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

      if (segment.depth !== 0) {
        const branchSag = THREE.MathUtils.clamp(this.settings.branchSag ?? 0.28, 0, 1);
        const depthNorm = THREE.MathUtils.clamp(
          segment.depth / Math.max(1, this.settings.maxDepth),
          0,
          1,
        );
        const depthSagFactor = THREE.MathUtils.lerp(
          0.06,
          1.26,
          Math.pow(depthNorm, 1.6),
        );
        const dynamicLoadBoost = THREE.MathUtils.clamp(
          1 + (segment.runtimeLeafLoad || 0) * 0.16 * structuralCorrectionWeight,
          1,
          1.45,
        );
        const gravityBend =
          branchSag *
          segment.gravityFlex *
          (segment.bendLoadFactor || 0.08) *
          dynamicLoadBoost *
          depthSagFactor *
          (0.24 + growth * 0.76) *
          (0.25 + plantMaturity * 0.75);
        const gravityAngle = THREE.MathUtils.clamp(
          gravityBend,
          0,
          segment.maxGravityBend || 0.28,
        );
        if (gravityAngle > 1e-6) {
          swayQuatA.setFromAxisAngle(segment.gravityAxisLocal, gravityAngle);
          segment.pivot.quaternion.multiply(swayQuatA);
        }

        tipWorld
          .set(0, segment.mesh.position.y + renderedLength, 0)
          .applyQuaternion(segment.pivot.quaternion)
          .add(segment.pivot.position);
        const terrainY = sampleSurfaceHeightAt(tipWorld.x, tipWorld.z) + 0.055;
        if (tipWorld.y < terrainY) {
          const penetration = THREE.MathUtils.clamp(
            (terrainY - tipWorld.y) / Math.max(0.05, grownLength * 0.55),
            0,
            1,
          );
          const liftAngle =
            penetration *
            (segment.groundAvoidanceBend || 0.05) *
            structuralCorrectionWeight;
          if (liftAngle > 1e-6) {
            swayQuatB.setFromAxisAngle(segment.gravityAxisLocal, -liftAngle);
            segment.pivot.quaternion.multiply(swayQuatB);
          }
        }

        if (segment.collisionCorrectionQuat) {
          segment.pivot.quaternion
            .multiply(segment.collisionCorrectionQuat)
            .normalize();
        }
      }

      // Aplicar sway solo en ramas finales/tips para evitar "rotación" del tronco.
      if (segment.depth !== 0) {
        const maxDepth = Math.max(1, this.settings.maxDepth);
        const depthNorm = THREE.MathUtils.clamp(segment.depth / maxDepth, 0, 1);
        const isTerminalBranch = !segment.children || segment.children.length === 0;
        const isNearCanopy = segment.depth >= maxDepth - 1;
        const topologyBoost = isTerminalBranch ? 1.45 : isNearCanopy ? 0.92 : 0.36;
        const tipAttenuation = Math.pow(depthNorm, 1.75);
        const trunkAttenuation = THREE.MathUtils.lerp(
          0.04,
          1,
          Math.pow(depthNorm, 2.2),
        );
        const directLeafMask = THREE.MathUtils.clamp(
          (segment.runtimeDirectLeafLoad || 0) * 1.8,
          0,
          1,
        );
        const supportLeafMask = THREE.MathUtils.clamp(
          (segment.runtimeLeafLoad || 0) * 0.42,
          0,
          0.55,
        );
        const tipDrivenMask = THREE.MathUtils.clamp(
          tipAttenuation * topologyBoost,
          0,
          1.9,
        );
        const leafDrivenMask = THREE.MathUtils.clamp(
          (directLeafMask * 1.0 + supportLeafMask * 0.55) *
            (0.28 + tipAttenuation * 0.9),
          0,
          1.2,
        );
        const terminalMinMask = isTerminalBranch
          ? THREE.MathUtils.lerp(0, 0.2, smooth01((depthNorm - 0.45) / 0.45))
          : 0;
        const swayMask = Math.max(
          Math.max(tipDrivenMask, leafDrivenMask) * trunkAttenuation,
          terminalMinMask,
        );

        if (swayMask > 0.004) {
          const windResponse = windStrength * (0.32 + windStrength * 1.28);
          const depthGain = 0.68 + depthNorm * 0.44;
          const swayAmount =
            Math.sin(elapsedSeconds * 0.92 + segment.swayPhase) *
            segment.swayAmplitude *
            windResponse *
            depthGain *
            swayMask *
            growth;

          swayQuatA.setFromAxisAngle(AXIS_Z, swayAmount);
          swayQuatB.setFromAxisAngle(AXIS_X, swayAmount * 0.55);
          segment.pivot.quaternion.multiply(swayQuatA).multiply(swayQuatB);
        }
      }

      segment.currentBaseRadius = currentBaseRadius;
      segment.currentTopRadius = segment.currentBaseRadius * CYLINDER_TAPER;
      if (segment.tipCap) {
        const tipScale = Math.max(0.0001, segment.currentTopRadius * 1.08);
        segment.tipCap.scale.set(tipScale, tipScale, tipScale);
        segment.tipCap.position.set(0, segment.mesh.position.y + renderedLength, 0);
        let hasVisibleChild = false;
        if (segment.children && segment.children.length > 0) {
          for (let c = 0; c < segment.children.length; c += 1) {
            if ((segment.children[c].currentGrowth || 0) > 0.06) {
              hasVisibleChild = true;
              break;
            }
          }
        }
        segment.tipCap.visible = growth > 0.06 && !hasVisibleChild;
      }

      const segmentCollisionRadius = Math.max(
        0.0035,
        Math.max(segment.currentBaseRadius, segment.currentTopRadius),
      );
      tipWorld
        .set(0, segment.mesh.position.y + renderedLength, 0)
        .applyQuaternion(segment.pivot.quaternion)
        .add(segment.pivot.position);

      if (
        structuralCorrectionsEnabled &&
        segment.depth !== 0 &&
        evaluatedBranchColliders.length > 0
      ) {
        const branchCollision = THREE.MathUtils.clamp(
          (this.settings.branchCollision ?? 0.72) * structuralCorrectionWeight,
          0,
          1,
        );
        if (branchCollision > 0.001) {
          const depthNorm = THREE.MathUtils.clamp(
            segment.depth / Math.max(1, this.settings.maxDepth),
            0,
            1,
          );
          const depthCollisionFactor = THREE.MathUtils.lerp(
            0.35,
            1.12,
            Math.pow(depthNorm, 1.25),
          );
          const branchCollisionPasses = 2;
          for (let pass = 0; pass < branchCollisionPasses; pass += 1) {
            segmentCollisionPush.set(0, 0, 0);

            for (let c = 0; c < evaluatedBranchColliders.length; c += 1) {
              const other = evaluatedBranchColliders[c];
              if (this.areSegmentsRelated(segment, other.segment)) {
                continue;
              }
              if (other.segment.depth === 0 && segment.depth <= 1) {
                continue;
              }

              const currentLenSq = tipWorld.distanceToSquared(segment.pivot.position);
              const otherLenSq = other.tip.distanceToSquared(other.base);
              if (currentLenSq < 1e-10 || otherLenSq < 1e-10) {
                continue;
              }

              closestPointsOnSegments(
                segment.pivot.position,
                tipWorld,
                other.base,
                other.tip,
                segmentCollisionClosest,
                segmentCollisionClosestOther,
              );

              segmentCollisionDelta
                .copy(segmentCollisionClosest)
                .sub(segmentCollisionClosestOther);
              const distSq = segmentCollisionDelta.lengthSq();
              const minDist =
                (segmentCollisionRadius + other.radius) *
                THREE.MathUtils.lerp(0.88, 1.22, branchCollision);
              if (distSq >= minDist * minDist) {
                continue;
              }

              let dist = Math.sqrt(Math.max(distSq, 1e-12));
              if (dist < 1e-5) {
                segmentCurrentDir
                  .copy(tipWorld)
                  .sub(segment.pivot.position)
                  .normalize();
                segmentOtherDir
                  .copy(other.tip)
                  .sub(other.base)
                  .normalize();

                segmentCollisionFallback
                  .copy(segmentCurrentDir)
                  .cross(segmentOtherDir);
                if (segmentCollisionFallback.lengthSq() < 1e-8) {
                  segmentCollisionFallback
                    .copy(segmentCurrentDir)
                    .cross(UP);
                }
                if (segmentCollisionFallback.lengthSq() < 1e-8) {
                  segmentCollisionFallback.set(1, 0, 0);
                }
                segmentCollisionDelta.copy(segmentCollisionFallback).normalize();
                dist = 0;
              } else {
                segmentCollisionDelta.multiplyScalar(1 / dist);
              }

              const penetration = minDist - dist;
              if (penetration > 0) {
                segmentCollisionPush.addScaledVector(
                  segmentCollisionDelta,
                  penetration * (0.95 + branchCollision * 1.35),
                );
              }
            }

            const pushLen = segmentCollisionPush.length();
            if (pushLen <= 1e-6) {
              break;
            }

            const maxPush =
              grownLength *
              (0.14 + branchCollision * 0.48) *
              depthCollisionFactor *
              smooth01((growth - 0.03) / 0.97);
            if (pushLen > maxPush) {
              segmentCollisionPush.multiplyScalar(maxPush / pushLen);
            }

            segmentDesiredDirection
              .copy(tipWorld)
              .add(segmentCollisionPush)
              .sub(segment.pivot.position);
            if (segmentDesiredDirection.lengthSq() <= 1e-8) {
              continue;
            }
            segmentDesiredDirection.normalize();
            segmentDirectionWorld
              .set(0, 1, 0)
              .applyQuaternion(segment.pivot.quaternion)
              .normalize();
            const dirDot = THREE.MathUtils.clamp(
              segmentDirectionWorld.dot(segmentDesiredDirection),
              -1,
              1,
            );
            const dirAngle = Math.acos(dirDot);
            const maxCorrectionAngle =
              (0.11 + branchCollision * 0.32) *
              depthCollisionFactor *
              smooth01((growth - 0.03) / 0.97);

            if (dirAngle <= 1e-5) {
              continue;
            }

            if (dirAngle > maxCorrectionAngle && maxCorrectionAngle > 0) {
              segmentLimitedDirection
                .copy(segmentDirectionWorld)
                .lerp(segmentDesiredDirection, maxCorrectionAngle / dirAngle)
                .normalize();
            } else {
              segmentLimitedDirection.copy(segmentDesiredDirection);
            }
            segmentCorrectionQuat.setFromUnitVectors(
              segmentDirectionWorld,
              segmentLimitedDirection,
            );
            segmentPreCorrectionQuat.copy(segment.pivot.quaternion);
            segment.pivot.quaternion.premultiply(segmentCorrectionQuat).normalize();

            tipWorld
              .copy(segmentLimitedDirection)
              .multiplyScalar(grownLength)
              .add(segment.pivot.position);

            if (
              segment.collisionCorrectionQuat &&
              segment.parentSegment
            ) {
              const persistence = THREE.MathUtils.clamp(
                (0.3 + branchCollision * 0.46) * depthCollisionFactor,
                0.16,
                0.88,
              );
              segmentLocalCorrectionQuat
                .copy(segmentPreCorrectionQuat)
                .invert()
                .multiply(segmentCorrectionQuat)
                .multiply(segmentPreCorrectionQuat)
                .normalize();
              segmentPersistentBlendQuat
                .set(0, 0, 0, 1)
                .slerp(segmentLocalCorrectionQuat, persistence);
              segment.collisionCorrectionQuat
                .multiply(segmentPersistentBlendQuat)
                .normalize();

              const corrW = THREE.MathUtils.clamp(
                segment.collisionCorrectionQuat.w,
                -1,
                1,
              );
              let corrAngle = 2 * Math.acos(corrW);
              if (corrAngle > Math.PI) {
                corrAngle = TAU - corrAngle;
              }
              const corrLimit = segment.collisionCorrectionLimit || 0.42;
              if (corrAngle > corrLimit && corrAngle > 1e-6) {
                const keep = corrLimit / corrAngle;
                segmentPersistentBlendQuat
                  .copy(identityQuat)
                  .slerp(segment.collisionCorrectionQuat, keep);
                segment.collisionCorrectionQuat.copy(segmentPersistentBlendQuat);
              }
            }
          }
        }
      }

      segment.tipPosition.copy(tipWorld);

      if (!segment._runtimeCollider) {
        segment._runtimeCollider = {
          base: new THREE.Vector3(),
          tip: new THREE.Vector3(),
          radius: 0,
          segment,
        };
      }
      segment._runtimeCollider.base.copy(segment.pivot.position);
      segment._runtimeCollider.tip.copy(tipWorld);
      segment._runtimeCollider.radius = segmentCollisionRadius;
      evaluatedBranchColliders.push(segment._runtimeCollider);
    }

    this.group.updateMatrixWorld();
    this.group.getWorldQuaternion(groupWorldQuaternion);
    inverseGroupWorldQuaternion.copy(groupWorldQuaternion).invert();

    if (this.physics && this.physics.ready) {
      const shouldSyncPlantColliders =
        this._lastPlantColliderSyncTime === null ||
        elapsedSeconds - this._lastPlantColliderSyncTime >=
          this._plantColliderSyncInterval;

      if (shouldSyncPlantColliders) {
        plantColliders.length = 0;
        for (let i = 0; i < this.segments.length; i += 1) {
          const segment = this.segments[i];
          const segmentLength = segment.currentLength || 0;
          if (segmentLength < 0.008) {
            continue;
          }

          const colliderRadius =
            Math.max(segment.currentTopRadius, segment.currentBaseRadius);
          if (colliderRadius < 0.006) {
            continue;
          }
          const colliderHeight = Math.max(0.008, segmentLength);

          segmentColliderLocal
            .set(
              0,
              segment.mesh.position.y +
                (segment.baseOverlap || 0) +
                segmentLength * 0.5,
              0,
            )
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

        // Colliders cinemáticos para hojas adheridas (mientras no estén cayendo).
        // Mejora cobertura de colisión y visualización en el debug overlay.
        let attachedLeafColliders = 0;
        for (let i = 0; i < this.leaves.length; i += 1) {
          if (attachedLeafColliders >= this._maxAttachedLeafColliders) {
            break;
          }
          const leaf = this.leaves[i];
          if (!leaf || leaf.isDetaching || leaf.physicsHandle) {
            continue;
          }
          const sx = leaf.mesh.scale.x || 0;
          const sy = leaf.mesh.scale.y || 0;
          const sz = leaf.mesh.scale.z || 0;
          const growthScale = Math.max(sx, sy, sz);
          if (growthScale < 0.015) {
            continue;
          }

          physicsPositionWorld.copy(leaf.pivot.position).applyMatrix4(this.group.matrixWorld);
          plantColliders.push({
            id: `leaf-${i}`,
            type: "sphere",
            x: physicsPositionWorld.x,
            y: physicsPositionWorld.y,
            z: physicsPositionWorld.z,
            radius: Math.max(
              0.0045,
              (leaf.collisionRadius || 0.01) * THREE.MathUtils.clamp(growthScale, 0.16, 1),
            ),
          });
          attachedLeafColliders += 1;
        }

        this.physics.syncPlantColliders(plantColliders);
        this._lastPlantColliderSyncTime = elapsedSeconds;
      }
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
    }

    const lifecycleStates = new Array(this.leaves.length);
    for (let i = 0; i < this.leaves.length; i += 1) {
      lifecycleStates[i] = this.computeLeafLifecycle(
        this.leaves[i],
        age,
        lifecycleElapsedSeconds,
      );
    }

    const hardConcurrentFallCap = THREE.MathUtils.clamp(
      Math.round(this.settings.maxConcurrentLeafFall ?? 12),
      0,
      15,
    );
    const flowNoise =
      Math.sin(lifecycleElapsedSeconds * 0.18 + this.settings.seed * 0.017) * 0.5 + 0.5;
    let preferredConcurrentFalling = 0;
    if (hardConcurrentFallCap > 0) {
      const preferredMin = Math.min(2, hardConcurrentFallCap);
      preferredConcurrentFalling = Math.round(
        THREE.MathUtils.lerp(preferredMin, hardConcurrentFallCap, flowNoise),
      );
    }
    if (hardConcurrentFallCap > 0 && windStrength > 0.82) {
      const gustNoise =
        Math.sin(lifecycleElapsedSeconds * 0.33 + this.settings.seed * 0.031) * 0.5 + 0.5;
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
      if (leaf.anchorCollisionOffsetLocal && !leaf.isDetaching) {
        leaf.anchorCollisionOffsetLocal.multiplyScalar(0.985);
      }

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

      if (
        structuralCorrectionsEnabled &&
        leaf.anchorSegment &&
        !leaf.isDetaching &&
        growth > 0.18 &&
        growth < 0.995 &&
        evaluatedBranchColliders.length > 0
      ) {
        const branchCollision = THREE.MathUtils.clamp(
          (this.settings.branchCollision ?? 0.72) * structuralCorrectionWeight,
          0,
          1,
        );
        if (branchCollision > 0.001) {
          const leafCollisionRadius = Math.max(
            0.006,
            (leaf.collisionRadius || 0.01) * THREE.MathUtils.clamp(growth, 0.22, 1),
          );
          let leafBranchHits = 0;

          for (let b = 0; b < evaluatedBranchColliders.length; b += 1) {
            const collider = evaluatedBranchColliders[b];
            if (!collider || !collider.segment) {
              continue;
            }
            if (this.areSegmentsRelated(leaf.anchorSegment, collider.segment)) {
              continue;
            }

            const segLenSq = collider.tip.distanceToSquared(collider.base);
            if (segLenSq < 1e-10) {
              continue;
            }

            closestPointsOnSegments(
              leaf.pivot.position,
              leaf.pivot.position,
              collider.base,
              collider.tip,
              leafBranchClosest,
              leafBranchDelta,
            );

            leafBranchDelta.copy(leaf.pivot.position).sub(leafBranchDelta);
            const distSq = leafBranchDelta.lengthSq();
            const minDist =
              leafCollisionRadius +
              collider.radius * THREE.MathUtils.lerp(0.9, 1.18, branchCollision);

            if (distSq >= minDist * minDist) {
              continue;
            }

            let dist = Math.sqrt(Math.max(distSq, 1e-12));
            if (dist < 1e-5) {
              leafBranchDelta
                .copy(leaf.pivot.position)
                .sub(collider.base);
              if (leafBranchDelta.lengthSq() < 1e-8) {
                leafBranchDelta.set(1, 0, 0);
              }
              leafBranchDelta.normalize();
              dist = 0;
            } else {
              leafBranchDelta.multiplyScalar(1 / dist);
            }

            const overlap = minDist - dist;
            if (overlap > 0) {
              leafBranchHits += 1;
              this.lockLeafGrowthOnCollision(leaf);
              if (leafBranchHits >= 4) {
                break;
              }
            }
          }

          if (leafBranchHits > 0) {
            // Mantener hojas pegadas a la rama: aquí solo congelamos crecimiento.
            // La separación espacial se resuelve con podado/caída en etapas posteriores.
          }
        }
      }

      const detached = Math.max(fall, groundDecay);
      let usedPhysicsTransform = false;
      let physicsBodyState = null;

      if (detached > 0) {
        if (leaf.anchorCollisionOffsetLocal) {
          leaf.anchorCollisionOffsetLocal.multiplyScalar(0.92);
        }
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
      const growthLimit = THREE.MathUtils.clamp(
        Number.isFinite(leaf.collisionGrowthLimit)
          ? leaf.collisionGrowthLimit
          : 1,
        0.0001,
        1,
      );
      const renderedGrowth = Math.min(growth, growthLimit) * scaleFade;

      leafTint
        .copy(LEAF_TINT_FRESH)
        .multiplyScalar(leaf.colorVariance || 1)
        .lerp(LEAF_TINT_YELLOW, yellowMix)
        .lerp(LEAF_TINT_BROWN, brownMix);
      leafEmissiveTint.copy(LEAF_EMISSIVE_FRESH).lerp(LEAF_EMISSIVE_DRY, brownMix);
      leaf.mesh.material.color.copy(leafTint);
      leaf.mesh.material.emissive.copy(leafEmissiveTint);
      leaf.mesh.material.opacity = THREE.MathUtils.clamp(0.96 * (1 - fadeMix), 0, 0.96);

      let scaleX = Math.max(0.0001, leaf.finalScale.x * renderedGrowth);
      let scaleY = Math.max(0.0001, leaf.finalScale.y * renderedGrowth);
      let scaleZ = Math.max(0.0001, leaf.finalScale.z * renderedGrowth);
      if (usedPhysicsTransform && leaf.physicsLockedScale) {
        scaleX = Math.max(0.0001, leaf.physicsLockedScale.x * scaleFade);
        scaleY = Math.max(0.0001, leaf.physicsLockedScale.y * scaleFade);
        scaleZ = Math.max(0.0001, leaf.physicsLockedScale.z * scaleFade);
      }
      leaf.mesh.scale.set(scaleX, scaleY, scaleZ);
      leaf.currentGrowth = THREE.MathUtils.clamp(renderedGrowth, 0, 1);
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
    this.segmentJointGeometry.dispose();
    this.leafGeometry.dispose();
    this.stemMaterial.dispose();
    this.stemJointMaterial.dispose();
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
  jointCaps: document.getElementById("jointCaps"),
  physicsStatus: document.getElementById("physicsStatus"),
  branching: document.getElementById("branching"),
  branchingValue: document.getElementById("branchingValue"),
  leafDensity: document.getElementById("leafDensity"),
  leafDensityValue: document.getElementById("leafDensityValue"),
  branchLeaves: document.getElementById("branchLeaves"),
  branchLeavesValue: document.getElementById("branchLeavesValue"),
  branchSag: document.getElementById("branchSag"),
  branchSagValue: document.getElementById("branchSagValue"),
  branchCollision: document.getElementById("branchCollision"),
  branchCollisionValue: document.getElementById("branchCollisionValue"),
  depth: document.getElementById("depth"),
  depthValue: document.getElementById("depthValue"),
  seed: document.getElementById("seed"),
  regenerate: document.getElementById("regenerate"),
  randomize: document.getElementById("randomize"),
  uiToggle: document.getElementById("uiToggle"),
};

const state = {
  age: 0,
  autoGrow: true,
  growthSpeed: Number(ui.growthSpeed.value),
  windStrength: Number(ui.wind.value),
  maxConcurrentLeafFall: Number(ui.fallingLeaves.value),
  physicsEnabled: Boolean(ui.physics.checked),
  showPhysicsColliders: Boolean(ui.physicsDebug.checked),
  showJointCaps: Boolean(ui.jointCaps.checked),
  branching: Number(ui.branching.value),
  leafDensity: Number(ui.leafDensity.value),
  branchLeafSpread: Number(ui.branchLeaves.value),
  branchSag: Number(ui.branchSag.value),
  branchCollision: Number(ui.branchCollision.value),
  maxDepth: Number(ui.depth.value),
  seed: Number(ui.seed.value),
};

const mobileUiQuery = window.matchMedia("(max-width: 760px)");
let uiPanelCollapsed = mobileUiQuery.matches;

function syncMobileUiState() {
  if (!ui.uiToggle) {
    return;
  }

  const isMobile = mobileUiQuery.matches;
  ui.uiToggle.hidden = !isMobile;

  if (!isMobile) {
    uiPanelCollapsed = false;
  }

  document.body.classList.toggle("ui-collapsed", isMobile && uiPanelCollapsed);
  const expanded = !(isMobile && uiPanelCollapsed);
  ui.uiToggle.setAttribute("aria-expanded", String(expanded));
  ui.uiToggle.setAttribute(
    "aria-label",
    expanded ? "Ocultar menú" : "Mostrar menú",
  );
}

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
      extraStaticColliders: staticExtraColliders,
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
  ui.branchLeavesValue.textContent = state.branchLeafSpread.toFixed(2);
  ui.branchSagValue.textContent = state.branchSag.toFixed(2);
  ui.branchCollisionValue.textContent = state.branchCollision.toFixed(2);
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
    branchLeafSpread: state.branchLeafSpread,
    branchSag: state.branchSag,
    branchCollision: state.branchCollision,
    showJointCaps: state.showJointCaps,
    maxDepth: state.maxDepth,
    maxConcurrentLeafFall: state.maxConcurrentLeafFall,
    physics: activePhysics,
  });
}

function randomSeed() {
  state.seed = Math.floor(Math.random() * 900000) + 1;
  ui.seed.value = String(state.seed);
}

function applySeedAutoGrowPreset() {
  state.age = 0;
  ui.growth.value = "0";
  state.autoGrow = true;
  ui.autoGrow.checked = true;
  state.growthSpeed = 0.09;
  ui.growthSpeed.value = "0.09";
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

ui.jointCaps.addEventListener("change", () => {
  state.showJointCaps = ui.jointCaps.checked;
  if (plant) {
    plant.settings.showJointCaps = state.showJointCaps;
  }
});

ui.branching.addEventListener("input", () => {
  state.branching = Number(ui.branching.value);
  syncOutputs();
});

ui.leafDensity.addEventListener("input", () => {
  state.leafDensity = Number(ui.leafDensity.value);
  syncOutputs();
});

ui.branchLeaves.addEventListener("input", () => {
  state.branchLeafSpread = Number(ui.branchLeaves.value);
  syncOutputs();
});

ui.branchSag.addEventListener("input", () => {
  state.branchSag = Number(ui.branchSag.value);
  if (plant) {
    plant.settings.branchSag = THREE.MathUtils.clamp(state.branchSag, 0, 1);
  }
  syncOutputs();
});

ui.branchCollision.addEventListener("input", () => {
  state.branchCollision = Number(ui.branchCollision.value);
  if (plant) {
    plant.settings.branchCollision = THREE.MathUtils.clamp(state.branchCollision, 0, 1);
  }
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
  applySeedAutoGrowPreset();
  syncOutputs();
});

ui.regenerate.addEventListener("click", () => {
  state.age = 0;
  ui.growth.value = "0";
  syncOutputs();
  rebuildPlant();
});

ui.randomize.addEventListener("click", () => {
  randomSeed();
  applySeedAutoGrowPreset();
  syncOutputs();
  rebuildPlant();
});

if (ui.uiToggle) {
  ui.uiToggle.addEventListener("click", () => {
    if (!mobileUiQuery.matches) {
      return;
    }
    uiPanelCollapsed = !uiPanelCollapsed;
    syncMobileUiState();
  });
}

if (typeof mobileUiQuery.addEventListener === "function") {
  mobileUiQuery.addEventListener("change", () => {
    if (!mobileUiQuery.matches) {
      uiPanelCollapsed = false;
    }
    syncMobileUiState();
  });
} else if (typeof mobileUiQuery.addListener === "function") {
  mobileUiQuery.addListener(() => {
    if (!mobileUiQuery.matches) {
      uiPanelCollapsed = false;
    }
    syncMobileUiState();
  });
}

const structuralControls = [ui.branching, ui.leafDensity, ui.branchLeaves, ui.depth, ui.seed];
for (let i = 0; i < structuralControls.length; i += 1) {
  structuralControls[i].addEventListener("change", () => {
    rebuildPlant();
  });
}

syncOutputs();
syncMobileUiState();
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

function disposeVisualAssets() {
  if (groundContactShadow) {
    scene.remove(groundContactShadow.mesh);
    if (groundContactShadow.mesh.geometry) {
      groundContactShadow.mesh.geometry.dispose();
    }
    groundContactShadow.material.dispose();
    groundContactShadow.texture.dispose();
  }
  visualTextures.dispose();
}

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
  disposeVisualAssets();
});
