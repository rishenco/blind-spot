import * as THREE from 'three';
import type { ModelDef } from './types';
import { mat, PALETTE } from '../style';

// Placeholder — to be designed.
const def: ModelDef = {
  name: 'ram',
  build() {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 1.6), mat(PALETTE.wool));
    m.position.y = 0.55;
    g.add(m);
    return g;
  },
  poses: { idle: () => {} },
};
export default def;
