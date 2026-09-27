import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

const MODEL_URL = `${import.meta.env.BASE_URL}cf_x402.stl`;
const BASE_HEIGHT_MM = 3.01;
const DISPLAY_WIDTH = 3.8;

function splitModel(source: THREE.BufferGeometry) {
  // STL has no material groups. The base ends at 3 mm; relief rises to 4.25 mm.
  const position = source.getAttribute("position");
  const normal = source.getAttribute("normal");
  source.computeBoundingBox();
  const bounds = source.boundingBox!;
  const scale = DISPLAY_WIDTH / (bounds.max.x - bounds.min.x);
  const basePositions: number[] = [];
  const baseNormals: number[] = [];
  const detailPositions: number[] = [];
  const detailNormals: number[] = [];

  for (let i = 0; i < position.count; i += 3) {
    const isBase = Math.max(position.getZ(i), position.getZ(i + 1), position.getZ(i + 2)) <= BASE_HEIGHT_MM;
    const positions = isBase ? basePositions : detailPositions;
    const normals = isBase ? baseNormals : detailNormals;
    for (let j = 0; j < 3; j++) {
      const vertex = i + j;
      // The STL is Z-up and positioned away from the origin.
      positions.push(
        (position.getX(vertex) - (bounds.min.x + bounds.max.x) / 2) * scale,
        (position.getZ(vertex) - bounds.min.z) * scale,
        -(position.getY(vertex) - (bounds.min.y + bounds.max.y) / 2) * scale,
      );
      normals.push(normal.getX(vertex), normal.getZ(vertex), -normal.getY(vertex));
    }
  }
  const geometry = (positions: number[], normals: number[]) => {
    const result = new THREE.BufferGeometry();
    result.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    result.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    return result;
  };
  return [geometry(basePositions, baseNormals), geometry(detailPositions, detailNormals)] as const;
}

export function ModelScene() {
  const mount = useRef<HTMLDivElement>(null);
  const explodedRef = useRef(false);
  const spinRef = useRef(false);
  const [exploded, setExploded] = useState(false);
  const [spin, setSpin] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const el = mount.current;
    if (!el) return;
    let mounted = true;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.up.set(0, 0, -1);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.touchAction = "none";
    el.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 1.8));
    const key = new THREE.DirectionalLight(0xffffff, 3);
    key.position.set(-3, 6, 7);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8aa9ff, 2);
    rim.position.set(4, 3, -5);
    scene.add(rim);

    const assembly = new THREE.Group();
    scene.add(assembly);
    const blue = new THREE.MeshPhysicalMaterial({ color: 0x192fba, roughness: 0.38, clearcoat: 0.35 });
    const white = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.52 });
    const pieces: { mesh: THREE.Mesh; home: number; target: number }[] = [];

    new STLLoader().load(
      MODEL_URL,
      (source) => {
        if (!mounted) { source.dispose(); return; }
        try {
          const [baseGeometry, detailGeometry] = splitModel(source);
          const base = new THREE.Mesh(baseGeometry, blue);
          const detail = new THREE.Mesh(detailGeometry, white);
          assembly.add(base, detail);
          pieces.push(
            { mesh: base, home: 0, target: -0.22 },
            { mesh: detail, home: 0, target: 0.38 },
          );
          setLoadState("ready");
        } catch (error) {
          console.error("Could not display the STL preview", error);
          setLoadState("error");
        } finally {
          source.dispose();
        }
      },
      undefined,
      (error) => {
        if (mounted) {
          console.error("Could not load the STL preview", error);
          setLoadState("error");
        }
      },
    );

    const grid = new THREE.GridHelper(8, 18, 0xb4c0dc, 0xdce3ef);
    grid.position.y = -0.48;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.25;
    scene.add(grid);
    let azimuth = 0, polar = 0.32, polarTarget = 0.32, distance = 9.6;
    let dragging = false, lastX = 0, lastY = 0, frame = 0, wasExploded = false;
    const positionCamera = () => {
      camera.position.set(distance * Math.sin(polar) * Math.sin(azimuth), distance * Math.cos(polar), distance * Math.sin(polar) * Math.cos(azimuth));
      camera.lookAt(0, 0, 0);
    };
    const pointerDown = (event: PointerEvent) => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      azimuth -= (event.clientX - lastX) * 0.008;
      polarTarget = THREE.MathUtils.clamp(polarTarget + (event.clientY - lastY) * 0.008, 0.08, 2.65);
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const pointerUp = () => { dragging = false; };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      distance = THREE.MathUtils.clamp(distance + event.deltaY * 0.01, 6, 16);
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointermove", pointerMove);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    renderer.domElement.addEventListener("pointercancel", pointerUp);
    renderer.domElement.addEventListener("wheel", wheel, { passive: false });
    const resize = () => {
      const w = Math.max(el.clientWidth, 1), h = Math.max(el.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    const animate = () => {
      frame = requestAnimationFrame(animate);
      if (explodedRef.current !== wasExploded) {
        if (explodedRef.current && polarTarget < 0.65) polarTarget = 0.65;
        wasExploded = explodedRef.current;
      }
      if (spinRef.current && !dragging) azimuth += 0.003;
      polar += (polarTarget - polar) * 0.08;
      positionCamera();
      for (const piece of pieces) {
        piece.mesh.position.y += ((explodedRef.current ? piece.target : piece.home) - piece.mesh.position.y) * 0.075;
      }
      renderer.render(scene, camera);
    };
    animate();
    return () => {
      mounted = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointercancel", pointerUp);
      renderer.domElement.removeEventListener("wheel", wheel);
      assembly.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
      blue.dispose();
      white.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  return <div className="scene-wrap">
    <div className="scene" ref={mount} role="img" aria-label="Rotatable preview of the Cardano x402 token with a blue base and white raised details. Drag to rotate, scroll to zoom." />
    <div className="scene-label" role="status">FIG. 01 <span>{loadState === "ready" ? "CARDANO x402 / DRAG TO ROTATE" : loadState === "loading" ? "LOADING 3D MODEL…" : "3D PREVIEW UNAVAILABLE"}</span></div>
    <div className="scene-tools">
      <button disabled={loadState !== "ready"} onClick={() => { explodedRef.current = !exploded; setExploded(!exploded); }}>{exploded ? "Assemble" : "Explode view"} <span>↗</span></button>
      <button disabled={loadState !== "ready"} onClick={() => { spinRef.current = !spin; setSpin(!spin); }}>{spin ? "Pause rotation" : "Auto rotate"} <span>◌</span></button>
    </div>
    <div className="scene-coordinates">DRAG / ROTATE<br/>SCROLL / ZOOM<br/>TOP / START</div>
  </div>;
}
