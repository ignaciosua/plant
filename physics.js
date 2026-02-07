const STATIC_GROUP = 1;
const DYNAMIC_GROUP = 2;
const KINEMATIC_GROUP = 4;
const IDENTITY_QUATERNION = { x: 0, y: 0, z: 0, w: 1 };
const AMMO_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/ammo.js@0.0.10/ammo.js";

let ammoScriptPromise = null;

function radiusKey(radius) {
  return Number(radius).toFixed(4);
}

function quantizeLeafScale(value) {
  const v = Math.max(0.0005, Number(value) || 0.0005);
  return Math.round(v * 160) / 160;
}

function setShapeMarginIfSupported(shape, margin) {
  if (shape && typeof shape.setMargin === "function") {
    shape.setMargin(margin);
  }
}

function rotateOffsetByQuaternion(offset, quaternion) {
  const x = offset.x;
  const y = offset.y;
  const z = offset.z;
  const qx = quaternion.x;
  const qy = quaternion.y;
  const qz = quaternion.z;
  const qw = quaternion.w;

  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;

  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

function loadAmmoScriptIfNeeded() {
  if (
    (typeof globalThis.Ammo === "function") ||
    (globalThis.Ammo && typeof globalThis.Ammo.btVector3 === "function")
  ) {
    return Promise.resolve();
  }

  if (ammoScriptPromise) {
    return ammoScriptPromise;
  }

  ammoScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${AMMO_SCRIPT_URL}"]`);
    if (existing) {
      if (
        (typeof globalThis.Ammo === "function") ||
        (globalThis.Ammo && typeof globalThis.Ammo.btVector3 === "function")
      ) {
        resolve();
        return;
      }

      let timeoutId = null;
      const onLoad = () => {
        if (
          (typeof globalThis.Ammo === "function") ||
          (globalThis.Ammo && typeof globalThis.Ammo.btVector3 === "function")
        ) {
          if (timeoutId !== null) clearTimeout(timeoutId);
          resolve();
        } else {
          if (timeoutId !== null) clearTimeout(timeoutId);
          reject(new Error("Ammo.js script loaded but Ammo global was not found."));
        }
      };

      existing.addEventListener("load", onLoad, { once: true });
      existing.addEventListener(
        "error",
        () => {
          if (timeoutId !== null) clearTimeout(timeoutId);
          reject(new Error("Ammo.js script failed to load."));
        },
        { once: true },
      );
      timeoutId = window.setTimeout(() => {
        reject(new Error("Timeout waiting for Ammo.js script to load."));
      }, 10000);
      return;
    }

    const script = document.createElement("script");
    script.src = AMMO_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (
        (typeof globalThis.Ammo === "function") ||
        (globalThis.Ammo && typeof globalThis.Ammo.btVector3 === "function")
      ) {
        resolve();
      } else {
        reject(new Error("Ammo.js script loaded but Ammo global was not found."));
      }
    };
    script.onerror = () =>
      reject(new Error(`Failed to load Ammo.js script: ${AMMO_SCRIPT_URL}`));
    document.head.appendChild(script);
  });

  return ammoScriptPromise;
}

async function instantiateAmmo() {
  await loadAmmoScriptIfNeeded();

  if (globalThis.Ammo && typeof globalThis.Ammo.btVector3 === "function") {
    return globalThis.Ammo;
  }

  if (typeof globalThis.Ammo !== "function") {
    throw new Error("Ammo global factory not available after loading script.");
  }

  const result = globalThis.Ammo();
  if (result && typeof result.then === "function") {
    return await result;
  }

  if (result && result.ready && typeof result.ready.then === "function") {
    return await result.ready;
  }

  return result;
}

export class AmmoPhysicsEngine {
  constructor(options = {}) {
    this.sampleHeightAt =
      typeof options.sampleHeightAt === "function"
        ? options.sampleHeightAt
        : () => -0.28;
    this.fixedTimeStep = options.fixedTimeStep || 1 / 120;
    this.extraStaticColliders = Array.isArray(options.extraStaticColliders)
      ? options.extraStaticColliders
      : [];

    this.Ammo = null;
    this.ready = false;
    this.failed = false;
    this._initPromise = null;

    this.world = null;
    this.dispatcher = null;
    this.broadphase = null;
    this.solver = null;
    this.collisionConfig = null;

    this.tmpTransform = null;
    this.staticBodies = [];
    this.dynamicBodies = new Set();
    this.staticShapes = [];
    this.sphereShapes = new Map();
    this.leafShapeCache = new Map();
    this.plantShapeCache = new Map();
    this.plantBodies = new Map();
    this.terrainMesh = null;
    this.lastAerodynamicsTime = null;
    this.debugStaticColliders = [];
    this.debugPlantColliders = [];
  }

  async init() {
    if (this.ready) {
      return this;
    }
    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = (async () => {
      try {
        this.Ammo = await instantiateAmmo();
        if (!this.Ammo || typeof this.Ammo.btVector3 !== "function") {
          throw new Error("Loaded Ammo instance is invalid.");
        }
        this._createWorld();
        this._createStaticColliders();
        this.ready = true;
        return this;
      } catch (error) {
        this.failed = true;
        throw error;
      }
    })();

    return this._initPromise;
  }

  _createWorld() {
    const Ammo = this.Ammo;

    this.collisionConfig = new Ammo.btDefaultCollisionConfiguration();
    this.dispatcher = new Ammo.btCollisionDispatcher(this.collisionConfig);
    this.broadphase = new Ammo.btDbvtBroadphase();
    this.solver = new Ammo.btSequentialImpulseConstraintSolver();
    this.world = new Ammo.btDiscreteDynamicsWorld(
      this.dispatcher,
      this.broadphase,
      this.solver,
      this.collisionConfig,
    );

    const gravity = new Ammo.btVector3(0, -9.81, 0);
    this.world.setGravity(gravity);
    Ammo.destroy(gravity);

    this.tmpTransform = new Ammo.btTransform();
  }

