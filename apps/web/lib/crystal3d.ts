/**
 * The Ratinole crystal in 3D: a hexagonal bipyramid whose six front facets are
 * the logo (the lime facet is the decision). Loaded only in the browser, on
 * demand, so three.js never weighs on the first paint.
 */
import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const FACETS = ["#C6F432", "#CFCBC0", "#8A867C", "#57534D", "#B5B1A6", "#F3F1EC"];

export interface CrystalHandle {
  stop: () => void;
}

export interface CrystalOptions {
  /** Animate (rotation, float, pointer). Off for reduced motion: one still frame. */
  motion: boolean;
}

export function mountCrystal(canvas: HTMLCanvasElement, { motion }: CrystalOptions): CrystalHandle {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envTarget.texture;

  const camera = new PerspectiveCamera(28, 1, 0.1, 100);
  camera.position.set(0, 0, mobile ? 7.9 : 7.3);

  const key = new DirectionalLight("#ffffff", 1.1);
  key.position.set(-3, 4, 5);
  const rim = new DirectionalLight("#C6F432", 1.6);
  rim.position.set(3.5, 1.5, -2.5);
  scene.add(key, rim, new AmbientLight("#ffffff", 0.06));

  const crystal = new Group();
  scene.add(crystal);

  const R = 1;
  const H = 0.62;
  const V = [90, 30, -30, -90, -150, 150].map((a) => new Vector3(R * Math.cos((a * Math.PI) / 180), R * Math.sin((a * Math.PI) / 180), 0));
  const front = new Vector3(0, 0.03, H);
  const back = new Vector3(0, 0.03, -H);
  const disposables: { dispose: () => void }[] = [];

  const physical = (color: string, extra: Partial<MeshPhysicalMaterial> = {}) => {
    const m = new MeshPhysicalMaterial({
      color,
      roughness: 0.34,
      metalness: 0.04,
      clearcoat: 0.7,
      clearcoatRoughness: 0.1,
      envMapIntensity: 0.6,
      flatShading: true,
      side: DoubleSide,
    });
    Object.assign(m, extra);
    disposables.push(m);
    return m;
  };
  const tri = (pts: Vector3[], mat: MeshPhysicalMaterial | MeshStandardMaterial, shrink = 1) => {
    const c = new Vector3().add(pts[0]!).add(pts[1]!).add(pts[2]!).multiplyScalar(1 / 3);
    const g = new BufferGeometry().setFromPoints(pts.map((p) => p.clone().sub(c).multiplyScalar(shrink).add(c)));
    g.computeVertexNormals();
    disposables.push(g);
    crystal.add(new Mesh(g, mat));
  };

  const backMat = physical("#2A2926");
  for (let i = 0; i < 6; i++) {
    const a = V[i]!;
    const b = V[(i + 1) % 6]!;
    const mat =
      i === 0 ? physical(FACETS[0]!, { emissive: new Color("#8CC200"), emissiveIntensity: 0.4, roughness: 0.25 }) : physical(FACETS[i]!);
    tri([b, a, front], mat, 0.935);
    tri([a, b, back], backMat, 0.935);
  }
  // A dark core fills the seams between facets.
  const core = new MeshStandardMaterial({ color: "#0A0A0B", roughness: 0.6 });
  disposables.push(core);
  for (let i = 0; i < 6; i++) {
    for (const apex of [front, back]) tri([V[i]!, V[(i + 1) % 6]!, apex].map((p) => p.clone().multiplyScalar(0.985)), core);
  }

  // Faint hexagonal orbits with a few lime nodes: the evidence around the decision.
  const orbits = new Group();
  const ringMat = new MeshStandardMaterial({ color: "#ffffff", transparent: true, opacity: 0.16, emissive: "#ffffff", emissiveIntensity: 0.3 });
  const nodeMat = new MeshStandardMaterial({ color: "#C6F432", emissive: "#C6F432", emissiveIntensity: 1.2 });
  disposables.push(ringMat, nodeMat);
  [1.55, 1.95].forEach((r, i) => {
    const ringGeo = new TorusGeometry(r, 0.0055, 6, 6);
    const nodeGeo = new SphereGeometry(0.04, 16, 16);
    disposables.push(ringGeo, nodeGeo);
    const ring = new Mesh(ringGeo, ringMat);
    ring.rotation.z = Math.PI / 6;
    orbits.add(ring);
    const ang = [0.7, 3.6][i]!;
    const node = new Mesh(nodeGeo, nodeMat);
    node.position.set(r * Math.cos(ang), r * Math.sin(ang), 0);
    orbits.add(node);
  });
  orbits.rotation.x = 1.22;
  scene.add(orbits);

  const baseY = 0.36;
  const baseX = -0.18;
  crystal.rotation.set(baseX, baseY, 0);

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // Pointer parallax: the crystal leans towards the cursor.
  const target = { x: 0, y: 0 };
  const current = { x: 0, y: 0 };
  const onPointer = (e: PointerEvent) => {
    target.x = (e.clientX / window.innerWidth - 0.5) * 2;
    target.y = (e.clientY / window.innerHeight - 0.5) * 2;
  };
  if (motion) window.addEventListener("pointermove", onPointer, { passive: true });

  // Only animate while visible on screen and the tab is in front.
  let visible = true;
  const io = new IntersectionObserver(([e]) => {
    visible = !!e?.isIntersecting;
    if (visible) loop();
  });
  io.observe(canvas);
  const onVis = () => {
    if (!document.hidden) loop();
  };
  document.addEventListener("visibilitychange", onVis);

  let raf = 0;
  let running = false;
  const t0 = performance.now();
  const render = () => {
    const t = (performance.now() - t0) / 1000;
    if (motion) {
      current.x += (target.x - current.x) * 0.05;
      current.y += (target.y - current.y) * 0.05;
      crystal.rotation.y = baseY + Math.sin(t * 0.35) * 0.2 + current.x * 0.22;
      crystal.rotation.x = baseX + Math.sin(t * 0.27) * 0.05 + current.y * 0.15;
      crystal.position.y = Math.sin(t * 0.8) * 0.045;
      orbits.rotation.z = t * 0.06;
    }
    renderer.render(scene, camera);
  };
  function loop() {
    if (!motion) {
      render();
      return;
    }
    if (running) return;
    running = true;
    const step = () => {
      if (!visible || document.hidden) {
        running = false;
        return;
      }
      render();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  render();
  loop();

  return {
    stop: () => {
      cancelAnimationFrame(raf);
      running = false;
      io.disconnect();
      ro.disconnect();
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVis);
      for (const d of disposables) d.dispose();
      envTarget.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
