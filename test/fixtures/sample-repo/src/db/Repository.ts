export abstract class Repository<T> {
  protected constructor(protected readonly table: string) {}

  abstract create(input: unknown): Promise<T>;

  describe(): string {
    return `Repository(${this.table})`;
  }
}
