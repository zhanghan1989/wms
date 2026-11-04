import { Role } from '@prisma/client';

export interface AuthUser {
  id: bigint;
  username: string;
  role: Role;
  companyId?: bigint | null;
  department?: string;
  sessionId?: string;
}
