import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

export function ModelScene() {
  const mount = useRef<HTMLDivElement>(null);
  const explodedRef = useRef(false);
  const spinRef = useRef(false);
  const [exploded, setExploded] = useState(false);
  const [spin, setSpin] = useState(false);
  useEffect(() => {
    const el = mount.current;
    if (!el) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, .1, 100);
    camera.up.set(0, 0, -1);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.touchAction = 'none';
    el.appendChild(renderer.domElement);
    scene.add(new THREE.AmbientLight(0xffffff, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3.2); key.position.set(-3, 5, 7); scene.add(key);
    const rim = new THREE.DirectionalLight(0x8aa9ff, 3); rim.position.set(4, -2, -3); scene.add(rim);
    const assembly = new THREE.Group(); scene.add(assembly);
    const dark = new THREE.MeshPhysicalMaterial({ color: 0x192fba, metalness: .1, roughness: .3, clearcoat: .7 });
    const pale = new THREE.MeshPhysicalMaterial({ color: 0xf0ece3, roughness: .56 });
    const orange = new THREE.MeshPhysicalMaterial({ color: 0xff6a42, roughness: .4 });
    const pieces: { mesh: THREE.Object3D; target: number; home: number }[] = [];
    const cylinder = (radius: number, height: number, material: THREE.Material, y: number) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 96), material);
      m.position.y = y; assembly.add(m); return m;
    };
    pieces.push({ mesh: cylinder(1.72, .21, dark, -.34), target: -.86, home: -.34 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.48, .055, 12, 120), orange);
    ring.rotation.x = Math.PI / 2; ring.position.y = -.21; assembly.add(ring); pieces.push({ mesh: ring, target: -.38, home: -.21 });
    pieces.push({ mesh: cylinder(1.08, .1, pale, -.18), target: .03, home: -.18 });
    const dots = new THREE.Group(); assembly.add(dots);
    for (let i = 0; i < 13; i++) {
      const r = i === 0 ? 0 : i < 7 ? .45 : .78;
      const a = i < 7 ? (i - 1) * Math.PI / 3 : (i - 7) * Math.PI / 3 + Math.PI / 6;
      const dotRadius = i === 0 ? .13 : .085;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(dotRadius, dotRadius, .065, 24), dark);
      m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r); dots.add(m);
    }
    dots.position.y = -.09; pieces.push({ mesh: dots, target: .43, home: -.09 });
    const grid = new THREE.GridHelper(8, 18, 0xb4c0dc, 0xdce3ef); grid.position.y = -1.68;
    (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = .25; scene.add(grid);
    let azimuth = 0, polar = .12, polarTarget = .12, distance = 8.3, dragging = false, lastX = 0, lastY = 0;
    let wasExploded = false, id = 0;
    const positionCamera = () => {
      camera.position.set(distance * Math.sin(polar) * Math.sin(azimuth), distance * Math.cos(polar), distance * Math.sin(polar) * Math.cos(azimuth));
      camera.lookAt(0, -.08, 0);
    };
    const pointerDown = (event: PointerEvent) => { dragging = true; lastX = event.clientX; lastY = event.clientY; renderer.domElement.setPointerCapture(event.pointerId); };
    const pointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      azimuth -= (event.clientX - lastX) * .008;
      polarTarget = THREE.MathUtils.clamp(polarTarget + (event.clientY - lastY) * .008, .08, 2.65);
      lastX = event.clientX; lastY = event.clientY;
    };
    const pointerUp = () => { dragging = false; };
    const wheel = (event: WheelEvent) => { event.preventDefault(); distance = THREE.MathUtils.clamp(distance + event.deltaY * .01, 5.5, 13); };
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointermove', pointerMove);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    renderer.domElement.addEventListener('pointercancel', pointerUp);
    renderer.domElement.addEventListener('wheel', wheel, { passive: false });
    const resize = () => { const w = el.clientWidth, h = el.clientHeight; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); };
    const observer = new ResizeObserver(resize); observer.observe(el); resize();
    const animate = () => {
      id = requestAnimationFrame(animate);
      if (explodedRef.current !== wasExploded) { if (explodedRef.current && polarTarget < .65) polarTarget = .65; wasExploded = explodedRef.current; }
      if (spinRef.current && !dragging) azimuth += .003;
      polar += (polarTarget - polar) * .08;
      positionCamera();
      for (const p of pieces) p.mesh.position.y += ((explodedRef.current ? p.target : p.home) - p.mesh.position.y) * .075;
      renderer.render(scene, camera);
    }; animate();
    return () => {
      cancelAnimationFrame(id); observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointermove', pointerMove);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointercancel', pointerUp);
      renderer.domElement.removeEventListener('wheel', wheel);
      renderer.dispose(); el.removeChild(renderer.domElement);
      scene.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
      [dark, pale, orange, grid.material as THREE.Material].forEach(m => m.dispose());
    };
  }, []);
  return <div className="scene-wrap"><div className="scene" ref={mount} role="img" aria-label="Rotatable top view of the Proof of Print token. Drag to rotate, scroll to zoom." />
    <div className="scene-label">FIG. 01 <span>PROOF OF PRINT / DRAG TO ROTATE</span></div>
    <div className="scene-tools"><button onClick={() => { explodedRef.current = !exploded; setExploded(!exploded); }}>{exploded ? 'Assemble' : 'Explode view'} <span>↗</span></button><button onClick={() => { spinRef.current = !spin; setSpin(!spin); }}>{spin ? 'Pause rotation' : 'Auto rotate'} <span>◌</span></button></div>
    <div className="scene-coordinates">DRAG / ROTATE<br/>SCROLL / ZOOM<br/>TOP / START</div>
  </div>;
}
