import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { isObservable, lastValueFrom } from 'rxjs';
import { AuthUser } from '../common/types/auth-user.type';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const result = super.canActivate(context);
    const authenticated = isObservable(result) ? await lastValueFrom(result) : await result;
    if (!authenticated) return false;
    const request = context.switchToHttp().getRequest<{
      originalUrl?: string;
      url?: string;
      user?: AuthUser;
    }>();
    const path = String(request.originalUrl ?? request.url ?? '').split('?')[0];
    const mfaAllowed = new Set([
      '/api/auth/me',
      '/api/auth/logout',
      '/api/auth/me/password',
      '/api/auth/me/mfa/setup',
      '/api/auth/me/mfa/enable',
    ]);
    if (request.user?.mfaPending && !mfaAllowed.has(path)) {
      throw new ForbiddenException('必须先完成MFA设置');
    }
    const passwordAllowed = new Set([
      '/api/auth/me',
      '/api/auth/logout',
      '/api/auth/me/password',
    ]);
    if (request.user?.passwordChangeRequired && !passwordAllowed.has(path)) {
      throw new ForbiddenException('密码已过期，必须先修改密码');
    }
    return true;
  }
}
