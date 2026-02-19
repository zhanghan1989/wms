import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{
      status: (code: number) => { json: (body: Record<string, unknown>) => void };
    }>();
    const request = ctx.getRequest<{ requestId?: string }>();

    const isHttpException = exception instanceof HttpException;
    const isPrismaKnown = exception instanceof Prisma.PrismaClientKnownRequestError;
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = isHttpException
      ? this.localizeMessage(this.extractHttpMessage(exception))
      : isPrismaKnown
        ? this.extractPrismaMessage(exception)
        : '服务器内部错误';

    if (!isHttpException) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(`[${request.requestId ?? 'no-request-id'}] ${message}`, stack);
    }

    response.status(status).json({
      code: status,
      message,
      data: null,
      requestId: request.requestId ?? null,
      timestamp: new Date().toISOString(),
    });
  }

  private extractHttpMessage(exception: HttpException): string {
    const exceptionResponse = exception.getResponse();
    if (typeof exceptionResponse === 'string') {
      return exceptionResponse;
    }
    if (
      typeof exceptionResponse === 'object' &&
      exceptionResponse !== null &&
      'message' in exceptionResponse
    ) {
      const message = (exceptionResponse as { message: string | string[] }).message;
      if (Array.isArray(message)) {
        return message.join('; ');
      }
      return message;
    }
    return exception.message;
  }

  private extractPrismaMessage(exception: Prisma.PrismaClientKnownRequestError): string {
    if (exception.code === 'P2021' || exception.code === 'P2022') {
      return '数据库结构未更新，请先执行 prisma migrate deploy。';
    }
    return '数据库错误';
  }

  private localizeMessage(message: string): string {
    const exactMap: Record<string, string> = {
      Unauthorized: '未授权，请重新登录',
      Forbidden: '无权限执行该操作',
      'Forbidden resource': '无权限执行该操作',
      'Internal Server Error': '服务器内部错误',
      'Validation failed (numeric string is expected)': '参数格式错误',
      'Failed to fetch': '网络请求失败，请检查网络连接',
    };
    if (exactMap[message]) {
      return exactMap[message];
    }

    let localized = message;
    localized = localized.replace(
      /^(.+)\s+must be a valid integer id$/i,
      (_, field) => `${field}必须是有效的整数ID`,
    );
    localized = localized.replace(
      /^(.+)\s+should not be empty$/i,
      (_, field) => `${field}不能为空`,
    );
    localized = localized.replace(
      /^(.+)\s+must be a string$/i,
      (_, field) => `${field}必须是字符串`,
    );
    localized = localized.replace(
      /^(.+)\s+must be an integer number$/i,
      (_, field) => `${field}必须是整数`,
    );
    localized = localized.replace(
      /^(.+)\s+must not be less than\s+(-?\d+)$/i,
      (_, field, min) => `${field}不能小于${min}`,
    );
    localized = localized.replace(
      /^(.+)\s+must not be greater than\s+(-?\d+)$/i,
      (_, field, max) => `${field}不能大于${max}`,
    );
    localized = localized.replace(
      /^(.+)\s+must match\s+(.+)\s+regular expression$/i,
      (_, field) => `${field}格式不正确`,
    );
    localized = localized.replace(
      /^box code is locked by batch inbound order\s+(.+),\s*please confirm or delete that order first$/i,
      (_, orderNo) => `箱号已被批量入库单 ${orderNo} 锁定，请先确认或删除该单据`,
    );
    localized = localized.replace(/^HTTP\s+(\d{3})$/i, (_, code) => `请求失败（HTTP ${code}）`);

    return localized;
  }
}
