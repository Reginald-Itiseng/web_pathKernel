import { Suspense, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

const FR4_THICKNESS = 1.6; // mm — standard PCB substrate
const FR4_GREEN = '#1e5c1a';
const FR4_EDGE = '#174d14';

interface Props {
  boardWidth: number;
  boardHeight: number;
}

export function BoardViewport3D({ boardWidth, boardHeight }: Props) {
  const maxDim = Math.max(boardWidth, boardHeight);
  const camDist = maxDim * 1.6;

  return (
    <div className="w-full h-full rounded-xl overflow-hidden">
      <Canvas
        camera={{
          position: [0, camDist * 0.7, camDist],
          fov: 45,
          near: 0.1,
          far: maxDim * 20,
        }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#0d1117']} />

        <ambientLight intensity={0.6} />
        <directionalLight position={[maxDim, maxDim * 1.5, maxDim]} intensity={1.2} />
        <directionalLight position={[-maxDim, maxDim, -maxDim * 0.5]} intensity={0.4} />

        <Suspense fallback={null}>
          <FrSubstrate width={boardWidth} height={boardHeight} />
          <SceneGrid boardWidth={boardWidth} boardHeight={boardHeight} />
        </Suspense>

        <OrbitControls
          makeDefault
          target={[0, 0, 0]}
          minDistance={maxDim * 0.2}
          maxDistance={maxDim * 5}
        />
      </Canvas>
    </div>
  );
}

function FrSubstrate({ width, height }: { width: number; height: number }) {
  const edgesGeo = useMemo(() => {
    const box = new THREE.BoxGeometry(width, FR4_THICKNESS, height);
    return new THREE.EdgesGeometry(box);
  }, [width, height]);

  return (
    <group>
      <mesh>
        <boxGeometry args={[width, FR4_THICKNESS, height]} />
        <meshStandardMaterial color={FR4_GREEN} roughness={0.7} metalness={0} />
      </mesh>
      <lineSegments geometry={edgesGeo}>
        <lineBasicMaterial color={FR4_EDGE} />
      </lineSegments>
    </group>
  );
}

function SceneGrid({ boardWidth, boardHeight }: { boardWidth: number; boardHeight: number }) {
  const span = Math.max(boardWidth, boardHeight) * 3;
  const yPos = -FR4_THICKNESS / 2 - 0.01;

  return (
    <Grid
      position={[0, yPos, 0]}
      args={[span, span]}
      cellSize={1}
      cellThickness={0.4}
      cellColor="#2a2d3e"
      sectionSize={10}
      sectionThickness={0.8}
      sectionColor="#374151"
      fadeDistance={span}
      fadeStrength={1.5}
      followCamera={false}
      infiniteGrid={false}
    />
  );
}
