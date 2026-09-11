export class KernelInvariantError extends Error {
  constructor(
    readonly invariant: number,
    message: string,
    readonly detail?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = 'KernelInvariantError';
    Object.setPrototypeOf(this, new.target.prototype);
    if (detail !== undefined) this.detail = Object.freeze({ ...detail });
  }
}

export class KernelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KernelConfigError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
