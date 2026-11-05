import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from '../common/types/auth-user.type';

@Injectable()
export class AmazonConnectionAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user) return false;
    return user.role === Role.system_admin || user.role === Role.admin
      || (user.role === Role.employee && !!user.companyId && user.department !== 'overseas_warehouse');
  }
}
