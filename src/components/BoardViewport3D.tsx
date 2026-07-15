import { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls, GizmoHelper, GizmoViewport, Line, Html } from '@react-three/drei';
import * as THREE from 'three';
import type { Board3DModel, KPoint, OperationKind, PolyWithHoles } from '../kernel/types';

/**
 * Coordinate convention (matches standard CNC/CAM and Gerber board space):
 *   Gerber X  →  Three.js +X  (right)
 *   Gerber Y  →  Three.js +Y  (up on screen when viewed from above)
 *   Z                         (board normal — spindle travel direction)
 *
 * Kernel mm coordinates map to scene units 1:1 — no flip, no scaling.
 * The board's TOP face sits at z = 0; the substrate extends down to
 * z = -boardThickness. Top copper sits on z = 0, bottom copper hangs
 * below the substrate.
 */

const FR4_GREEN = '#1e5c1a';
const COPPER_GOLD = '#d4a017';
const FALLBACK_THICKNESS = 1.6;

const TOOLPATH_COLORS: Record<OperationKind, string> = {
  isolation: '#f0f',
  drill: '#22d3ee',
  cutout: '#4ade80',
  centering: '#79c0ff',
};

interface FallbackBounds {
  xMin: number;
  yMin: number;
  width: number;
  height: number;
}

interface Props {
  model: Board3DModel | null;
  fallbackBounds: FallbackBounds | null;
  /** Operation ids hidden via the op card eye toggles. */
  hiddenOpIds?: Set<string>;
}

