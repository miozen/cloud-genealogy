import { describe, expect, it } from "vitest";
import { chartViewBox, createChartViewport, panChartViewport } from "../src/chart-viewport";

describe("chart viewport", () => {
  const bounds = { width: 1000, height: 600 };

  it("centers a zoomed viewport on a selected node without leaving the chart", () => {
    expect(createChartViewport(bounds, 2, { x: 800, y: 500 })).toEqual({ x: 500, y: 300, width: 500, height: 300 });
    expect(createChartViewport(bounds, 2, { x: 10, y: 10 })).toMatchObject({ x: 0, y: 0 });
  });

  it("clamps dragging and formats a stable SVG viewBox", () => {
    const viewport = createChartViewport(bounds, 2);
    const panned = panChartViewport(bounds, viewport, 900, 900);
    expect(panned).toEqual({ x: 500, y: 300, width: 500, height: 300 });
    expect(chartViewBox(panned)).toBe("500 300 500 300");
  });
});
