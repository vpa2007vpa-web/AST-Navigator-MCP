import { randomUUID } from "node:crypto";
import type { CreateUserInput, User } from "../models/user.js";
import { Repository } from "../db/Repository.js";

export interface UserServiceOptions {
  readonly cacheTtlMs: number;
}

/** In-memory user service used by the end-to-end tests. */
export class UserService extends Repository<User> implements Disposable {
  private readonly cache = new Map<string, User>();
  static instances = 0;

  constructor(private readonly options: UserServiceOptions) {
    super("users");
    UserService.instances += 1;
  }

  async create(input: CreateUserInput): Promise<User> {
    const user: User = { id: randomUUID(), ...input };
    this.cache.set(user.id, user);
    return user;
  }

  findById(id: string): User | undefined {
    return this.cache.get(id);
  }

  get size(): number {
    return this.cache.size;
  }

  [Symbol.dispose](): void {
    this.cache.clear();
  }
}

export function createUserService(
  options: UserServiceOptions,
): UserService {
  return new UserService(options);
}