  _createStaticColliders() {
    this.debugStaticColliders.length = 0;
    const Ammo = this.Ammo;
    const hasTriangleMesh =
      typeof Ammo.btTriangleMesh === "function" &&
      (typeof Ammo.btBvhTriangleMeshShape === "function" ||
        typeof Ammo.btTriangleMeshShape === "function");

    if (hasTriangleMesh) {
      this._addTerrainMesh();
    } else {
      const terrainCoverage = 7.2;
      const step = 0.48;
      const halfCells = Math.ceil(terrainCoverage / step);
      const thickness = 0.68;

      for (let gx = -halfCells; gx <= halfCells; gx += 1) {
        for (let gz = -halfCells; gz <= halfCells; gz += 1) {
          const centerX = gx * step;
          const centerZ = gz * step;
          const centerY = this.sampleHeightAt(centerX, centerZ);
          this._addStaticBox(
            { x: centerX, y: centerY - thickness * 0.5, z: centerZ },
            { x: step * 0.56, y: thickness * 0.5, z: step * 0.56 },
            0.98,
            0.02,
          );
        }
      }
    }

    // Capa de seguridad profunda para capturar cuerpos fuera de rango sin
    // interferir con la superficie visible ni ensuciar el debug.
    this._addStaticBox(
      { x: 0, y: -2.2, z: 0 },
      { x: 11.5, y: 1.4, z: 11.5 },
      0.96,
      0.01,
      false,
    );

    // Paredes laterales de la tierra para evitar caídas por el borde del montículo.
    this._addStaticCylinder({ x: 0, y: 0.12, z: 0 }, 0.86, 0.26, 1.02, 0.02);

    for (let i = 0; i < this.extraStaticColliders.length; i += 1) {
      const collider = this.extraStaticColliders[i];
      if (!collider) {
        continue;
      }

      if (collider.type === "box" && collider.center && collider.halfExtents) {
        this._addStaticBox(
          collider.center,
          collider.halfExtents,
          Number.isFinite(collider.friction) ? collider.friction : 0.94,
          Number.isFinite(collider.restitution) ? collider.restitution : 0.02,
          true,
          collider.quaternion || IDENTITY_QUATERNION,
        );
      } else if (
        collider.type === "cylinder" &&
        collider.center &&
        Number.isFinite(collider.radius) &&
        Number.isFinite(collider.height)
      ) {
        this._addStaticCylinder(
          collider.center,
          collider.radius,
          collider.height,
          Number.isFinite(collider.friction) ? collider.friction : 0.94,
          Number.isFinite(collider.restitution) ? collider.restitution : 0.02,
        );
      }
    }
  }

  _addTerrainMesh() {
    const Ammo = this.Ammo;

    // Malla triangular estática: sigue la misma función de altura del render.
    const resolution = 88;
    const size = 14;
    const step = size / resolution;
    const halfSize = size * 0.5;

    const vertices = [];
    const indices = [];
    const heights = new Float32Array((resolution + 1) * (resolution + 1));

    // Generar vértices
    for (let row = 0; row <= resolution; row++) {
      for (let col = 0; col <= resolution; col++) {
        const x = col * step - halfSize;
        const z = row * step - halfSize;
        const y = this.sampleHeightAt(x, z);
        vertices.push(x, y, z);
        heights[row * (resolution + 1) + col] = y;
      }
    }

    // Generar índices de triángulos
    for (let row = 0; row < resolution; row++) {
      for (let col = 0; col < resolution; col++) {
        const topLeft = row * (resolution + 1) + col;
        const topRight = topLeft + 1;
        const bottomLeft = (row + 1) * (resolution + 1) + col;
        const bottomRight = bottomLeft + 1;

        // Primer triángulo
        indices.push(topLeft, bottomLeft, topRight);
        // Segundo triángulo
        indices.push(topRight, bottomLeft, bottomRight);
      }
    }

    // Crear Bullet triangle mesh
    const triangleMesh = new Ammo.btTriangleMesh(true, false);

    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i] * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;

      const v0 = new Ammo.btVector3(vertices[i0], vertices[i0 + 1], vertices[i0 + 2]);
      const v1 = new Ammo.btVector3(vertices[i1], vertices[i1 + 1], vertices[i1 + 2]);
      const v2 = new Ammo.btVector3(vertices[i2], vertices[i2 + 1], vertices[i2 + 2]);

      triangleMesh.addTriangle(v0, v1, v2, false);

