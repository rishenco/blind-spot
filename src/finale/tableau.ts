import * as THREE from 'three';
import { ARCHETYPES, shapeEdges } from '../props/shapes';

/** A fixed victory still-life made from actual project silhouettes, not decorative UI shapes. */
export class VictoryTableau {
  readonly object = new THREE.Group();
  private readonly spinner = new THREE.Group();
  private readonly forward = new THREE.Vector3();
  private readonly line = new THREE.LineBasicMaterial({ color: 0xd9eef4, transparent: true, opacity: 0.82 });

  constructor() {
    this.object.visible = false;
    this.object.add(this.spinner);
    this.makeSpider();
    this.prop('barrel', -2.05, -0.72, -0.2, 1.15);
    this.prop('barrel', 2.05, -0.72, -0.3, 1.1);
    this.prop('flask', -1.32, -0.62, -1.15, 3.1);
    this.prop('bottle', 1.38, -0.62, -1.15, 3.3);
    this.rack();
    this.rifle(-1.55, -0.78, 0.85);
    this.radio(1.45, -0.82, 0.85);
  }

  private makeSpider(): void {
    const body = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.SphereGeometry(0.42, 8, 5)), this.line);
    body.scale.set(1.3, 0.62, 0.85); this.spinner.add(body);
    const points: number[] = [];
    for (let side = -1; side <= 1; side += 2) for (let i = 0; i < 4; i++) {
      const z = -0.42 + i * 0.28;
      const kx = side * (0.72 + i * 0.05);
      const kz = z + (i - 1.5) * 0.12;
      points.push(side * 0.32, 0, z, kx, -0.1, kz, kx, -0.1, kz, side * 1.02, -0.42, z + (i - 1.5) * 0.18);
    }
    const legs = new THREE.BufferGeometry(); legs.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.spinner.add(new THREE.LineSegments(legs, this.line));
    // Spider's ground plane is turned toward the viewer: we see the back/top; its belly recedes
    // into the screen. It rotates about that depth axis, not as a flat side-view wheel.
    this.spinner.rotation.x = Math.PI * 0.5;
  }

  /** Exact contours from the same ARCHETYPES data used for world colliders/reveal. */
  private prop(name: string, x: number, y: number, z: number, scale: number): void {
    const archetype = ARCHETYPES.find((a) => a.name === name);
    if (archetype === undefined) throw new Error(`victory tableau: missing prop ${name}`);
    const edges = shapeEdges(archetype.parts);
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(edges.pos, 3));
    const object = new THREE.LineSegments(geometry, this.line);
    object.position.set(x, y, z); object.scale.setScalar(scale); this.object.add(object);
  }

  private outline(parts: THREE.BufferGeometry[], x: number, y: number, z: number, rotation = 0, scale = 1): void {
    const group = new THREE.Group(); group.position.set(x, y, z); group.rotation.y = rotation; group.scale.setScalar(scale);
    for (const part of parts) group.add(new THREE.LineSegments(new THREE.EdgesGeometry(part), this.line));
    this.object.add(group);
  }

  private rack(): void {
    // Uprights and three shelf frames: an actual warehouse rack silhouette, kept behind the still-life.
    const parts: THREE.BufferGeometry[] = [];
    for (const x of [-2.8, 2.8]) parts.push(new THREE.BoxGeometry(0.08, 2.5, 0.08).translate(x, 0.25, 1.45));
    for (const y of [-0.8, 0.1, 1.15]) parts.push(new THREE.BoxGeometry(5.8, 0.07, 0.45).translate(0, y, 1.45));
    this.outline(parts, 0, 0, 0);
    for (const p of parts) p.dispose();
  }

  private rifle(x: number, y: number, z: number): void {
    // Same recognisable AR proportions as the player's viewmodel: barrel, handguard, receiver,
    // magazine, grip and stock — contours only because this is still the game's graphic language.
    const parts = [
      new THREE.CylinderGeometry(0.021, 0.021, 0.062, 8).rotateZ(Math.PI / 2).translate(-0.33, 0, 0),
      new THREE.CylinderGeometry(0.0105, 0.0105, 0.18, 8).rotateZ(Math.PI / 2).translate(-0.21, 0, 0),
      new THREE.BoxGeometry(0.235, 0.105, 0.112).translate(0.02, 0, 0),
      new THREE.BoxGeometry(0.215, 0.092, 0.124).translate(0.28, 0, 0),
      new THREE.BoxGeometry(0.06, 0.30, 0.12).translate(0.38, -0.17, 0),
      new THREE.BoxGeometry(0.052, 0.068, 0.23).translate(0.58, 0, 0),
    ];
    this.outline(parts, x, y, z, -0.08, 1.4); for (const p of parts) p.dispose();
  }

  private radio(x: number, y: number, z: number): void {
    // The same chunky body + antenna silhouette as the carried radio, but placed as a prop.
    const parts = [
      new THREE.BoxGeometry(0.22, 0.13, 0.095),
      new THREE.CylinderGeometry(0.012, 0.012, 0.30, 7).translate(0.06, 0.21, 0),
    ];
    this.outline(parts, x, y, z, 0.15, 1); for (const p of parts) p.dispose();
  }

  show(on: boolean): void { this.object.visible = on; }

  update(camera: THREE.Camera, time: number): void {
    if (!this.object.visible) return;
    camera.getWorldDirection(this.forward);
    this.object.position.copy(camera.position).addScaledVector(this.forward, 4.3);
    this.object.quaternion.copy(camera.quaternion);
    this.spinner.rotation.z = time * 2.2;
  }
}
