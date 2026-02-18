import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{
      status: (code: number) => { json: (body: Record<string, unknown>) => void };
    }>();
    const request = ctx.getRequest<{ requestId?: string }>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = isHttpException
      ? this.extractHttpMessage(exception)
      : 'Internal Server Error';

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
}
