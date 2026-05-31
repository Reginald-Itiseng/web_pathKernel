import { Suspense, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls, GizmoHelper, GizmoViewport, Line, Html } from '@react-three/drei';
import * as THREE from 'three';

const FR4_THICKNESS = 1.6; // mm
const FR4_GREEN = '#1e5c1a';
const FR4_EDGE = '#174d14';

interface Props {
  /** All values in mm, derived from the union viewBox / 1000. */
  boardXMin: number;
  boardYMin: number;
  boardWidth: number;
  boardHeight: number;
}

/**
 * Coordinate mapping:
 *   Gerber X  →  Three.js +X  (right)
 *   Gerber Y  →  Three.js +Z  (depth)
 *   Board thickness  →  Three.js +Y  (up)
 *
 * The scene is therefore in real PCB millimetres and the board is placed
 * at its actual Gerber-space position rather than always at the origin.
 */
export function BoardViewport3D({ boardXMin, boardYMin, boardWidth, boardHeight }: Props) {
  const maxDim = Math.max(boardWidth, boardHeight);
  const camDist = maxDim * 1.6;

  // Centre of the board in Three.js / Gerber space
  const cx = boardXMin + boardWidth / 2;
  const cz = boardYMin + boardHeight / 2;

  return (
    <div className="w-full h-full rounded-xl overflow-hidden">
      <Canvas
        camera={{
          position: [cx, camDist * 0.7, cz + camDist],
          fov: 45,
          near: 0.1,
          far: maxDim * 20,
        }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#0d1117']} />

        <ambientLight intensity={0.6} />
        <directionalLight position={[cx + maxDim, maxDim * 1.5, cz + maxDim]} intensity={1.2} />
        <directionalLight position={[cx - maxDim, maxDim, cz - maxDim * 0.5]} intensity={0.4} />

        <Suspense fallback={null}>
          <FrSubstrate cx={cx} cz={cz} width={boardWidth} height={boardHeight} />
          <SceneGrid cx={cx} cz={cz} boardWidth={boardWidth} boardHeight={boardHeight} />
          <OriginMarker maxDim={maxDim} />
        </Suspense>

        <OrbitControls
          makeDefault
          target={[cx, 0, cz]}
          minDistance={maxDim * 0.2}
          maxDistance={maxDim * 5}
        />

        {/* Axis indicator — labels show which direction is Gerber X / Y */}
        <GizmoHelper alignment="bottom-left" margin={[60, 60]}>
          <GizmoViewport
            axisColors={['#f87171', '#4ade80', '#60a5fa']}
            labelColor="white"
          />
        </GizmoHelper>
      </Canvas>
    </div>
  );
}

function FrSubstrate({
  cx, cz, width, height,
}: {
  cx: number; cz: number; width: number; height: number;
}) {
  const edgesGeo = useMemo(() => {
    const box = new THREE.BoxGeometry(width, FR4_THICKNESS, height);
    return new THREE.EdgesGeometry(box);
  }, [width, height]);

  return (
    <group position={[cx, 0, cz]}>
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

function SceneGrid({
  cx, cz, boardWidth, boardHeight,
}: {
  cx: number; cz: number; boardWidth: number; boardHeight: number;
}) {
  const span = Math.max(boardWidth, boardHeight) * 4;
  const yPos = -FR4_THICKNESS / 2 - 0.01;

  return (
    <Grid
      position={[cx, yPos, cz]}
      args={[span, span]}
      cellSize={1}
      cellThickness={0.4}
      cellColor="#2a2d3e"
      sectionSize={10}
      sectionThickness={0.8}
      sectionColor="#374151"
      fadeDistance={span * 0.6}
      fadeStrength={1}
      followCamera={false}
      infiniteGrid={false}
    />
  );
}

/**
 * Marks Gerber (0, 0) with two axis arms and a label.
 * Red arm  → +X (Gerber X)
 * Green arm → +Z (Gerber Y)
 */
function OriginMarker({ maxDim }: { maxDim: number }) {
  const arm = Math.max(2, maxDim * 0.06);  // arm length scales with board
  const dot = arm * 0.12;
  const y   = -FR4_THICKNESS / 2 - 0.05;  // sit just on the work-surface plane

  return (
    <group position={[0, y, 0]}>
      {/* +X arm — red */}
      <Line points={[[0, 0, 0], [arm, 0, 0]]} color="#f87171" lineWidth={2} />
      {/* +Z arm — green (= Gerber +Y) */}
      <Line points={[[0, 0, 0], [0, 0, arm]]} color="#4ade80" lineWidth={2} />
      {/* Origin dot */}
      <mesh>
        <sphereGeometry args={[dot, 12, 12]} />
        <meshBasicMaterial color="white" />
      </mesh>
      {/* Label */}
      <Html position={[arm * 0.35, dot * 2, arm * 0.35]} center>
        <span style={{
          color: '#94a3b8',
          fontSize: '11px',
          fontFamily: 'monospace',
          whiteSpace: 'nowrap',
          userSelect: 'none',
          textShadow: '0 1px 3px #000, 0 0 6px #000',
        }}>
          (0, 0)
        </span>
      </Html>
    </group>
  );
}
