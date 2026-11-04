import { Role } from '@prisma/client';

export interface AuthUser {
  id: bigint;
  username: string;
  role: Role;
  companyId?: bigint;
  department?: string;
  sessionId?: string;
}
