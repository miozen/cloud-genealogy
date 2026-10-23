export interface ChartBounds {
  width: number;
  height: number;
}

export interface ChartPoint {
  x: number;
  y: number;
}

export interface ChartViewport extends ChartPoint {
  width: number;
  height: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/** Produces a bounded viewport, optionally centered on a selected chart node. */
export function createChartViewport(bounds: ChartBounds, zoom: number, focus?: ChartPoint): ChartViewport {
  const width = bounds.width / zoom;
  const height = bounds.height / zoom;
  return {
    width,
    height,
    x: focus ? clamp(focus.x - width / 2, 0, Math.max(0, bounds.width - width)) : 0,
    y: focus ? clamp(focus.y - height / 2, 0, Math.max(0, bounds.height - height)) : 0,
  };
}

/** Keeps pointer-drag movement inside the complete chart bounds. */
export function panChartViewport(bounds: ChartBounds, viewport: ChartViewport, deltaX: number, deltaY: number): ChartViewport {
  return {
    ...viewport,
    x: clamp(viewport.x + deltaX, 0, Math.max(0, bounds.width - viewport.width)),
    y: clamp(viewport.y + deltaY, 0, Math.max(0, bounds.height - viewport.height)),
  };
}

export function chartViewBox(viewport: ChartViewport): string {
  return `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`;
}
