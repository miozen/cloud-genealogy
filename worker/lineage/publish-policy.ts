/** Direct revision writes exist only for isolated local fixtures and demos. */
export function allowsDirectRevisionWrite(appEnv: string | undefined): boolean {
  return appEnv === "development";
}
