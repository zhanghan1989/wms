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
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = isHttpException
      ? this.extractHttpMessage(exception)
      : isPrismaKnown
        ? this.extractPrismaMessage(exception)
        : 'Internal Server Error';

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
      return 'Database schema is outdated. Please run prisma migrate deploy.';
    }
    return 'Database error';
  }
}
