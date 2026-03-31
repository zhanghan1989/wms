import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

@Injectable()
export class ThirdPartyApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const configuredApiKey = String(process.env.THIRD_PARTY_API_KEY ?? '').trim();
    if (!configuredApiKey) {
      throw new ServiceUnavailableException('未配置第三方接口密钥');
    }

    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      query?: Record<string, string | string[] | undefined>;
    }>();
    const headerValue = request.headers?.['x-api-key'];
    const queryValue = request.query?.apiKey;
    const providedApiKey = Array.isArray(headerValue)
      ? headerValue[0]
      : Array.isArray(queryValue)
        ? queryValue[0]
        : headerValue ?? queryValue;

    if (String(providedApiKey ?? '').trim() !== configuredApiKey) {
      throw new UnauthorizedException('第三方接口密钥无效');
    }

    return true;
  }
}
