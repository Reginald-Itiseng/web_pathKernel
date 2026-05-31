import { Suspense, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls, GizmoHelper, GizmoViewport, Line, Html } from '@react-three/drei';
import * as THREE from 'three';

/**
 * Coordinate convention (matches standard CNC/CAM and Gerber board space):
 *   Gerber X  →  Three.js +X  (right)
 *   Gerber Y  →  Three.js +Y  (up on screen when viewed from above)
 *   Z                         (board normal — spindle travel direction)
 *
 * The board lies flat in the XY plane; the camera looks down from +Z.
 */

const FR4_THICKNESS = 1.6; // mm
const FR4_GREEN     = '#1e5c1a';
const FR4_EDGE      = '#174d14';

interface Props {
  boardXMin:   number;
  boardYMin:   number;
  boardWidth:  number;
  boardHeight: number;
}

export function BoardViewport3D({ boardXMin, boardYMin, boardWidth, boardHeight }: Props) {
  const maxDim  = Math.max(boardWidth, boardHeight);
  const camDist = maxDim * 1.6;

  // Board centre in scene space
  const cx = boardXMin + boardWidth  / 2;
  const cy = boardYMin + boardHeight / 2;

  return (
    <div className="w-full h-full rounded-xl overflow-hidden">
      <Canvas
        camera={{
          // Positioned above and slightly "south" so the board is seen
          // at a comfortable angle rather than perfectly top-down
          position: [cx, cy - camDist * 0.4, camDist * 0.9],
          up: [0, 1, 0],
          fov: 45,
          near: 0.1,
          far: maxDim * 20,
        }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#0d1117']} />

        <ambientLight intensity={0.6} />
        <directionalLight
          position={[cx + maxDim, cy + maxDim, maxDim * 1.5]}
          intensity={1.2}
        />
        <directionalLight
          position={[cx - maxDim, cy - maxDim * 0.5, maxDim]}
          intensity={0.4}
        />

        <Suspense fallback={null}>
          <FrSubstrate cx={cx} cy={cy} width={boardWidth} height={boardHeight} />
          <SceneGrid    cx={cx} cy={cy} boardWidth={boardWidth} boardHeight={boardHeight} />
          <OriginMarker maxDim={maxDim} />
        </Suspense>

        <OrbitControls
          makeDefault
          target={[cx, cy, 0]}
          minDistance={maxDim * 0.2}
          maxDistance={maxDim * 5}
        />

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

// ─── FR4 substrate ───────────────────────────────────────────────────────────

function FrSubstrate({
  cx, cy, width, height,
}: {
  cx: number; cy: number; width: number; height: number;
}) {
  const edgesGeo = useMemo(() => {
    const box = new THREE.BoxGeometry(width, height, FR4_THICKNESS);
    return new THREE.EdgesGeometry(box);
  }, [width, height]);

  return (
    <group position={[cx, cy, 0]}>
      <mesh>
        {/* width × height in XY plane, FR4_THICKNESS along Z */}
        <boxGeometry args={[width, height, FR4_THICKNESS]} />
        <meshStandardMaterial color={FR4_GREEN} roughness={0.7} metalness={0} />
      </mesh>
      <lineSegments geometry={edgesGeo}>
        <lineBasicMaterial color={FR4_EDGE} />
      </lineSegments>
    </group>
  );
}

// ─── Reference grid ──────────────────────────────────────────────────────────

function SceneGrid({
  cx, cy, boardWidth, boardHeight,
}: {
  cx: number; cy: number; boardWidth: number; boardHeight: number;
}) {
  const span = Math.max(boardWidth, boardHeight) * 4;
  // drei Grid lies in the XZ plane by default; rotate +90° around X to put it in XY
  const zPos = -FR4_THICKNESS / 2 - 0.01;

  return (
    <Grid
      position={[cx, cy, zPos]}
      rotation={[Math.PI / 2, 0, 0]}
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

// ─── Origin marker ───────────────────────────────────────────────────────────

function OriginMarker({ maxDim }: { maxDim: number }) {
  const arm = Math.max(2, maxDim * 0.06);
  const dot = arm * 0.12;
  const z   = -FR4_THICKNESS / 2 - 0.05; // sit on the work-surface plane

  return (
    <group position={[0, 0, z]}>
      {/* +X arm — red (Gerber X) */}
      <Line points={[[0, 0, 0], [arm, 0, 0]]} color="#f87171" lineWidth={2} />
      {/* +Y arm — green (Gerber Y, now truly upward in scene) */}
      <Line points={[[0, 0, 0], [0, arm, 0]]} color="#4ade80" lineWidth={2} />
      <mesh>
        <sphereGeometry args={[dot, 12, 12]} />
        <meshBasicMaterial color="white" />
      </mesh>
      <Html position={[arm * 0.35, arm * 0.35, dot * 2]} center>
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