      Ammo.destroy(v0);
      Ammo.destroy(v1);
      Ammo.destroy(v2);
    }

    // Crear shape para la malla de triángulos
    let shape;
    if (typeof Ammo.btBvhTriangleMeshShape === "function") {
      shape = new Ammo.btBvhTriangleMeshShape(triangleMesh, true, true);
    } else {
      // Fallback para builds sin BVH.
      shape = new Ammo.btTriangleMeshShape(triangleMesh, true);
    }
    setShapeMarginIfSupported(shape, 0.001);

    this.staticShapes.push(shape);
    this.terrainMesh = triangleMesh;
    this.debugStaticColliders.push({
      type: "heightfield",
      size,
      resolution,
      heights,
    });

    this._addStaticBody(shape, { x: 0, y: 0, z: 0 }, IDENTITY_QUATERNION, 0.98, 0.02);
  }

  _addStaticBox(
    center,
    halfExtents,
    friction = 0.95,
    restitution = 0.02,
    debug = true,
    quaternion = IDENTITY_QUATERNION,
  ) {
    const Ammo = this.Ammo;
    const halfExtentsVector = new Ammo.btVector3(
      halfExtents.x,
      halfExtents.y,
      halfExtents.z,
    );
    const shape = new Ammo.btBoxShape(halfExtentsVector);
    Ammo.destroy(halfExtentsVector);
    setShapeMarginIfSupported(shape, 0.002);
    this.staticShapes.push(shape);
    if (debug) {
      this.debugStaticColliders.push({
        type: "box",
        center: { x: center.x, y: center.y, z: center.z },
        halfExtents: { x: halfExtents.x, y: halfExtents.y, z: halfExtents.z },
        quaternion: {
          x: quaternion.x,
          y: quaternion.y,
          z: quaternion.z,
          w: quaternion.w,
        },
      });
    }
    this._addStaticBody(shape, center, quaternion, friction, restitution);
  }

  _addStaticCylinder(
    center,
    radius,
    height,
    friction = 0.95,
    restitution = 0.02,
  ) {
    const Ammo = this.Ammo;
    const halfExtentsVector = new Ammo.btVector3(radius, height * 0.5, radius);
    const shape = new Ammo.btCylinderShape(halfExtentsVector);
    Ammo.destroy(halfExtentsVector);
    setShapeMarginIfSupported(shape, 0.002);
    this.staticShapes.push(shape);
    this.debugStaticColliders.push({
      type: "cylinder",
      center: { x: center.x, y: center.y, z: center.z },
      radius,
      height,
    });
    this._addStaticBody(shape, center, IDENTITY_QUATERNION, friction, restitution);
  }

  _addStaticBody(shape, center, quaternion, friction, restitution) {
    const Ammo = this.Ammo;

    const transform = new Ammo.btTransform();
    transform.setIdentity();
    const origin = new Ammo.btVector3(center.x, center.y, center.z);
    transform.setOrigin(origin);
    Ammo.destroy(origin);

    const rotation = new Ammo.btQuaternion(
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
    );
    transform.setRotation(rotation);
    Ammo.destroy(rotation);

    const motionState = new Ammo.btDefaultMotionState(transform);
    const localInertia = new Ammo.btVector3(0, 0, 0);
    const info = new Ammo.btRigidBodyConstructionInfo(
      0,
      motionState,
      shape,
      localInertia,
    );
    const body = new Ammo.btRigidBody(info);
    body.setFriction(friction);
    body.setRestitution(restitution);

    this.world.addRigidBody(body, STATIC_GROUP, STATIC_GROUP | DYNAMIC_GROUP);

    this.staticBodies.push({ body, motionState, info });

    Ammo.destroy(localInertia);
    Ammo.destroy(transform);
  }

  _getSphereShape(radius) {
    const key = radiusKey(radius);
    if (this.sphereShapes.has(key)) {
      return this.sphereShapes.get(key);
    }

    const shape = new this.Ammo.btSphereShape(radius);
    setShapeMarginIfSupported(shape, 0.002);
    this.sphereShapes.set(key, shape);
    return shape;
  }

  _getLeafShape(radius, leafGeometry = null, leafScale = null) {
    const Ammo = this.Ammo;

    const sx = quantizeLeafScale(
      leafScale && Number.isFinite(leafScale.x) ? leafScale.x : radius * 2.2,
    );
    const sy = quantizeLeafScale(
      leafScale && Number.isFinite(leafScale.y) ? leafScale.y : radius * 2.8,
    );
    const sz = quantizeLeafScale(
      leafScale && Number.isFinite(leafScale.z) ? leafScale.z : radius * 0.6,
    );

    const wantsHull =
      leafGeometry &&
      leafGeometry.attributes &&
      leafGeometry.attributes.position &&
      typeof Ammo.btConvexHullShape === "function";

    const keyPrefix = wantsHull ? "hull" : "box";
    const key = `${keyPrefix}:${sx}:${sy}:${sz}`;
    if (this.leafShapeCache.has(key)) {
      return this.leafShapeCache.get(key);
    }

    let shape = null;
    let kind = "box";
    let debugScale = null;
    let debugOffset = { x: 0, y: 0, z: 0 };
    let bodyOffset = { x: 0, y: 0, z: 0 };
    let destroyShapes = null;

    if (wantsHull) {
      const vertices = leafGeometry.attributes.position.array;
      const vertexCount = vertices.length / 3;
      const bounds = leafGeometry.boundingBox
        ? leafGeometry.boundingBox
        : null;
      const minX = bounds ? bounds.min.x * sx : -0.3 * sx;
      const maxX = bounds ? bounds.max.x * sx : 0.3 * sx;
      const minY = bounds ? bounds.min.y * sy : 0;
      const maxY = bounds ? bounds.max.y * sy : sy;
      const minZ = bounds ? bounds.min.z * sz : -0.08 * sz;
      const maxZ = bounds ? bounds.max.z * sz : 0.08 * sz;
      const centerX = (minX + maxX) * 0.5;
      const centerY = (minY + maxY) * 0.5;
      const centerZ = (minZ + maxZ) * 0.5;

      shape = new Ammo.btConvexHullShape();
      kind = "leaf";
      debugScale = { x: sx, y: sy, z: sz };
      // El rigid body usa su origen en torno al centro de masa aproximado
      // para evitar que la hoja "gire clavada" por la punta.
      bodyOffset = { x: centerX, y: centerY, z: centerZ };
      // El debug usa la geometría original (con pivote en la punta), así que
      // compensamos en sentido contrario para mantener coincidencia visual.
      debugOffset = { x: -centerX, y: -centerY, z: -centerZ };
      for (let i = 0; i < vertexCount; i += 1) {
        const x = vertices[i * 3] * sx - centerX;
        const y = vertices[i * 3 + 1] * sy - centerY;
        const z = vertices[i * 3 + 2] * sz - centerZ;
        const vertex = new Ammo.btVector3(x, y, z);
        shape.addPoint(vertex, true);
        Ammo.destroy(vertex);
      }
      setShapeMarginIfSupported(shape, 0.002);
      destroyShapes = [shape];
    } else {
      const bounds = leafGeometry && leafGeometry.boundingBox
        ? leafGeometry.boundingBox
        : null;
      const minX = bounds ? bounds.min.x * sx : -0.3 * sx;
      const maxX = bounds ? bounds.max.x * sx : 0.3 * sx;
      const minY = bounds ? bounds.min.y * sy : 0;
      const maxY = bounds ? bounds.max.y * sy : sy;
      const minZ = bounds ? bounds.min.z * sz : -0.08 * sz;
      const maxZ = bounds ? bounds.max.z * sz : 0.08 * sz;

      const sizeX = Math.max(0.0005, maxX - minX);
      const sizeY = Math.max(0.0005, maxY - minY);
      const sizeZ = Math.max(0.0005, maxZ - minZ);
      const centerX = (minX + maxX) * 0.5;
      const centerY = (minY + maxY) * 0.5;
      const centerZ = (minZ + maxZ) * 0.5;

      const halfExtents = new Ammo.btVector3(
        sizeX * 0.5,
        sizeY * 0.5,
        sizeZ * 0.5,
      );
      const boxShape = new Ammo.btBoxShape(halfExtents);
      Ammo.destroy(halfExtents);
      setShapeMarginIfSupported(boxShape, 0.002);

      debugScale = { x: sizeX, y: sizeY, z: sizeZ };
      debugOffset = { x: centerX, y: centerY, z: centerZ };

      const needsOffset =
        Math.abs(centerX) + Math.abs(centerY) + Math.abs(centerZ) > 1e-6 &&
        typeof Ammo.btCompoundShape === "function";

      if (needsOffset) {
        const compound = new Ammo.btCompoundShape();
        const localTransform = new Ammo.btTransform();
        localTransform.setIdentity();
        const localOrigin = new Ammo.btVector3(centerX, centerY, centerZ);
        localTransform.setOrigin(localOrigin);
        Ammo.destroy(localOrigin);
        compound.addChildShape(localTransform, boxShape);
        Ammo.destroy(localTransform);
        shape = compound;
        destroyShapes = [compound, boxShape];
      } else {
        // Sin compound shape, compensamos alineación moviendo el rigid body.
        // El debug no necesita offset porque la forma queda centrada en el body.
        bodyOffset = { x: centerX, y: centerY, z: centerZ };
        debugOffset = { x: 0, y: 0, z: 0 };
        shape = boxShape;
        destroyShapes = [boxShape];
      }
    }

    const descriptor = {
      shape,
      kind,
      debugScale,
      debugOffset,
      bodyOffset,
      destroyShapes,
    };
    this.leafShapeCache.set(key, descriptor);
    return descriptor;
  }

  _getPlantShapeDescriptor(collider) {
    const rawRadius = Math.max(0.002, Number(collider.radius) || 0.002);
    const radius = Math.max(0.002, Math.round(rawRadius * 120) / 120);
    const wantsCylinder = collider.type === "cylinder";
    const canUseCylinder = typeof this.Ammo.btCylinderShape === "function";
    const kind = wantsCylinder && canUseCylinder ? "cylinder" : "sphere";
    const rawHeight = Math.max(0.002, Number(collider.height) || rawRadius * 2);
    const height = Math.max(0.002, Math.round(rawHeight * 80) / 80);
    const key =
      kind === "cylinder"
        ? `cylinder:${radiusKey(radius)}:${Number(height).toFixed(4)}`
        : `sphere:${radiusKey(radius)}`;

    if (this.plantShapeCache.has(key)) {
      return this.plantShapeCache.get(key);
    }

    let shape = null;
    if (kind === "cylinder") {
      const halfExtents = new this.Ammo.btVector3(radius, height * 0.5, radius);
      shape = new this.Ammo.btCylinderShape(halfExtents);
      this.Ammo.destroy(halfExtents);
    } else {
      shape = new this.Ammo.btSphereShape(radius);
    }
    setShapeMarginIfSupported(shape, 0.0015);

    const descriptor = {
      key,
      kind,
      radius,
      height,
      shape,
    };
    this.plantShapeCache.set(key, descriptor);
    return descriptor;
  }

  clearPlantColliders() {
    if (!this.ready || !this.world || this.plantBodies.size === 0) {
      this.debugPlantColliders.length = 0;
      return;
    }

    for (const entry of this.plantBodies.values()) {
      this.world.removeRigidBody(entry.body);
      this.Ammo.destroy(entry.body);
      this.Ammo.destroy(entry.motionState);
      this.Ammo.destroy(entry.info);
    }
    this.plantBodies.clear();
    this.debugPlantColliders.length = 0;
  }

  syncPlantColliders(colliders) {
    if (!this.ready || !this.world) {
      return;
    }

    this.debugPlantColliders = colliders.map((collider) => ({
      type: collider.type === "cylinder" ? "cylinder" : "sphere",
      x: collider.x,
      y: collider.y,
      z: collider.z,
      radius: collider.radius,
      height: collider.height || collider.radius * 2,
      quaternion: collider.quaternion || { x: 0, y: 0, z: 0, w: 1 },
      scale:
        collider.type === "cylinder"
          ? {
            x: collider.radius * 2,
            y: collider.height,
            z: collider.radius * 2,
          }
          : undefined,
    }));

    const Ammo = this.Ammo;
    const seen = new Set();

    for (let i = 0; i < colliders.length; i += 1) {
      const collider = colliders[i];
      const id = String(collider.id);
      seen.add(id);

      let entry = this.plantBodies.get(id);
      const shapeDescriptor = this._getPlantShapeDescriptor(collider);
      if (entry && entry.shapeKey !== shapeDescriptor.key) {
        this.world.removeRigidBody(entry.body);
        Ammo.destroy(entry.body);
        Ammo.destroy(entry.motionState);
        Ammo.destroy(entry.info);
        this.plantBodies.delete(id);
        entry = null;
      }

      if (!entry) {
        const shape = shapeDescriptor.shape;
        const transform = new Ammo.btTransform();
        transform.setIdentity();
        const origin = new Ammo.btVector3(collider.x, collider.y, collider.z);
        transform.setOrigin(origin);
        Ammo.destroy(origin);
        const q = collider.quaternion || IDENTITY_QUATERNION;
        const rotation = new Ammo.btQuaternion(q.x, q.y, q.z, q.w);
        transform.setRotation(rotation);
        Ammo.destroy(rotation);

        const motionState = new Ammo.btDefaultMotionState(transform);
        const localInertia = new Ammo.btVector3(0, 0, 0);
        const info = new Ammo.btRigidBodyConstructionInfo(
          0,
          motionState,
          shape,
          localInertia,
        );
        const body = new Ammo.btRigidBody(info);

        const collisionFlags = body.getCollisionFlags();
        body.setCollisionFlags(collisionFlags | 2);
        body.setActivationState(4);
        body.setFriction(0.92);
        body.setRestitution(0.04);
        this.world.addRigidBody(body, KINEMATIC_GROUP, DYNAMIC_GROUP);

        entry = { body, motionState, info, shapeKey: shapeDescriptor.key };
        this.plantBodies.set(id, entry);

        Ammo.destroy(localInertia);
        Ammo.destroy(transform);
      }

      const updateTransform = new Ammo.btTransform();
      updateTransform.setIdentity();
      const updateOrigin = new Ammo.btVector3(collider.x, collider.y, collider.z);
      updateTransform.setOrigin(updateOrigin);
      Ammo.destroy(updateOrigin);
      const q = collider.quaternion || IDENTITY_QUATERNION;
      const updateRotation = new Ammo.btQuaternion(q.x, q.y, q.z, q.w);
      updateTransform.setRotation(updateRotation);
      Ammo.destroy(updateRotation);

      entry.body.setWorldTransform(updateTransform);
      entry.motionState.setWorldTransform(updateTransform);
      entry.body.activate();
      Ammo.destroy(updateTransform);
    }

    for (const [id, entry] of this.plantBodies.entries()) {
      if (!seen.has(id)) {
        this.world.removeRigidBody(entry.body);
        Ammo.destroy(entry.body);
        Ammo.destroy(entry.motionState);
        Ammo.destroy(entry.info);
        this.plantBodies.delete(id);
      }
    }
  }

  createLeafBody({
    position,
    quaternion,
    radius,
    mass = 0.006,
    initialVelocity,
    initialAngularVelocity,
    leafGeometry = null,
    leafScale = null,
    windPhase = Math.random() * Math.PI * 2,
  }) {
    if (!this.ready || !this.world) {
      return null;
    }

    const Ammo = this.Ammo;
    const shapeDescriptor = this._getLeafShape(radius, leafGeometry, leafScale);
    const shape = shapeDescriptor.shape;
    const bodyOffset = shapeDescriptor.bodyOffset || { x: 0, y: 0, z: 0 };
    const rotatedBodyOffset = rotateOffsetByQuaternion(bodyOffset, quaternion);

    const transform = new Ammo.btTransform();
    transform.setIdentity();

    const origin = new Ammo.btVector3(
      position.x + rotatedBodyOffset.x,
      position.y + rotatedBodyOffset.y,
      position.z + rotatedBodyOffset.z,
    );
    transform.setOrigin(origin);
    Ammo.destroy(origin);

    const rotation = new Ammo.btQuaternion(
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
    );
    transform.setRotation(rotation);
    Ammo.destroy(rotation);

    const motionState = new Ammo.btDefaultMotionState(transform);
    const localInertia = new Ammo.btVector3(0, 0, 0);
    shape.calculateLocalInertia(mass, localInertia);

    const info = new Ammo.btRigidBodyConstructionInfo(
      mass,
      motionState,
      shape,
      localInertia,
    );
    const body = new Ammo.btRigidBody(info);

    // Hoja ligera: contacto menos pegajoso para evitar que se "clave" sobre aristas.
    // La estabilización final se aplica de forma progresiva al acercarse al suelo.
    body.setFriction(0.58);
    body.setRestitution(0.02);
    body.setDamping(0.5, 0.28);
    if (typeof body.setRollingFriction === "function") {
      body.setRollingFriction(0.08);
    }
    if (typeof body.setSpinningFriction === "function") {
      body.setSpinningFriction(0.05);
    }
    if (typeof body.setSleepingThresholds === "function") {
      body.setSleepingThresholds(0.004, 0.004);
    }
    if (typeof body.setCcdMotionThreshold === "function") {
      body.setCcdMotionThreshold(Math.max(0.0001, radius * 0.15));
    }
    if (typeof body.setCcdSweptSphereRadius === "function") {
      body.setCcdSweptSphereRadius(Math.max(0.0001, radius * 0.6));
    }

    this.world.addRigidBody(
      body,
      DYNAMIC_GROUP,
      STATIC_GROUP | DYNAMIC_GROUP | KINEMATIC_GROUP,
    );

    if (initialVelocity) {
      const linearVelocity = new Ammo.btVector3(
        initialVelocity.x,
        initialVelocity.y,
        initialVelocity.z,
      );
      body.setLinearVelocity(linearVelocity);
      Ammo.destroy(linearVelocity);
    }

    if (initialAngularVelocity) {
      const angularVelocity = new Ammo.btVector3(
        initialAngularVelocity.x,
        initialAngularVelocity.y,
        initialAngularVelocity.z,
      );
      body.setAngularVelocity(angularVelocity);
      Ammo.destroy(angularVelocity);
    }

    const handle = {
      body,
      motionState,
      info,
      radius,
      shapeKind: shapeDescriptor.kind,
      debugScale: shapeDescriptor.debugScale,
      debugOffset: shapeDescriptor.debugOffset,
      bodyOffset,
      windPhase,
      dragArea: Math.max(0.002, Math.PI * radius * radius * 2.1),
      torqueScale: Math.max(0.00025, radius * radius * 0.17),
      dampingLinearBase: 0.5,
      dampingAngularBase: 0.28,
      groundStableTime: 0,
      groundLocked: false,
      groundLockDelay: 0.1,
      factorsFrozen: false,
    };
    this.dynamicBodies.add(handle);

    Ammo.destroy(localInertia);
    Ammo.destroy(transform);

    return handle;
  }

  applyLeafAerodynamics(elapsedSeconds, windStrength = 1) {
    if (!this.ready || !this.world || this.dynamicBodies.size === 0) {
      return;
    }

    const Ammo = this.Ammo;
    const windScale = Math.max(0, windStrength);
    const dt = this.lastAerodynamicsTime === null
      ? 0
      : Math.min(0.12, Math.max(0, elapsedSeconds - this.lastAerodynamicsTime));
    this.lastAerodynamicsTime = elapsedSeconds;

    for (const handle of this.dynamicBodies) {
      const body = handle.body;
      const motionState = body.getMotionState();
      if (motionState) {
        motionState.getWorldTransform(this.tmpTransform);
      } else {
        body.getWorldTransform(this.tmpTransform);
      }

      const origin = this.tmpTransform.getOrigin();
      const rotation = this.tmpTransform.getRotation();
      const px = origin.x();
      const py = origin.y();
      const pz = origin.z();

      const linearVelocity = body.getLinearVelocity();
      const vx = linearVelocity.x();
      const vy = linearVelocity.y();
      const vz = linearVelocity.z();
      const speedSq = vx * vx + vy * vy + vz * vz;

      const qx = rotation.x();
      const qy = rotation.y();
      const qz = rotation.z();
      const qw = rotation.w();

      // Rotate local forward axis (0, 0, 1) by the rigid body quaternion.
      const nx = 2 * (qx * qz + qw * qy);
      const ny = 2 * (qy * qz - qw * qx);
      const nz = 1 - 2 * (qx * qx + qy * qy);

      const radius = handle.radius || 0.02;
      const sx = handle.debugScale ? handle.debugScale.x : radius * 2;
      const sy = handle.debugScale ? handle.debugScale.y : radius * 2;
      const sz = handle.debugScale ? handle.debugScale.z : radius * 2;
      const supportRadius = Math.max(
        radius * 0.9,
        0.5 * Math.sqrt(sx * sx + sy * sy + sz * sz),
      );

      const surfaceY = this.sampleHeightAt(px, pz);
      const nearGroundDistance = Math.max(0.04, supportRadius * 0.7);
      const clearance = py - surfaceY - supportRadius;
      const groundBlend = Math.min(
        1,
        Math.max(0, 1 - clearance / nearGroundDistance),
      );
      const speedBlend = Math.min(1, Math.max(0, 1 - speedSq / 0.22));
      const settleBlend = groundBlend * (0.45 + speedBlend * 0.55);
      const aeroMix = 1 - settleBlend * 0.96;

      if (typeof body.setDamping === "function") {
        const linearDamping = Math.min(
          0.94,
          handle.dampingLinearBase + settleBlend * 0.36,
        );
        const angularDamping = Math.min(
          0.97,
          handle.dampingAngularBase + settleBlend * 0.68,
        );
        body.setDamping(linearDamping, angularDamping);
      }

      if (handle.groundLocked) {
        if (!handle.factorsFrozen) {
          if (typeof body.setLinearFactor === "function") {
            const linearFactor = new Ammo.btVector3(0, 0, 0);
            body.setLinearFactor(linearFactor);
            Ammo.destroy(linearFactor);
          }
          if (typeof body.setAngularFactor === "function") {
            const angularFactor = new Ammo.btVector3(0, 0, 0);
            body.setAngularFactor(angularFactor);
            Ammo.destroy(angularFactor);
          }
          handle.factorsFrozen = true;
        }
        const stopLinear = new Ammo.btVector3(0, 0, 0);
        body.setLinearVelocity(stopLinear);
        Ammo.destroy(stopLinear);
        const stopAngular = new Ammo.btVector3(0, 0, 0);
        body.setAngularVelocity(stopAngular);
        Ammo.destroy(stopAngular);
        if (typeof body.setActivationState === "function") {
          body.setActivationState(2);
        }
        continue;
      }

      const gustA = Math.sin(elapsedSeconds * 0.86 + pz * 0.34 + handle.windPhase);
      const gustB = Math.cos(elapsedSeconds * 0.61 + px * 0.29 - handle.windPhase * 0.6);
      const gustC = Math.sin(elapsedSeconds * 1.37 + py * 0.48 + handle.windPhase * 1.8);
      const wx = (gustA * 0.52 + gustB * 0.26) * windScale * aeroMix;
      const wy = (0.06 + gustC * 0.09) * windScale * (0.35 + aeroMix * 0.65);
      const wz = (gustB * 0.47 - gustA * 0.22) * windScale * aeroMix;

      const rvx = wx - vx;
      const rvy = wy - vy;
      const rvz = wz - vz;
      const relativeSpeedSq = rvx * rvx + rvy * rvy + rvz * rvz;
      if (relativeSpeedSq >= 1e-6) {
        const relativeSpeed = Math.sqrt(relativeSpeedSq);
        const invRelativeSpeed = 1 / relativeSpeed;
        const dirx = rvx * invRelativeSpeed;
        const diry = rvy * invRelativeSpeed;
        const dirz = rvz * invRelativeSpeed;

        const alignment = Math.abs(nx * dirx + ny * diry + nz * dirz);
        const projectedAreaScale = 0.28 + alignment * 1.32;
        let dragMagnitude =
          handle.dragArea *
          projectedAreaScale *
          relativeSpeedSq *
          (0.42 + windScale * 0.85) *
          (0.18 + aeroMix * 0.82);

        // Clamp to keep solver stable in gust spikes.
        dragMagnitude = Math.min(dragMagnitude, 2.4);

        let fx = dirx * dragMagnitude;
        let fy = diry * dragMagnitude;
        let fz = dirz * dragMagnitude;

        const ndotv = nx * dirx + ny * diry + nz * dirz;
        let tx = dirx - nx * ndotv;
        let ty = diry - ny * ndotv;
        let tz = dirz - nz * ndotv;
        const tangentLengthSq = tx * tx + ty * ty + tz * tz;
        if (tangentLengthSq > 1e-8) {
          const tangentLengthInv = 1 / Math.sqrt(tangentLengthSq);
          tx *= tangentLengthInv;
          ty *= tangentLengthInv;
          tz *= tangentLengthInv;

          const liftMagnitude =
            handle.dragArea *
            relativeSpeed *
            (0.06 + windScale * 0.11) *
            (1 - alignment * 0.55) *
            (0.15 + aeroMix * 0.85);
          fx += tx * liftMagnitude;
          fy += ty * liftMagnitude + liftMagnitude * 0.12;
          fz += tz * liftMagnitude;
        }

        const force = new Ammo.btVector3(fx, fy, fz);
        body.applyCentralForce(force);
        Ammo.destroy(force);

        const ax = ny * dirz - nz * diry;
        const ay = nz * dirx - nx * dirz;
        const az = nx * diry - ny * dirx;
        const axisLengthSq = ax * ax + ay * ay + az * az;
        if (axisLengthSq > 1e-8) {
          const axisLengthInv = 1 / Math.sqrt(axisLengthSq);
          const flutter =
            (0.35 + Math.sin(elapsedSeconds * 6.1 + handle.windPhase * 1.9) * 0.65);
          const torqueMagnitude =
            handle.torqueScale *
            relativeSpeedSq *
            (0.5 + (1 - alignment) * 1.4) *
            flutter *
            (0.04 + aeroMix * 0.96);
          const torque = new Ammo.btVector3(
            ax * axisLengthInv * torqueMagnitude,
            ay * axisLengthInv * torqueMagnitude,
            az * axisLengthInv * torqueMagnitude,
          );
          body.applyTorque(torque);
          Ammo.destroy(torque);
        }
      }

      // Asentamiento físico: cuando está cerca del suelo, favorece orientación plana.
      if (settleBlend > 0.01) {
        if (typeof body.activate === "function" && settleBlend > 0.08) {
          body.activate();
        }
        const side = ny >= 0 ? 1 : -1;
        const settleAxisX = -nz * side;
        const settleAxisZ = nx * side;
        const tilt = Math.sqrt(
          settleAxisX * settleAxisX + settleAxisZ * settleAxisZ,
        );
        if (tilt > 1e-6) {
          const invTilt = 1 / tilt;
          const settleStrength =
            (0.006 + handle.torqueScale * 12) *
            settleBlend *
            (0.38 + tilt * 0.62);
          const settleTorque = new Ammo.btVector3(
            settleAxisX * invTilt * settleStrength,
            0,
            settleAxisZ * invTilt * settleStrength,
          );
          body.applyTorque(settleTorque);
          Ammo.destroy(settleTorque);
        }
      }

      // Reducir giro residual una vez en piso, sobre todo la rotación en Y.
      const angularVelocity = body.getAngularVelocity();
      let avx = angularVelocity.x();
      let avy = angularVelocity.y();
      let avz = angularVelocity.z();
      let angularSpeedSq = avx * avx + avy * avy + avz * avz;

      if (settleBlend > 0.08 && angularSpeedSq > 1e-7) {
        const spinBlend = Math.min(1, Math.max(0, (settleBlend - 0.08) / 0.92));
        const tiltFactor = Math.max(0.12, 1 - spinBlend * 0.62);
        const yawFactor = Math.max(0.06, 1 - spinBlend * 0.9);
        const dampedAngular = new Ammo.btVector3(
          avx * tiltFactor,
          avy * yawFactor,
          avz * tiltFactor,
        );
        body.setAngularVelocity(dampedAngular);
        Ammo.destroy(dampedAngular);
        avx *= tiltFactor;
        avy *= yawFactor;
        avz *= tiltFactor;
        angularSpeedSq =
          avx * avx + avy * avy + avz * avz;
      }

      const maxAngularSpeed = Math.max(0.6, 5.4 - settleBlend * 4.8);
      const maxAngularSpeedSq = maxAngularSpeed * maxAngularSpeed;
      if (angularSpeedSq > maxAngularSpeedSq) {
        const angInv = 1 / Math.sqrt(angularSpeedSq);
        const cappedAngular = new Ammo.btVector3(
          avx * angInv * maxAngularSpeed,
          avy * angInv * maxAngularSpeed,
          avz * angInv * maxAngularSpeed,
        );
        body.setAngularVelocity(cappedAngular);
        Ammo.destroy(cappedAngular);
      }

      const finalLinearVelocity = body.getLinearVelocity();
      const flx = finalLinearVelocity.x();
      const fly = finalLinearVelocity.y();
      const flz = finalLinearVelocity.z();
      const finalSpeedSq = flx * flx + fly * fly + flz * flz;

      const finalAngularVelocity = body.getAngularVelocity();
      const fax = finalAngularVelocity.x();
      const fay = finalAngularVelocity.y();
      const faz = finalAngularVelocity.z();
      const finalAngularSpeedSq = fax * fax + fay * fay + faz * faz;

      const nearGround = clearance <= Math.max(0.018, radius * 0.68);
      if (nearGround && settleBlend > 0.35) {
        const stableLinear = finalSpeedSq < 0.085;
        const stableAngular = finalAngularSpeedSq < 0.22;
        const stabilityBoost =
          (stableLinear ? 0.28 : 0) +
          (stableAngular ? 0.26 : 0) +
          Math.min(0.55, settleBlend * 0.5);
        handle.groundStableTime += dt * Math.max(0.22, stabilityBoost);

        if (handle.groundStableTime > handle.groundLockDelay) {
          const stopLinear = new Ammo.btVector3(0, 0, 0);
          body.setLinearVelocity(stopLinear);
          Ammo.destroy(stopLinear);
          const stopAngular = new Ammo.btVector3(0, 0, 0);
          body.setAngularVelocity(stopAngular);
          Ammo.destroy(stopAngular);
          handle.groundLocked = true;
          handle.groundStableTime = handle.groundLockDelay;
          if (typeof body.setActivationState === "function") {
            body.setActivationState(2);
          }
          continue;
        }
      } else {
        handle.groundStableTime = Math.max(0, handle.groundStableTime - dt * 1.15);
      }

      if (speedSq > 36) {
        const speedInv = 1 / Math.sqrt(speedSq);
        const capped = new Ammo.btVector3(vx * speedInv * 6, vy * speedInv * 6, vz * speedInv * 6);
        body.setLinearVelocity(capped);
        Ammo.destroy(capped);
      }
    }
  }

  getDebugState() {
    if (!this.ready || !this.world) {
      return null;
    }

    const dynamic = [];
    for (const handle of this.dynamicBodies) {
      const body = handle.body;
      const motionState = body.getMotionState();
      if (motionState) {
        motionState.getWorldTransform(this.tmpTransform);
      } else {
        body.getWorldTransform(this.tmpTransform);
      }

      const origin = this.tmpTransform.getOrigin();
      const rotation = this.tmpTransform.getRotation();
      dynamic.push({
        x: origin.x(),
        y: origin.y(),
        z: origin.z(),
        radius: handle.radius || 0.02,
        kind: handle.shapeKind || "sphere",
        scale: handle.debugScale || {
          x: (handle.radius || 0.02) * 2,
          y: (handle.radius || 0.02) * 2,
          z: (handle.radius || 0.02) * 2,
        },
        offset: handle.debugOffset || { x: 0, y: 0, z: 0 },
        quaternion: {
          x: rotation.x(),
          y: rotation.y(),
          z: rotation.z(),
          w: rotation.w(),
        },
      });
    }

    return {
      static: this.debugStaticColliders,
      plant: this.debugPlantColliders,
      dynamic,
    };
  }

  readBodyState(handle, outPosition, outQuaternion, outVelocity) {
    if (!handle || !handle.body || !this.ready) {
      return null;
    }

    const body = handle.body;
    const motionState = body.getMotionState();
    if (motionState) {
      motionState.getWorldTransform(this.tmpTransform);
    } else {
      body.getWorldTransform(this.tmpTransform);
    }

    const origin = this.tmpTransform.getOrigin();
    const rotation = this.tmpTransform.getRotation();

    const px = origin.x();
    const py = origin.y();
    const pz = origin.z();
    const bodyOffset = handle.bodyOffset || { x: 0, y: 0, z: 0 };
    const rotatedBodyOffset = rotateOffsetByQuaternion(bodyOffset, {
      x: rotation.x(),
      y: rotation.y(),
      z: rotation.z(),
      w: rotation.w(),
    });
    const pivotX = px - rotatedBodyOffset.x;
    const pivotY = py - rotatedBodyOffset.y;
    const pivotZ = pz - rotatedBodyOffset.z;

    if (outPosition) {
      outPosition.set(pivotX, pivotY, pivotZ);
    }

    if (outQuaternion) {
      outQuaternion.set(rotation.x(), rotation.y(), rotation.z(), rotation.w());
    }

    const linearVelocity = body.getLinearVelocity();
    const vx = linearVelocity.x();
    const vy = linearVelocity.y();
    const vz = linearVelocity.z();

    if (outVelocity) {
      outVelocity.set(vx, vy, vz);
    }

    const speedSq = vx * vx + vy * vy + vz * vz;
    const surfaceY = this.sampleHeightAt(pivotX, pivotZ);
    const radius = handle.radius || 0.02;
    const onGround = pivotY <= surfaceY + radius + 0.03 && speedSq < 0.15;

    return {
      onGround,
      speedSq,
      surfaceY,
      activationState: typeof body.getActivationState === 'function' ? body.getActivationState() : 1,
    };
  }

  step(deltaSeconds) {
    if (!this.ready || !this.world) {
      return;
    }

    const dt = Math.min(Math.max(deltaSeconds, 0), 0.05);
    this.world.stepSimulation(dt, 6, this.fixedTimeStep);
  }

  removeLeafBody(handle) {
    if (!handle || !this.dynamicBodies.has(handle)) {
      return;
    }

    const Ammo = this.Ammo;

    this.world.removeRigidBody(handle.body);
    this.dynamicBodies.delete(handle);

    Ammo.destroy(handle.body);
    Ammo.destroy(handle.motionState);
    Ammo.destroy(handle.info);
  }

  dispose() {
    if (!this.Ammo) {
      return;
    }

    this.clearPlantColliders();

    for (const handle of this.dynamicBodies) {
      this.world.removeRigidBody(handle.body);
      this.Ammo.destroy(handle.body);
      this.Ammo.destroy(handle.motionState);
      this.Ammo.destroy(handle.info);
    }
    this.dynamicBodies.clear();

    for (let i = 0; i < this.staticBodies.length; i += 1) {
      const entry = this.staticBodies[i];
      this.world.removeRigidBody(entry.body);
      this.Ammo.destroy(entry.body);
      this.Ammo.destroy(entry.motionState);
      this.Ammo.destroy(entry.info);
    }
    this.staticBodies.length = 0;

    for (const shape of this.staticShapes) {
      this.Ammo.destroy(shape);
    }
    this.staticShapes.length = 0;

    for (const shape of this.sphereShapes.values()) {
      this.Ammo.destroy(shape);
    }
    this.sphereShapes.clear();

    for (const descriptor of this.leafShapeCache.values()) {
      if (descriptor.destroyShapes && descriptor.destroyShapes.length > 0) {
        for (let i = 0; i < descriptor.destroyShapes.length; i += 1) {
          this.Ammo.destroy(descriptor.destroyShapes[i]);
        }
      } else {
        this.Ammo.destroy(descriptor.shape);
      }
    }
    this.leafShapeCache.clear();

    for (const descriptor of this.plantShapeCache.values()) {
      this.Ammo.destroy(descriptor.shape);
    }
    this.plantShapeCache.clear();

    if (this.terrainMesh) {
      this.Ammo.destroy(this.terrainMesh);
      this.terrainMesh = null;
    }

    this.Ammo.destroy(this.tmpTransform);
    this.tmpTransform = null;

    this.Ammo.destroy(this.world);
    this.Ammo.destroy(this.solver);
    this.Ammo.destroy(this.broadphase);
    this.Ammo.destroy(this.dispatcher);
    this.Ammo.destroy(this.collisionConfig);

    this.world = null;
    this.solver = null;
    this.broadphase = null;
    this.dispatcher = null;
    this.collisionConfig = null;

    this.debugStaticColliders.length = 0;
    this.debugPlantColliders.length = 0;
    this.lastAerodynamicsTime = null;

    this.ready = false;
  }
}
