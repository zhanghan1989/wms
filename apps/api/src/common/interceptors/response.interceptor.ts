import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

function serializeBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeBigInt(item));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
      result[key] = serializeBigInt(item);
    });
    return result;
  }
  return value;
}

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ requestId?: string }>();
    return next.handle().pipe(
      map((data) => ({
        code: 0,
        message: 'OK',
        data: serializeBigInt(data),
        requestId: request.requestId ?? null,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
