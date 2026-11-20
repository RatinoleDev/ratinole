/**
 * The Ratinole robot in 3D: a small ceramic helper with a dark visor, lime eyes and the brand crystal in its
 * chest. It floats, blinks, looks at the pointer, and acts out what the page is doing (reading, done, stuck).
 * Loaded only in the browser, on demand, so three.js never weighs on the first paint.
 */
import {
  AmbientLight,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/** What the robot is acting out. */
export type RobotMood = "idle" | "thinking" | "happy" | "confused" | "sleeping";

export interface RobotHandle {
  stop: () => void;
  setMood: (mood: RobotMood) => void;
}

export interface RobotOptions {
  /** Animate. Off for reduced motion: one still frame per mood. */
  motion: boolean;
  mood?: RobotMood;
  /** Wave once when it first appears. */
  greet?: boolean;
}

const LIME = "#C6F432";
const AMBER = "#FFC857";

interface Pose {
  tilt: number; // head roll
  pitch: number; // head nod (positive looks down)
  yaw: number;
  armL: number; // raise outwards, radians from hanging
  armR: number;
  fwdL: number; // swing forwards
  fwdR: number;
  antenna: number; // lean
  spin: number; // chest crystal speed
  think: number; // 0..1: orbiting thought dots
  happy: number; // 0..1: smiling eyes
  squint: number; // 0..1: one eye smaller
  doze: number; // 0..1: eyes nearly shut, dimmed
  amber: number; // 0..1: eye colour towards amber
  lean: number; // whole body roll
}

const REST: Pose = { tilt: 0, pitch: 0, yaw: 0, armL: 0.16, armR: 0.16, fwdL: 0, fwdR: 0, antenna: 0, spin: 0.6, think: 0, happy: 0, squint: 0, doze: 0, amber: 0, lean: 0 };

const POSES: Record<RobotMood, Pose> = {
  idle: REST,
  thinking: { ...REST, tilt: 0.13, pitch: 0.16, armR: -0.32, fwdR: 2.25, armL: 0.22, antenna: -0.12, spin: 5, think: 1 },
  happy: { ...REST, tilt: -0.05, pitch: -0.08, armL: 2.5, armR: 2.5, spin: 2.4, happy: 1 },
  confused: { ...REST, tilt: -0.3, pitch: 0.05, armL: 0.85, armR: 0.5, fwdL: 0.3, antenna: 0.55, spin: 0.25, squint: 1, amber: 1, lean: -0.06 },
  sleeping: { ...REST, tilt: 0.18, pitch: 0.34, armL: 0.08, armR: 0.08, antenna: 0.5, spin: 0.1, doze: 1 },
};

export function mountRobot(canvas: HTMLCanvasElement, { motion, mood: firstMood = "idle", greet = true }: RobotOptions): RobotHandle {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 0.82;
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envTarget.texture;

  const camera = new PerspectiveCamera(26, 1, 0.1, 100);
  camera.position.set(0, 0.2, 7.15);

  const key = new DirectionalLight("#ffffff", 1.15);
  key.position.set(-3, 4, 5);
  const rim = new DirectionalLight(LIME, 2.2);
  rim.position.set(3.5, 1.2, -2.8);
  const under = new DirectionalLight(LIME, 0.5);
  under.position.set(0, -4, 2);
  scene.add(key, rim, under, new AmbientLight("#ffffff", 0.04));

  const disposables: { dispose: () => void }[] = [];
  const keep = <T extends BufferGeometry | Material>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const ceramic = keep(new MeshPhysicalMaterial({ color: "#DDD9CF", roughness: 0.36, metalness: 0.02, clearcoat: 0.8, clearcoatRoughness: 0.16, envMapIntensity: 0.42 }));
  const graphite = keep(new MeshStandardMaterial({ color: "#26262A", roughness: 0.42, metalness: 0.55, envMapIntensity: 0.8 }));
  const glass = keep(new MeshPhysicalMaterial({ color: "#060607", roughness: 0.5, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.5, envMapIntensity: 0.1 }));
  const eyeMat = keep(new MeshBasicMaterial({ color: LIME, toneMapped: false }));
  const glowMat = keep(new MeshBasicMaterial({ color: LIME, toneMapped: false }));
  const gemMat = keep(new MeshPhysicalMaterial({ color: LIME, emissive: new Color("#8CC200"), emissiveIntensity: 0.9, roughness: 0.2, clearcoat: 1, flatShading: true }));
  const ringMat = keep(new MeshBasicMaterial({ color: LIME, toneMapped: false, transparent: true, opacity: 0.5 }));
  const dotMat = keep(new MeshBasicMaterial({ color: LIME, toneMapped: false, transparent: true, opacity: 0 }));

  const mesh = (g: BufferGeometry, m: Material) => new Mesh(keep(g), m);

  const bot = new Group();
  scene.add(bot);

  // Head
  const head = new Group();
  head.position.y = 0.5;
  bot.add(head);
  head.add(mesh(new RoundedBoxGeometry(1.56, 1.16, 1.12, 10, 0.44), ceramic));
  const visor = mesh(new RoundedBoxGeometry(1.2, 0.68, 0.2, 8, 0.1), glass);
  visor.position.set(0, -0.02, 0.48);
  head.add(visor);

  const eyes = new Group();
  eyes.position.set(0, -0.01, 0.585);
  head.add(eyes);
  const openEye = keep(new CapsuleGeometry(0.078, 0.1, 6, 20));
  const smileEye = keep(new TorusGeometry(0.105, 0.036, 12, 28, Math.PI));
  const eyeL = new Mesh(openEye, eyeMat);
  const eyeR = new Mesh(openEye, eyeMat);
  const smileL = new Mesh(smileEye, eyeMat);
  const smileR = new Mesh(smileEye, eyeMat);
  eyeL.position.x = smileL.position.x = -0.27;
  eyeR.position.x = smileR.position.x = 0.27;
  smileL.position.y = smileR.position.y = -0.04;
  smileL.visible = smileR.visible = false;
  eyes.add(eyeL, eyeR, smileL, smileR);

  for (const side of [-1, 1]) {
    const ear = mesh(new CylinderGeometry(0.19, 0.19, 0.12, 28), graphite);
    ear.rotation.z = Math.PI / 2;
    ear.position.set(side * 0.8, -0.02, 0);
    const lamp = mesh(new CylinderGeometry(0.085, 0.085, 0.03, 24), glowMat);
    lamp.rotation.z = Math.PI / 2;
    lamp.position.set(side * 0.87, -0.02, 0);
    head.add(ear, lamp);
  }

  const antenna = new Group();
  antenna.position.y = 0.56;
  head.add(antenna);
  const stem = mesh(new CylinderGeometry(0.022, 0.03, 0.32, 12), graphite);
  stem.position.y = 0.16;
  const tip = mesh(new SphereGeometry(0.075, 24, 24), glowMat);
  tip.position.y = 0.36;
  antenna.add(mesh(new CylinderGeometry(0.1, 0.13, 0.06, 20), graphite), stem, tip);

  // Body
  const body = new Group();
  body.position.y = -0.6;
  bot.add(body);
  const torso = mesh(new SphereGeometry(0.52, 40, 32), ceramic);
  torso.scale.set(1, 1.02, 0.88);
  body.add(torso);
  const neck = mesh(new CylinderGeometry(0.2, 0.26, 0.2, 24), graphite);
  neck.position.y = 0.5;
  body.add(neck);
  const port = mesh(new CylinderGeometry(0.2, 0.2, 0.05, 32), glass);
  port.rotation.x = Math.PI / 2;
  port.position.set(0, 0.06, 0.435);
  body.add(port);
  // The brand crystal: a hexagonal bipyramid, facing forwards like the logo.
  const gem = new Group();
  gem.position.set(0, 0.06, 0.48);
  const gemFront = mesh(new ConeGeometry(0.125, 0.07, 6), gemMat);
  gemFront.rotation.x = Math.PI / 2;
  gemFront.position.z = 0.035;
  const gemBack = mesh(new ConeGeometry(0.125, 0.05, 6), gemMat);
  gemBack.rotation.x = -Math.PI / 2;
  gemBack.position.z = -0.025;
  gem.add(gemFront, gemBack);
  body.add(gem);

  const arm = (side: number) => {
    const g = new Group();
    g.position.set(side * 0.62, 0.22, 0);
    const upper = mesh(new CapsuleGeometry(0.105, 0.24, 6, 16), ceramic);
    upper.position.y = -0.24;
    const hand = mesh(new SphereGeometry(0.135, 24, 24), graphite);
    hand.position.y = -0.5;
    g.add(mesh(new SphereGeometry(0.12, 20, 20), graphite), upper, hand);
    body.add(g);
    return g;
  };
  const armL = arm(-1);
  const armR = arm(1);

  // Hover rings below the body.
  const rings = new Group();
  rings.position.y = -1.34;
  rings.rotation.x = Math.PI / 2;
  const ringA = mesh(new TorusGeometry(0.3, 0.018, 8, 64), ringMat);
  const ringB = mesh(new TorusGeometry(0.46, 0.008, 8, 64), ringMat);
  rings.add(ringA, ringB);
  bot.add(rings);

  // Thought dots that circle the head while it reads.
  const dots = new Group();
  dots.position.y = 0.55;
  const dotGeo = keep(new SphereGeometry(0.045, 16, 16));
  const dotMeshes = [0, 1, 2].map(() => new Mesh(dotGeo, dotMat));
  dots.add(...dotMeshes);
  bot.add(dots);

  bot.position.y = 0.22;
  bot.rotation.y = -0.12;

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

  // The head turns towards the pointer, measured from the robot's own place on the page.
  const look = { x: 0, y: 0 };
  const gaze = { x: 0, y: 0 };
  const onPointer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / Math.max(320, window.innerWidth / 2);
    const dy = (e.clientY - (r.top + r.height / 2)) / Math.max(260, window.innerHeight / 2);
    look.x = Math.max(-1, Math.min(1, dx));
    look.y = Math.max(-1, Math.min(1, dy));
  };
  if (motion) window.addEventListener("pointermove", onPointer, { passive: true });

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

  let mood: RobotMood = firstMood;
  const pose: Pose = { ...POSES[mood] };
  // The robot's own clock. It moves at most 1/20 s per drawn frame, so a stall (shaders compiling, a hidden
  // tab) pauses the acting instead of skipping it: the first wave is always seen.
  let clock = 0;
  let moodAt = 0;
  let last = performance.now();
  let nextBlink = 1.6;
  let blinkUntil = 0;
  const eyeColor = new Color(LIME);
  const lime = new Color(LIME);
  const amber = new Color(AMBER);

  const apply = (t: number, since: number) => {
    // After a short cheer the robot settles back, so it is not left with its arms in the air.
    const target = mood === "happy" && since > 2.4 ? REST : POSES[mood];
    const k = motion ? 0.085 : 1;
    for (const key of Object.keys(pose) as (keyof Pose)[]) pose[key] += (target[key] - pose[key]) * k;

    gaze.x += (look.x - gaze.x) * 0.07;
    gaze.y += (look.y - gaze.y) * 0.07;
    // While reading or dozing it keeps its eyes on its own business.
    const attention = 1 - Math.max(pose.think, pose.doze) * 0.75;

    const bob = motion ? Math.sin(t * 1.7) * 0.05 : 0;
    // A happy robot hops a few times, then settles.
    const hop = motion && mood === "happy" && since < 1.5 ? Math.abs(Math.sin(since * 7.4)) * 0.15 * (1 - since / 1.5) : 0;
    bot.position.y = 0.22 + bob + hop;
    bot.rotation.z = pose.lean;
    bot.rotation.y = -0.12 + gaze.x * 0.22 * attention;

    const shake = motion && mood === "confused" && since < 1.3 ? Math.sin(since * 13) * 0.11 * (1 - since / 1.3) : 0;
    head.rotation.z = pose.tilt + (motion ? Math.sin(t * 0.9) * 0.02 : 0);
    head.rotation.x = pose.pitch + gaze.y * 0.3 * attention;
    head.rotation.y = pose.yaw + gaze.x * 0.5 * attention + shake;

    // Arms: a first wave, then whatever the mood calls for.
    const waving = motion && greet && mood === "idle" && t < 2.3;
    const wave = waving ? 2.55 + Math.sin(t * 11) * 0.3 : 0;
    const sway = motion ? Math.sin(t * 1.7 + 0.6) * 0.035 : 0;
    const cheer = motion && mood === "happy" ? Math.sin(t * 9) * 0.12 * pose.happy : 0;
    armL.rotation.z = -(pose.armL + sway + cheer);
    armR.rotation.z = waving ? wave : pose.armR + sway - cheer;
    armL.rotation.x = -pose.fwdL;
    armR.rotation.x = -pose.fwdR + (motion && pose.think > 0.5 ? Math.sin(t * 3.2) * 0.06 : 0);

    antenna.rotation.z = pose.antenna + (motion ? Math.sin(t * 2.3) * 0.05 : 0);
    const pulse = motion ? (pose.think > 0.5 ? 1 + Math.sin(t * 11) * 0.28 : 1 + Math.sin(t * 2.2) * 0.07) : 1;
    tip.scale.setScalar(pulse);

    // Eyes
    eyeColor.copy(lime).lerp(amber, pose.amber);
    eyeMat.color.copy(eyeColor).multiplyScalar(1 - pose.doze * 0.55);
    const smiling = pose.happy > 0.5;
    eyeL.visible = eyeR.visible = !smiling;
    smileL.visible = smileR.visible = smiling;
    if (motion && t > nextBlink) {
      blinkUntil = t + 0.13;
      nextBlink = t + 2.6 + Math.random() * 2.8;
    }
    const lid = t < blinkUntil ? 0.1 : 1 - pose.doze * 0.84;
    eyeL.scale.set(1, lid, 1);
    eyeR.scale.set(1 - pose.squint * 0.28, lid * (1 - pose.squint * 0.3), 1);
    eyes.position.x = motion && pose.think > 0.5 ? Math.sin(t * 4.6) * 0.07 : gaze.x * 0.05 * attention;
    eyes.position.y = -0.01 - gaze.y * 0.035 * attention;

    gem.rotation.z = motion ? gem.rotation.z + pose.spin * 0.016 : Math.PI / 6;
    gemMat.emissiveIntensity = 0.75 + pose.think * 0.7 + (motion ? Math.sin(t * 3) * 0.12 : 0);

    const breathe = motion ? 1 + Math.sin(t * 1.7) * 0.08 : 1;
    ringA.scale.setScalar(breathe);
    ringB.scale.setScalar(2 - breathe);
    ringMat.opacity = 0.5 - pose.doze * 0.3 - hop * 1.2;

    dotMat.opacity = pose.think * 0.95;
    dots.visible = pose.think > 0.02;
    dotMeshes.forEach((d, i) => {
      const a = t * 2.6 + (i * Math.PI * 2) / 3;
      d.position.set(Math.cos(a) * 1.16, Math.sin(a * 1.5) * 0.14 + 0.2, Math.sin(a) * 0.9);
      d.scale.setScalar(0.8 + 0.4 * Math.sin(a * 2));
    });
  };

  let raf = 0;
  let running = false;
  const render = () => {
    const now = performance.now();
    clock += Math.min(0.05, (now - last) / 1000);
    last = now;
    apply(clock, clock - moodAt);
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
    setMood: (next) => {
      if (next === mood) return;
      mood = next;
      moodAt = clock;
      if (!motion) render();
    },
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
