import * as THREE from 'https://unpkg.com/three@0.164.1/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.164.1/examples/jsm/controls/OrbitControls.js';

const PIXEL_SIZE = 24;
const VOXEL_SIZE = 1;
const BOX_SCALE = 0.96;
const CAMERA_POSITION = new THREE.Vector3(18, 10, 24);
const CAMERA_TARGET = new THREE.Vector3(0, 0, 0);

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    image.src = url;
  });
}

function downsampleToPixels(image) {
  const canvas = document.createElement('canvas');
  canvas.width = PIXEL_SIZE;
  canvas.height = PIXEL_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, PIXEL_SIZE, PIXEL_SIZE);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0, PIXEL_SIZE, PIXEL_SIZE);
  return ctx.getImageData(0, 0, PIXEL_SIZE, PIXEL_SIZE).data;
}

function collectVoxelBuckets(imageData) {
  const buckets = new Map();

  for (let y = 0; y < PIXEL_SIZE; y += 1) {
    for (let x = 0; x < PIXEL_SIZE; x += 1) {
      const index = (y * PIXEL_SIZE + x) * 4;
      const alpha = imageData[index + 3];
      if (alpha === 0) continue;

      const colorKey = `${imageData[index]},${imageData[index + 1]},${imageData[index + 2]}`;
      if (!buckets.has(colorKey)) {
        buckets.set(colorKey, []);
      }

      buckets.get(colorKey).push({
        x: x - PIXEL_SIZE / 2 + 0.5,
        y: PIXEL_SIZE / 2 - y - 0.5,
        z: 0,
      });
    }
  }

  return buckets;
}

function createMaterial(colorKey) {
  const [r, g, b] = colorKey.split(',').map((value) => Number.parseInt(value, 10) / 255);
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(r, g, b),
    roughness: 0.88,
    metalness: 0.04,
  });
}

export class NoPunkVoxelViewer {
  constructor(container) {
    this.container = container;
    this.cache = new Map();
    this.geometry = new THREE.BoxGeometry(BOX_SCALE, BOX_SCALE, VOXEL_SIZE);
    this.matrixHelper = new THREE.Object3D();
    this.scene = new THREE.Scene();
    this.modelRoot = new THREE.Group();
    this.scene.add(this.modelRoot);

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 1000);
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';

    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 2.2;
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 2.1;
    this.controls.minDistance = 14;
    this.controls.maxDistance = 70;
    this.controls.target.copy(CAMERA_TARGET);
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_ROTATE,
    };

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.65));

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(18, 22, 28);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xa8d7ff, 0.75);
    fillLight.position.set(-20, 10, 16);
    this.scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.55);
    rimLight.position.set(0, 16, -20);
    this.scene.add(rimLight);

    this.resize = this.resize.bind(this);
    this.animate = this.animate.bind(this);

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(this.container);
    this.reset();
    this.resize();
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  reset() {
    this.camera.position.copy(CAMERA_POSITION);
    this.controls.target.copy(CAMERA_TARGET);
    this.controls.autoRotate = true;
    this.controls.update();
  }

  async buildModelData(imageUrl) {
    const cached = this.cache.get(imageUrl);
    if (cached) return cached;

    const image = await loadImage(imageUrl);
    const pixels = downsampleToPixels(image);
    const buckets = collectVoxelBuckets(pixels);
    this.cache.set(imageUrl, buckets);
    return buckets;
  }

  clearModel() {
    while (this.modelRoot.children.length) {
      const child = this.modelRoot.children[0];
      if (!child) continue;
      this.modelRoot.remove(child);
      if (child.material) {
        child.material.dispose();
      }
    }
  }

  buildInstancedMeshes(buckets) {
    this.clearModel();

    buckets.forEach((positions, colorKey) => {
      const material = createMaterial(colorKey);
      const mesh = new THREE.InstancedMesh(this.geometry, material, positions.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;

      positions.forEach((position, index) => {
        this.matrixHelper.position.set(position.x, position.y, position.z);
        this.matrixHelper.rotation.set(0, 0, 0);
        this.matrixHelper.scale.setScalar(1);
        this.matrixHelper.updateMatrix();
        mesh.setMatrixAt(index, this.matrixHelper.matrix);
      });

      mesh.instanceMatrix.needsUpdate = true;
      this.modelRoot.add(mesh);
    });
  }

  async loadToken({ imageUrl, fallbackImageUrl = '' }) {
    let buckets;

    try {
      buckets = await this.buildModelData(imageUrl);
    } catch (primaryError) {
      if (!fallbackImageUrl || fallbackImageUrl === imageUrl) {
        throw primaryError;
      }
      buckets = await this.buildModelData(fallbackImageUrl);
    }

    this.buildInstancedMeshes(buckets);
    this.reset();
    return buckets;
  }

  resize() {
    const width = Math.max(1, Math.round(this.container.clientWidth || 1));
    const height = Math.max(1, Math.round(this.container.clientHeight || 1));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  animate() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  dispose() {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.clearModel();
    this.controls.dispose();
    this.geometry.dispose();
    this.renderer.dispose();
    this.container.innerHTML = '';
  }
}

window.NoPunkVoxelViewer = NoPunkVoxelViewer;
