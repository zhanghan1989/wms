import { Role } from '@prisma/client';

export interface AuthUser {
  id: bigint;
  username: string;
  role: Role;
}