export function BoardViewport3D({ model, fallbackBounds, hiddenOpIds }: Props) {
  const [showToolpaths, setShowToolpaths] = useState(true);
  const [showCopper, setShowCopper] = useState(true);

  const bounds = useMemo(() => modelBounds(model) ?? fallbackBounds, [model, fallbackBounds]);
  if (!bounds) return null;

  const { xMin, yMin, width, height } = bounds;
  const maxDim = Math.max(width, height, 1);
  const camDist = maxDim * 1.6;
  const cx = xMin + width / 2;
  const cy = yMin + height / 2;
  const thickness = model?.boardThicknessMm ?? FALLBACK_THICKNESS;
  const hasToolpaths = (model?.toolpaths.length ?? 0) > 0;

  return (
    <div className="relative w-full h-full rounded-xl overflow-hidden">
      <Canvas
        camera={{
          position: [cx, cy - camDist * 0.4, camDist * 0.9],
          up: [0, 1, 0],
          fov: 45,
          // Keep far/near small — a huge ratio destroys depth-buffer
          // precision at distance and coplanar faces start to z-fight.
          near: maxDim * 0.02,
          far: maxDim * 12,
        }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#0d1117']} />

        <ambientLight intensity={0.55} />
        <directionalLight position={[cx + maxDim, cy + maxDim, maxDim * 1.5]} intensity={1.2} />
        <directionalLight position={[cx - maxDim, cy - maxDim * 0.5, maxDim]} intensity={0.4} />
        <directionalLight position={[cx, cy, -maxDim * 1.5]} intensity={0.35} />

        <Suspense fallback={null}>
          {model ? (
            <>
              <BoardSolid model={model} />
              {showCopper && <CopperSolids model={model} />}
              {showToolpaths && <ToolpathLines model={model} hiddenOpIds={hiddenOpIds} />}
            </>
          ) : (
            <FallbackSlab cx={cx} cy={cy} width={width} height={height} thickness={thickness} />
          )}
          <SceneGrid cx={cx} cy={cy} span={maxDim * 4} z={-thickness - 0.01} />
          <OriginMarker maxDim={maxDim} z={-thickness - 0.05} />
        </Suspense>

        <OrbitControls
          makeDefault
          target={[cx, cy, -thickness / 2]}
          minDistance={maxDim * 0.2}
          maxDistance={maxDim * 5}
        />

        <GizmoHelper alignment="bottom-left" margin={[60, 60]}>
          <GizmoViewport axisColors={['#f87171', '#4ade80', '#60a5fa']} labelColor="white" />
        </GizmoHelper>
      </Canvas>

      {model && (
        <div className="absolute top-3 right-3 flex flex-col gap-1 bg-zinc-900/90 border border-zinc-700 rounded-lg px-2.5 py-1.5 backdrop-blur-sm">
          <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={showCopper}
              onChange={(e) => setShowCopper(e.target.checked)}
              className="accent-amber-400"
            />
            Copper
          </label>
          {hasToolpaths && (
            <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={showToolpaths}
                onChange={(e) => setShowToolpaths(e.target.checked)}
                className="accent-fuchsia-400"
              />
              Toolpaths
            </label>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Geometry construction ───────────────────────────────────────────────────

function signedArea(ring: KPoint[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** PolyWithHoles → THREE.Shape with normalized winding (outer CCW, holes CW). */
function polyToShape(poly: PolyWithHoles): THREE.Shape | null {
  if (poly.outer.length < 3) return null;
  const outer = signedArea(poly.outer) < 0 ? [...poly.outer].reverse() : poly.outer;
  const shape = new THREE.Shape(outer.map((p) => new THREE.Vector2(p.x, p.y)));
  for (const holeRing of poly.holes) {
    if (holeRing.length < 3) continue;
    const hole = signedArea(holeRing) > 0 ? [...holeRing].reverse() : holeRing;
    shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p.x, p.y))));
  }
  return shape;
}

function extrudeGeometry(polys: PolyWithHoles[], depth: number): THREE.ExtrudeGeometry | null {
  const shapes: THREE.Shape[] = [];
  for (const poly of polys) {
    try {
      const shape = polyToShape(poly);
      if (shape) shapes.push(shape);
    } catch {
      // one degenerate polygon must not blank the whole scene
    }
  }
  if (shapes.length === 0) return null;
  try {
    return new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false });
  } catch {
    return null;
  }
}

function useDisposable<T extends THREE.BufferGeometry | null>(geometry: T): T {
  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);
  return geometry;
}

function modelBounds(model: Board3DModel | null): FallbackBounds | null {
  if (!model) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (polys: PolyWithHoles[]) => {
    for (const poly of polys) {
      for (const p of poly.outer) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
  };
  visit(model.boardOutline);
  for (const copper of model.copper) visit(copper.polys);
  if (!Number.isFinite(minX)) return null;
  return { xMin: minX, yMin: minY, width: Math.max(maxX - minX, 1e-3), height: Math.max(maxY - minY, 1e-3) };
}

// ─── Scene pieces ────────────────────────────────────────────────────────────

/** FR4 substrate extruded from the real board outline, drill holes included. */
function BoardSolid({ model }: { model: Board3DModel }) {
  const geometry = useDisposable(
    useMemo(
      () => extrudeGeometry(model.boardOutline, model.boardThicknessMm),
      [model],
    ),
  );
  if (!geometry) return null;
  return (
    <mesh geometry={geometry} position={[0, 0, -model.boardThicknessMm]}>
      {/* The clad's bottom face is coplanar with this substrate's top face;
          polygonOffset pushes the FR4 back in the depth buffer so the copper
          always wins instead of z-fighting (green flicker when zoomed out). */}
      <meshStandardMaterial
        color={FR4_GREEN}
        roughness={0.75}
        metalness={0.05}
        side={THREE.DoubleSide}
        polygonOffset
        polygonOffsetFactor={1}
        polygonOffsetUnits={1}
      />
    </mesh>
  );
}

/** Copper layers with drill holes and isolation channels already subtracted. */
function CopperSolids({ model }: { model: Board3DModel }) {
  return (
    <>
      {model.copper.map((layer) => (
        <CopperLayer key={layer.layerId} model={model} polys={layer.polys} side={layer.side} />
      ))}
    </>
  );
}

function CopperLayer({
  model,
  polys,
  side,
}: {
  model: Board3DModel;
  polys: PolyWithHoles[];
  side: 'top' | 'bottom';
}) {
  const geometry = useDisposable(
    useMemo(() => extrudeGeometry(polys, model.copperThicknessMm), [polys, model.copperThicknessMm]),
  );
  if (!geometry) return null;
  const z = side === 'top' ? 0 : -model.boardThicknessMm - model.copperThicknessMm;
  return (
    <mesh geometry={geometry} position={[0, 0, z]}>
      <meshStandardMaterial color={COPPER_GOLD} roughness={0.35} metalness={0.8} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** Toolpath centerline overlay, hovering just off its side's copper face. */
function ToolpathLines({
  model,
  hiddenOpIds,
}: {
  model: Board3DModel;
  hiddenOpIds?: Set<string>;
}) {
  const zTop = model.copperThicknessMm + 0.15;
  const zBottom = -model.boardThicknessMm - model.copperThicknessMm - 0.15;
  const toolpaths = hiddenOpIds
    ? model.toolpaths.filter((tp) => !hiddenOpIds.has(tp.opId))
    : model.toolpaths;
  return (
    <>
      {toolpaths.map((tp) => {
        const z = tp.side === 'bottom' ? zBottom : zTop;
        return tp.polylines
          .filter((line) => line.length >= 2)
          .map((line, i) => (
            <Line
              key={`${tp.opId}:${i}`}
              points={line.map((p) => [p.x, p.y, z] as [number, number, number])}
              color={TOOLPATH_COLORS[tp.kind] ?? '#fff'}
              lineWidth={1.5}
              transparent
              opacity={0.85}
            />
          ));
      })}
    </>
  );
}

/** Pre-kernel placeholder: a plain slab from the union bounding box. */
function FallbackSlab({
  cx,
  cy,
  width,
  height,
  thickness,
}: {
  cx: number;
  cy: number;
  width: number;
  height: number;
  thickness: number;
}) {
  return (
    <mesh position={[cx, cy, -thickness / 2]}>
      <boxGeometry args={[width, height, thickness]} />
      <meshStandardMaterial color={FR4_GREEN} roughness={0.7} metalness={0} />
    </mesh>
  );
}

function SceneGrid({ cx, cy, span, z }: { cx: number; cy: number; span: number; z: number }) {
  return (
    <Grid
      position={[cx, cy, z]}
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

function OriginMarker({ maxDim, z }: { maxDim: number; z: number }) {
  const arm = Math.max(2, maxDim * 0.06);
  const dot = arm * 0.12;

  return (
    <group position={[0, 0, z]}>
      <Line points={[[0, 0, 0], [arm, 0, 0]]} color="#f87171" lineWidth={2} />
      <Line points={[[0, 0, 0], [0, arm, 0]]} color="#4ade80" lineWidth={2} />
      <mesh>
        <sphereGeometry args={[dot, 12, 12]} />
        <meshBasicMaterial color="white" />
      </mesh>
      <Html position={[arm * 0.35, arm * 0.35, dot * 2]} center>
        <span
          style={{
            color: '#94a3b8',
            fontSize: '11px',
            fontFamily: 'monospace',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            textShadow: '0 1px 3px #000, 0 0 6px #000',
          }}
        >
          (0, 0)
        </span>
      </Html>
    </group>
  );
}
