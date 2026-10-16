import * as THREE from 'three';
import type { ModelDef } from './types';
import { mat, PALETTE } from '../style';

// Placeholder — to be designed.
const def: ModelDef = {
  name: 'player',
  build() {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.8, 0.5), mat(PALETTE.skin));
    m.position.y = 0.9;
    g.add(m);
    return g;
  },
  poses: { idle: () => {} },
};
export default def;
