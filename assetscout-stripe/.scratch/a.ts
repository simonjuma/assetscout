export class E extends Error {
  readonly variables: string[];
  constructor(d: string, v: string[] = []) { super(d); this.name = "E"; this.variables = v; }
}
