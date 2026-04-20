import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

@Injectable()
export class PrintAgentApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const configuredApiKey = String(process.env.PRINT_AGENT_API_KEY ?? '').trim();
    if (!configuredApiKey) {
      throw new ServiceUnavailableException('未配置打印代理接口密钥');
    }

    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      query?: Record<string, string | string[] | undefined>;
    }>();
    const headerValue = request.headers?.['x-print-agent-key'] ?? request.headers?.authorization;
    const queryValue = request.query?.apiKey;
    const providedRaw = Array.isArray(headerValue)
      ? headerValue[0]
      : Array.isArray(queryValue)
        ? queryValue[0]
        : headerValue ?? queryValue;
    const providedApiKey = String(providedRaw ?? '')
      .replace(/^Bearer\s+/i, '')
      .trim();

    if (providedApiKey !== configuredApiKey) {
      throw new UnauthorizedException('打印代理接口密钥无效');
    }

    return true;
  }
}
