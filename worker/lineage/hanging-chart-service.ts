import { expandHangingChart, layoutHangingChart, type HangingChartLayout } from "./hanging-chart-layout";
import { projectHangingChart, type HangingChartProjection } from "./hanging-chart-projection";

export interface PublishedHangingChartPerson {
  id: string;
  displayName: string;
}

export interface PublishedHangingChartEdge {
  parentPersonId: string;
  childPersonId: string;
  orderKey: string;
}

/**
 * Builds a read model for the SVG layer from an already-authorized published
 * revision. It deliberately accepts no D1 binding so projection and layout
 * remain independent from persistence and from Vue's DOM.
 */
export function buildPublishedHangingChart(
  people: readonly PublishedHangingChartPerson[],
  edges: readonly PublishedHangingChartEdge[],
  rootPersonId?: string,
): { projection: HangingChartProjection; layout: HangingChartLayout } {
  const projection = expandHangingChart(projectHangingChart(people, edges), rootPersonId);
  return { projection, layout: layoutHangingChart(projection) };
}
